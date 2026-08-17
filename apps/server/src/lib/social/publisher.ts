/**
 * Publishing the indexer's working, so the count outlives the indexer (#312).
 *
 * `SWARM_SOCIAL_PLAN` P1.5. Until now a manifest was computed on request and
 * served over HTTP, which made two things untrue that the plan says out loud:
 * the count was unavailable whenever we were, and the participant registry —
 * the input set a third party would need to rebuild the index — existed only on
 * our disk. A report written to a subject-keyed feed the indexer owns fixes
 * both, and the address is computable by anyone, so reading it needs no API.
 *
 * WHAT TRIGGERS A PUBLISH, and why not the obvious thing. A tally is triggered
 * today by an unauthenticated GET carrying a caller-supplied subject. Hanging
 * publication off that path would let an arbitrary caller decide when we spend
 * postage — the same cost inversion that moved bulk participant restore to the
 * operator surface (`routes/social.ts`). So reads never write. The WRITE path
 * marks a subject dirty (`observeStatementBytes` — we already parse the bytes
 * there), and a timer drains the dirty set with a ceiling per pass.
 *
 * A restart loses the dirty set, deliberately: it is a queue, not a record, and
 * a `.data` store that must survive restarts is a liability with a long list of
 * precedents. The slow sweep over `knownSubjects()` heals the gap instead — a
 * restart costs freshness of the published COPY for a few hours, never the
 * count itself, which is still computed on demand.
 *
 * IDENTICAL REPORTS ARE NOT REPUBLISHED. A version is not free twice over: it
 * costs postage now and costs every future reader a probe step forever. So the
 * comparison ignores `publishedAt` — the whole point of the wrapper's
 * determinism split — and a pass that finds nothing new writes nothing.
 */

import {
  SOCIAL_INDEXER_ADDRESS,
  evidenceReport,
  evidenceReportTopic,
  type BooleanEvidenceLeaf,
  type CarriedEvidenceLeaf,
  type EvidenceManifestV1,
  type Hex0x,
} from "@woco/shared";
import {
  BEE_URL,
  getSocialIndexerOwnerHex,
  getSocialIndexerSigner,
  requirePostageBatch,
  socialIndexerConfigured,
} from "../../config/swarm.js";
import {
  confirmContentFeedWrite,
  writeVersionedContentFeed,
  type ContentFeedWrite,
} from "../swarm/content-feed-write.js";
import { INDEXABLE_FORMATS, indexSubject, type IndexableFormat, type IndexResult } from "./indexer.js";
import { knownSubjects, setStatementObserver } from "./participants.js";

/**
 * How often the dirty set is drained, and how many subjects one pass may
 * publish. These are POSTAGE SPEND POLICY, not tuning: together they cap how
 * many versions a busy day can add, and a version is also a probe step for
 * every cold reader (`resolveLatestSocVersion` walks forward). Env-settable so
 * the numbers can move without a deploy of new code.
 */
const FLUSH_INTERVAL_MS = envInt("SOCIAL_PUBLISH_INTERVAL_MS", 5 * 60_000);
const MAX_SUBJECTS_PER_FLUSH = envInt("SOCIAL_PUBLISH_MAX_PER_FLUSH", 10);

/**
 * Anti-entropy. Everything the dirty set can lose — a restart, a failed pass
 * that ran out of retries, a subject restored from a manifest — is recovered by
 * walking the whole registry occasionally. Daily, because the cost of being a
 * day stale in the published copy is low and the cost of a sweep is real.
 */
const SWEEP_INTERVAL_MS = envInt("SOCIAL_PUBLISH_SWEEP_MS", 24 * 60 * 60_000);
/** First sweep shortly after boot, not AT boot: a crash-looping container must
 *  not turn into a republish loop, and the node needs its peers warm anyway. */
const BOOT_SWEEP_DELAY_MS = envInt("SOCIAL_PUBLISH_BOOT_DELAY_MS", 10 * 60_000);

/**
 * Below this, publishing stops. A batch with no time left still accepts
 * uploads — a bee behind on the postage contract returns 201 for chunks nobody
 * has paid for (2026-08-10) — so the floor is what turns "writing into a void"
 * into a visible refusal. It is deliberately short: refusing early would stop
 * the durability layer over a batch a top-up would have fixed.
 */
const MIN_BATCH_TTL_SECONDS = envInt("SOCIAL_PUBLISH_MIN_BATCH_TTL", 3600);

/**
 * How many passes in a row a subject may fail before it is dropped from the
 * queue until the next sweep.
 *
 * A retry that can never succeed is not free. The one shape that would loop is
 * a head read answering "absent" for a chunk that IS there: the publisher
 * writes the same version again, bee discards it as a duplicate address while
 * returning success, the read-back sees the older payload and disagrees — and
 * that repeats every pass, paying postage each time. Retrying is still right
 * (an unreachable bee recovers), so the bound is on repetition rather than on
 * retrying at all, and `stuck` in /api/health names what was set down.
 */
const MAX_CONSECUTIVE_FAILURES = envInt("SOCIAL_PUBLISH_MAX_FAILURES", 5);
/** Batch health is asked for at most this often — it changes on a chain clock. */
const BATCH_PROBE_TTL_MS = 5 * 60_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

type Job = { format: IndexableFormat; subject: string };

const dirty = new Map<string, Job>();
/**
 * The version last written per (format, subject), so a reader can be told where
 * to start looking. A cold client otherwise probes forward from 0, and a probe
 * for a version that does not exist is the most expensive read Swarm performs.
 *
 * Lost on restart, and that is fine: the hint is a lower bound, so an absent or
 * stale-low one costs a few reads and never a wrong answer.
 */
const lastPublished = new Map<string, number>();
/** Consecutive failed passes per subject — see MAX_CONSECUTIVE_FAILURES. */
const failures = new Map<string, number>();
let flushing = false;
let flushTimer: ReturnType<typeof setInterval> | undefined;
let sweepTimer: ReturnType<typeof setInterval> | undefined;
let bootTimer: ReturnType<typeof setTimeout> | undefined;

const health = {
  configured: false,
  lastPublishedAt: null as string | null,
  lastFlushAt: null as string | null,
  published: 0,
  unchanged: 0,
  failed: 0,
  /**
   * Lifetime count of subjects set down after repeated failure, NOT a live
   * gauge — the sweep re-queues them and this never decrements. Named for what
   * it is, because "stuck: 3" read as a current backlog would send someone
   * looking for three broken subjects that recovered hours ago.
   */
  stuckTotal: 0,
  lastError: null as string | null,
  lastSkipReason: null as string | null,
  batchUsable: null as boolean | null,
  batchTTL: null as number | null,
};

function key(format: string, subject: string): string {
  return `${format}|${subject}`;
}

/**
 * Note that a subject's tally may have changed.
 *
 * Called for every public statement the relay stamps — INCLUDING one from a
 * participant already in the registry, which is why the hook sits before that
 * early return in `participants.ts`. An unlike, a re-follow and a new lap all
 * come from known participants and all change the number; a dirty mark that
 * only fired for first-time writers would publish a subject once and then never
 * again while it was actually moving.
 */
export function markSubjectDirty(format: string, subject: string): void {
  if (!socialIndexerConfigured()) return;
  if (!INDEXABLE_FORMATS.includes(format as IndexableFormat)) return;
  const s = subject.toLowerCase();
  dirty.set(key(format, s), { format: format as IndexableFormat, subject: s });
}

/** Batch state, cached — `usable` and a TTL, or nulls when the node cannot say. */
let batchProbe: { at: number; usable: boolean | null; ttl: number | null } = { at: 0, usable: null, ttl: null };

async function batchState(): Promise<{ usable: boolean | null; ttl: number | null }> {
  if (Date.now() - batchProbe.at < BATCH_PROBE_TTL_MS) return batchProbe;
  let usable: boolean | null = null;
  let ttl: number | null = null;
  try {
    const res = await fetch(`${BEE_URL}/stamps/${requirePostageBatch()}`, { signal: AbortSignal.timeout(5000) });
    if (res.ok && (res.headers.get("content-type") ?? "").includes("application/json")) {
      const b = (await res.json()) as Record<string, unknown>;
      usable = typeof b.usable === "boolean" ? b.usable : null;
      ttl = typeof b.batchTTL === "number" ? b.batchTTL : null;
    }
  } catch {
    // The stamps API is not exposed on every endpoint BEE_URL can point at, and
    // a probe failure is not evidence of a dead batch. Unknown, not unusable.
  }
  batchProbe = { at: Date.now(), usable, ttl };
  health.batchUsable = usable;
  health.batchTTL = ttl;
  return batchProbe;
}

/**
 * Everything about a report except when it was published — the part that must
 * be identical for a republish to be pointless.
 *
 * `publishedAt` is excluded on purpose: including it would make every pass
 * "changed" and turn the flush timer into a postage meter. Key order is stable
 * because both sides are built by the same code.
 */
function comparable(manifest: EvidenceManifestV1<unknown>, unreadable: string[], equivocations: string[]): string {
  return JSON.stringify({ manifest, unreadable, equivocations });
}

function headComparable(bytes: Uint8Array): string | null {
  try {
    const o = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (!o || typeof o !== "object" || !o.manifest) return null;
    return JSON.stringify({
      manifest: o.manifest,
      unreadable: o.unreadable ?? [],
      equivocations: o.equivocations ?? [],
    });
  } catch {
    return null; // unreadable head — treat as "different", so we republish
  }
}

/**
 * Everything this module does to the outside world, in one injectable place.
 *
 * Same reason `indexSubject` injects its feed reader: the behaviour worth
 * pinning here is what happens when things FAIL — a dead batch, a write that
 * reports success and is not there, a tally that throws mid-pass — and none of
 * those can be produced on demand against a live bee. The live implementation
 * is built lazily so a deployment without an indexer key never touches one.
 */
export interface PublisherDeps {
  tally: (format: IndexableFormat, subject: Hex0x) => Promise<IndexResult>;
  writeFeed: (
    topic: string,
    bytes: Uint8Array,
    unchanged: (head: Uint8Array) => boolean,
  ) => Promise<ContentFeedWrite>;
  confirmWrite: (topic: string, bytes: Uint8Array, version: number) => Promise<{ ok: true } | { ok: false; reason: string }>;
  batchState: () => Promise<{ usable: boolean | null; ttl: number | null }>;
  now: () => number;
}

function liveDeps(): PublisherDeps {
  return {
    tally: (format, subject) => indexSubject(format, subject),
    writeFeed: (topic, bytes, unchanged) =>
      writeVersionedContentFeed({
        signer: getSocialIndexerSigner(),
        topic,
        bytes,
        batchId: requirePostageBatch(),
        unchanged,
      }),
    confirmWrite: (topic, bytes, version) =>
      confirmContentFeedWrite(getSocialIndexerOwnerHex(), topic, bytes, version),
    batchState,
    now: () => Date.now(),
  };
}

/**
 * Tally one subject and publish the result, unless it says nothing new.
 *
 * Returns a reason when the subject should stay dirty, and `null` when it is
 * done with — including the two honest do-nothings: a subject with no
 * participants, and a report identical to the one already published. The reason
 * is returned rather than written to `health` so the PASS decides what the last
 * error was; a later success in the same pass must not erase an earlier failure.
 */
async function publishSubject(job: Job, deps: PublisherDeps): Promise<string | null> {
  const result = await deps.tally(job.format, job.subject as Hex0x);

  // Never publish a manifest over nobody. The registry only grows, so an empty
  // participant list means "never seen", and a signed report saying count 0
  // would be a durable claim about a subject that was merely never tallied.
  if (result.manifest.participants.length === 0) return null;

  const next = comparable(result.manifest, result.unreadable, result.equivocations);
  const topic = evidenceReportTopic(job.format, job.subject as Hex0x);

  // Explicit union: a tally is one family or the other, and the report is
  // agnostic — it carries whichever leaves the manifest already holds.
  const report = evidenceReport<BooleanEvidenceLeaf | CarriedEvidenceLeaf>({
    manifest: result.manifest,
    unreadable: result.unreadable,
    equivocations: result.equivocations,
    publishedAt: deps.now(),
  });
  const bytes = new TextEncoder().encode(JSON.stringify(report));

  const write = await deps.writeFeed(topic, bytes, (head) => headComparable(head) === next);

  if (!write.ok) return write.reason;
  if (write.unchanged) {
    health.unchanged++;
    return null;
  }

  const confirmed = await deps.confirmWrite(topic, bytes, write.version);
  if (!confirmed.ok) {
    // The upload reported success and the chunk is not there. Keep the subject
    // dirty and say so loudly: this is the shape a dead batch takes.
    console.error(`[social-publish] read-back failed for ${job.format} ${job.subject}: ${confirmed.reason}`);
    return confirmed.reason;
  }

  health.published++;
  health.lastPublishedAt = new Date(deps.now()).toISOString();
  lastPublished.set(key(job.format, job.subject), write.version);
  return null;
}

/**
 * Where to find the published report for a subject, for a client that would
 * rather read Swarm than trust this response.
 *
 * The owner and topic are derivable by anyone from public constants — they are
 * returned as a convenience, not as a permission. `version` is only present
 * when THIS process wrote it, and is a lower bound in any case.
 */
export function publishedHint(format: IndexableFormat, subject: string): {
  indexer: string;
  topic: string;
  version: number | null;
} | null {
  if (!socialIndexerConfigured()) return null;
  return {
    indexer: `0x${getSocialIndexerOwnerHex()}`,
    topic: evidenceReportTopic(format, subject.toLowerCase() as Hex0x),
    version: lastPublished.get(key(format, subject.toLowerCase())) ?? null,
  };
}

/** Put a failed subject back, unless it has failed too many passes running. */
function requeue(k: string, job: Job): void {
  const n = (failures.get(k) ?? 0) + 1;
  failures.set(k, n);
  if (n < MAX_CONSECUTIVE_FAILURES) {
    dirty.set(k, job);
    return;
  }
  // Set down, not forgotten: the sweep re-queues everything the registry knows
  // about, so this costs freshness until then rather than the subject.
  failures.delete(k);
  health.stuckTotal++;
  console.error(
    `[social-publish] ${job.format} ${job.subject} failed ${n} passes running — set down until the next sweep`,
  );
}

/**
 * Drain up to the ceiling from the dirty set. Exported for tests, which drive
 * it directly rather than waiting on the timer.
 */
export async function flushOnce(deps: PublisherDeps = liveDeps()): Promise<void> {
  if (flushing || !socialIndexerConfigured() || dirty.size === 0) return;
  flushing = true;
  try {
    const state = await deps.batchState();
    if (state.usable === false || (state.ttl !== null && state.ttl < MIN_BATCH_TTL_SECONDS)) {
      health.lastSkipReason = `postage batch unusable or expiring (usable=${state.usable}, ttl=${state.ttl})`;
      console.warn(`[social-publish] holding off: ${health.lastSkipReason}`);
      return;
    }
    health.lastSkipReason = null;

    // Reported per PASS, not per subject. A success must not erase a failure
    // from the same pass — the health endpoint would then show "fine" for a
    // publisher that is quietly failing on one subject every time — and a
    // failure must not outlive the pass that produced it once a later pass runs
    // clean, or the alarm never clears.
    let passError: string | null = null;
    const jobs = [...dirty.values()].slice(0, MAX_SUBJECTS_PER_FLUSH);
    for (const job of jobs) {
      // Removed before the attempt, re-added on failure: a statement arriving
      // mid-publish must re-dirty the subject rather than be swallowed by the
      // pass that was already running when it landed.
      const k = key(job.format, job.subject);
      dirty.delete(k);
      try {
        const failure = await publishSubject(job, deps);
        if (failure === null) {
          failures.delete(k);
        } else {
          health.failed++;
          passError = `${job.format} ${job.subject}: ${failure}`;
          requeue(k, job);
        }
      } catch (e) {
        health.failed++;
        passError = `${job.format} ${job.subject}: ${e instanceof Error ? e.message : String(e)}`;
        console.error(`[social-publish] ${job.format} ${job.subject} threw:`, e);
        requeue(k, job);
      }
    }
    health.lastError = passError;
    health.lastFlushAt = new Date(deps.now()).toISOString();
  } finally {
    flushing = false;
  }
}

/** Re-dirty every subject the registry knows about. Cheap: the work is bounded
 *  by the flush ceiling, and identical reports cost a tally, never a write. */
function sweep(): void {
  if (!socialIndexerConfigured()) return;
  let n = 0;
  for (const format of INDEXABLE_FORMATS) {
    for (const subject of knownSubjects(format)) {
      dirty.set(key(format, subject), { format, subject });
      n++;
    }
  }
  if (n > 0) console.log(`[social-publish] sweep queued ${n} subject(s)`);
}

/**
 * Wire the write path to the publisher and start the timers.
 *
 * Silently inert without `SOCIAL_INDEXER_PRIVATE_KEY` — a dev machine has no
 * business publishing reports signed as the indexer, and the tally is still
 * served on request, so nothing else changes.
 */
export function startEvidencePublisher(): void {
  health.configured = socialIndexerConfigured();
  if (!health.configured) {
    console.log("[social-publish] SOCIAL_INDEXER_PRIVATE_KEY unset — evidence reports are served, not published");
    return;
  }

  // The key and the address clients read must be the same identity, and nothing
  // else in the system would ever say otherwise. A mismatch publishes perfectly
  // valid reports at an address no browser looks at: /api/health counts them as
  // published, every reader gets "absent", and the failure looks like a Swarm
  // problem rather than a config one. Refusing is the only honest option —
  // publishing where nobody reads is worse than not publishing, because it also
  // spends postage and reports success.
  const owner = `0x${getSocialIndexerOwnerHex()}`;
  if (owner !== SOCIAL_INDEXER_ADDRESS.toLowerCase()) {
    health.configured = false;
    health.lastSkipReason = `key derives ${owner}, clients read ${SOCIAL_INDEXER_ADDRESS}`;
    console.error(
      `\n[social-publish] FATAL (feature off): SOCIAL_INDEXER_PRIVATE_KEY derives ${owner}, but clients read ` +
      `SOCIAL_INDEXER_ADDRESS ${SOCIAL_INDEXER_ADDRESS}.\nEither restore the matching key or update the shared ` +
      `constant. Publishing is disabled; reports are still served on request.\n`,
    );
    return;
  }

  if (flushTimer) return;

  setStatementObserver(markSubjectDirty);

  flushTimer = setInterval(() => void flushOnce(), FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
  sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  bootTimer = setTimeout(sweep, BOOT_SWEEP_DELAY_MS);
  bootTimer.unref?.();

  console.log(
    `[social-publish] publishing as ${getSocialIndexerOwnerHex()} ` +
    `every ${Math.round(FLUSH_INTERVAL_MS / 1000)}s, max ${MAX_SUBJECTS_PER_FLUSH} subject(s) per pass`,
  );
}

/**
 * Publisher liveness for `/api/health`. Addresses and counts only — this
 * endpoint is public, and everything here is already public on Swarm.
 *
 * `dirty` climbing while `lastPublishedAt` stands still is the alarm: reports
 * have stopped being written and the durability layer is quietly gone.
 */
export function evidencePublisherHealth(): Record<string, unknown> {
  return { ...health, dirty: dirty.size };
}

/** Test seam — drains timers, queue and counters without touching Swarm. */
export function __resetPublisher(): void {
  if (flushTimer) clearInterval(flushTimer);
  if (sweepTimer) clearInterval(sweepTimer);
  if (bootTimer) clearTimeout(bootTimer);
  flushTimer = sweepTimer = undefined;
  bootTimer = undefined;
  dirty.clear();
  lastPublished.clear();
  failures.clear();
  flushing = false;
  setStatementObserver(null);
  Object.assign(health, {
    lastPublishedAt: null,
    lastFlushAt: null,
    published: 0,
    unchanged: 0,
    failed: 0,
    stuckTotal: 0,
    lastError: null,
    lastSkipReason: null,
  });
  batchProbe = { at: 0, usable: null, ttl: null };
}
