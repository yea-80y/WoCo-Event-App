/**
 * The evidence publisher (`lib/social/publisher.ts`, #312).
 *
 * What a report SAYS is pinned in `packages/shared/test/statement/evidence-report.test.ts`.
 * What is pinned here is when one gets written at all, which is where both the
 * money and the honesty are:
 *
 *   - A report identical to the published one is NOT rewritten. Every version
 *     costs postage once and costs every future reader a probe step forever,
 *     and the payload carries a timestamp that differs on every pass — so a
 *     naive byte comparison would republish continuously and look correct.
 *   - A subject with no participants is never published. The registry only
 *     grows, so empty means never-seen, and a signed "count: 0" would be a
 *     durable claim about a subject nobody has tallied.
 *   - A write that fails, or reports success and cannot be read back, leaves
 *     the subject DIRTY. Read-back failure is the shape a dead batch takes: a
 *     bee behind on the postage contract returns 201 for chunks nobody paid
 *     for, so "the upload worked" is not evidence of anything.
 *   - An expiring batch stops publication rather than writing into a void.
 *   - One subject's failure does not end the pass.
 *
 * Everything that touches Swarm is injected (`PublisherDeps`), for the reason
 * the indexer injects its feed reader: these are all FAILURE properties, and a
 * live bee cannot be made to fail on demand.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex0x } from "@woco/shared";

// A key so the publisher considers itself configured, and a ceiling of 2 so the
// per-pass bound is testable in three subjects rather than eleven. Both must be
// set BEFORE the modules that read them at import time.
process.env.SOCIAL_INDEXER_PRIVATE_KEY = `0x${"11".repeat(32)}`;
process.env.SOCIAL_PUBLISH_MAX_PER_FLUSH = "2";
process.env.POSTAGE_BATCH_ID = `${"ab".repeat(32)}`;

// The participant registry writes `.data/` relative to cwd — chdir before any
// import pulls it in.
process.chdir(mkdtempSync(join(tmpdir(), "woco-publisher-")));

type Publisher = typeof import("../src/lib/social/publisher.js");
type Participants = typeof import("../src/lib/social/participants.js");
let pub: Publisher;
let participants: Participants;

const SUBJECT = `0x${"aa".repeat(32)}` as Hex0x;
const SUBJECT_2 = `0x${"bb".repeat(32)}` as Hex0x;
const SUBJECT_3 = `0x${"cc".repeat(32)}` as Hex0x;
const OWNER = `0x${"11".repeat(20)}` as Hex0x;
const FORMAT = "woco.like.v1";

/** A tally result with one participant and one statement. */
function tallyResult(subject: Hex0x, count = 1, statementFormat = FORMAT) {
  return {
    manifest: {
      format: "woco.evidence.v1" as const,
      statementFormat,
      subject,
      participants: [OWNER],
      leaves: [{ feedOwner: OWNER, version: 0, digest: `0x${"dd".repeat(32)}` as Hex0x, value: true }],
      count,
    },
    unreadable: [] as string[],
    equivocations: [] as string[],
  };
}

/** Records every write, and answers whatever the test told it to. */
function recorder(over: Partial<import("../src/lib/social/publisher.js").PublisherDeps> = {}) {
  const writes: { topic: string; bytes: Uint8Array }[] = [];
  // Per TOPIC, as the real feed is. One shared head would make a second
  // subject's first report look like a republish of the first subject's.
  const heads = new Map<string, Uint8Array>();
  let clock = 1_700_000_000_000;

  const deps: import("../src/lib/social/publisher.js").PublisherDeps = {
    tally: async (format, subject) => tallyResult(subject, 1, format) as never,
    writeFeed: async (topic, bytes, unchanged) => {
      // The real writer asks the caller about the CURRENT head; mirroring that
      // here is the only way the identical-skip rule is under test at all.
      const head = heads.get(topic);
      if (head !== undefined && unchanged(head)) return { ok: true, version: 0, unchanged: true };
      writes.push({ topic, bytes });
      heads.set(topic, bytes);
      return { ok: true, version: writes.length - 1, unchanged: false };
    },
    confirmWrite: async () => ({ ok: true }),
    batchState: async () => ({ usable: true, ttl: 86_400 }),
    // Advances every call, so a report published twice differs in publishedAt
    // and ONLY in publishedAt — exactly the case a byte comparison gets wrong.
    now: () => (clock += 60_000),
    ...over,
  };
  return { deps, writes };
}

before(async () => {
  pub = await import("../src/lib/social/publisher.js");
  participants = await import("../src/lib/social/participants.js");
});

beforeEach(() => {
  pub.__resetPublisher();
  participants.__resetParticipants();
});

test("a subject with a changed tally is published once", async () => {
  const { deps, writes } = recorder();
  pub.markSubjectDirty(FORMAT, SUBJECT);
  await pub.flushOnce(deps);

  assert.equal(writes.length, 1);
  const report = JSON.parse(new TextDecoder().decode(writes[0]!.bytes));
  assert.equal(report.format, "woco.evidence-report.v1");
  assert.equal(report.manifest.subject, SUBJECT);
  assert.equal(report.manifest.count, 1);
  assert.equal(pub.evidencePublisherHealth().dirty, 0);
});

test("an unchanged tally is NOT republished, though its timestamp moved", async () => {
  // The postage property. `publishedAt` differs on every pass by construction,
  // so a mutant comparing whole payloads would write a version every 5 minutes,
  // forever, per subject — and every one of those versions is also a probe step
  // for the next cold reader.
  const { deps, writes } = recorder();
  pub.markSubjectDirty(FORMAT, SUBJECT);
  await pub.flushOnce(deps);
  pub.markSubjectDirty(FORMAT, SUBJECT);
  await pub.flushOnce(deps);

  assert.equal(writes.length, 1);
  assert.equal(pub.evidencePublisherHealth().unchanged, 1);
});

test("a real change after an unchanged pass IS published", async () => {
  // The other half: the skip must be about the content, not about having
  // published before.
  let count = 1;
  const { deps, writes } = recorder({
    tally: async (format, subject) => tallyResult(subject, count, format) as never,
  });
  pub.markSubjectDirty(FORMAT, SUBJECT);
  await pub.flushOnce(deps);
  count = 2;
  pub.markSubjectDirty(FORMAT, SUBJECT);
  await pub.flushOnce(deps);

  assert.equal(writes.length, 2);
  assert.equal(JSON.parse(new TextDecoder().decode(writes[1]!.bytes)).manifest.count, 2);
});

test("a subject with no participants is never published", async () => {
  const { deps, writes } = recorder({
    tally: async (_f, subject) =>
      ({
        manifest: { format: "woco.evidence.v1", statementFormat: FORMAT, subject, participants: [], leaves: [], count: 0 },
        unreadable: [],
        equivocations: [],
      }) as never,
  });
  pub.markSubjectDirty(FORMAT, SUBJECT);
  await pub.flushOnce(deps);

  assert.equal(writes.length, 0);
  // Done with, not retried: there is nothing to publish, and it is not a fault.
  assert.equal(pub.evidencePublisherHealth().dirty, 0);
});

test("a refused write leaves the subject dirty", async () => {
  const { deps } = recorder({
    writeFeed: async () => ({ ok: false, reason: "version probe inconclusive" }),
  });
  pub.markSubjectDirty(FORMAT, SUBJECT);
  await pub.flushOnce(deps);

  const h = pub.evidencePublisherHealth();
  assert.equal(h.dirty, 1);
  assert.equal(h.failed, 1);
  assert.match(String(h.lastError), /inconclusive/);
});

test("a write that cannot be read back leaves the subject dirty", async () => {
  // The dead-batch shape: upload 201s, chunk is not there. Treating that as
  // success would report a durability the platform does not have.
  const { deps, writes } = recorder({
    confirmWrite: async () => ({ ok: false, reason: "read-back absent" }),
  });
  pub.markSubjectDirty(FORMAT, SUBJECT);
  await pub.flushOnce(deps);

  assert.equal(writes.length, 1);
  const h = pub.evidencePublisherHealth();
  assert.equal(h.dirty, 1);
  assert.equal(h.published, 0);
  assert.match(String(h.lastError), /read-back/);
});

test("an expiring batch stops the pass before anything is written", async () => {
  const { deps, writes } = recorder({ batchState: async () => ({ usable: true, ttl: 60 }) });
  pub.markSubjectDirty(FORMAT, SUBJECT);
  await pub.flushOnce(deps);

  assert.equal(writes.length, 0);
  assert.equal(pub.evidencePublisherHealth().dirty, 1);
  assert.match(String(pub.evidencePublisherHealth().lastSkipReason), /expiring/);
});

test("an unusable batch stops the pass; a batch we cannot ask about does not", async () => {
  const unusable = recorder({ batchState: async () => ({ usable: false, ttl: 86_400 }) });
  pub.markSubjectDirty(FORMAT, SUBJECT);
  await pub.flushOnce(unusable.deps);
  assert.equal(unusable.writes.length, 0);

  // Unknown is not unusable: the stamps API is not exposed on every endpoint
  // BEE_URL can point at, and refusing to publish over a failed PROBE would
  // silently disable the feature on those deployments.
  pub.__resetPublisher();
  const unknown = recorder({ batchState: async () => ({ usable: null, ttl: null }) });
  pub.markSubjectDirty(FORMAT, SUBJECT);
  await pub.flushOnce(unknown.deps);
  assert.equal(unknown.writes.length, 1);
});

test("a pass publishes at most the ceiling, and the rest stay queued", async () => {
  const { deps, writes } = recorder();
  pub.markSubjectDirty(FORMAT, SUBJECT);
  pub.markSubjectDirty(FORMAT, SUBJECT_2);
  pub.markSubjectDirty(FORMAT, SUBJECT_3);
  await pub.flushOnce(deps);

  assert.equal(writes.length, 2); // SOCIAL_PUBLISH_MAX_PER_FLUSH
  assert.equal(pub.evidencePublisherHealth().dirty, 1);

  await pub.flushOnce(deps);
  assert.equal(writes.length, 3);
  assert.equal(pub.evidencePublisherHealth().dirty, 0);
});

test("one subject throwing does not end the pass, and only it stays dirty", async () => {
  const { deps, writes } = recorder({
    tally: async (format, subject) => {
      if (subject === SUBJECT) throw new Error("bee unreachable");
      return tallyResult(subject, 1, format) as never;
    },
  });
  pub.markSubjectDirty(FORMAT, SUBJECT);
  pub.markSubjectDirty(FORMAT, SUBJECT_2);
  await pub.flushOnce(deps);

  assert.equal(writes.length, 1);
  assert.equal(pub.evidencePublisherHealth().dirty, 1);
  assert.match(String(pub.evidencePublisherHealth().lastError), /bee unreachable/);
});

test("two statement formats over one subject are separate jobs at separate topics", async () => {
  // Same failure the topic salt prevents, seen from the queue side: one job for
  // both would publish one count over the other.
  const { deps, writes } = recorder();
  pub.markSubjectDirty("woco.like.v1", SUBJECT);
  pub.markSubjectDirty("woco.follow.v1", SUBJECT);
  await pub.flushOnce(deps);

  assert.equal(writes.length, 2);
  assert.notEqual(writes[0]!.topic, writes[1]!.topic);
});

test("a format this indexer cannot tally is never queued", async () => {
  const { deps, writes } = recorder();
  pub.markSubjectDirty("woco.evidence-report.v1", SUBJECT);
  pub.markSubjectDirty("woco.ticket.v1", SUBJECT);
  assert.equal(pub.evidencePublisherHealth().dirty, 0);
  await pub.flushOnce(deps);
  assert.equal(writes.length, 0);
});

test("the same subject in a different case is one job", async () => {
  const { deps, writes } = recorder();
  pub.markSubjectDirty(FORMAT, SUBJECT);
  pub.markSubjectDirty(FORMAT, SUBJECT.toUpperCase().replace("0X", "0x"));
  await pub.flushOnce(deps);
  assert.equal(writes.length, 1);
});

// ---------------------------------------------------------------------------
// The hook that feeds the queue
// ---------------------------------------------------------------------------

test("a statement from an ALREADY-KNOWN participant still marks the subject dirty", async () => {
  // The whole reason the hook sits before the known-participant early return in
  // participants.ts. An unlike, a re-follow and a new lap all come from people
  // already on file; a hook placed after that return would publish a subject
  // once and then never again while its number moved.
  const seen: string[] = [];
  participants.setStatementObserver((format, subject) => seen.push(`${format}|${subject}`));

  const bytes = new TextEncoder().encode(JSON.stringify({ format: FORMAT, subject: SUBJECT, value: true }));
  participants.observeStatementBytes(OWNER, bytes);
  participants.observeStatementBytes(OWNER, bytes); // same owner, same subject
  const unlike = new TextEncoder().encode(JSON.stringify({ format: FORMAT, subject: SUBJECT, value: false }));
  participants.observeStatementBytes(OWNER, unlike);

  assert.equal(seen.length, 3);
  assert.deepEqual(new Set(seen), new Set([`${FORMAT}|${SUBJECT}`]));
});

test("a sealed statement never reaches the observer", async () => {
  // Registering one would leak the (subject, feed owner) pair the salted private
  // topic exists to hide — and the publisher would then write it into a report.
  const seen: string[] = [];
  participants.setStatementObserver((format, subject) => seen.push(`${format}|${subject}`));
  participants.observeStatementBytes(
    OWNER,
    new TextEncoder().encode(JSON.stringify({ ephemeralPublicKey: "aa", iv: "bb", ciphertext: "cc" })),
  );
  assert.equal(seen.length, 0);
});

test("a subject that fails every pass is set down rather than retried forever", async () => {
  // The loop this bounds: a head read that answers "absent" for a chunk that IS
  // there makes the publisher rewrite the same version, bee discards it as a
  // duplicate address while returning success, and the read-back disagrees —
  // every pass, paying postage each time.
  // The head never appears, so the identical-skip cannot save us — which is
  // exactly the condition under which the loop would run.
  const writes: string[] = [];
  const { deps } = recorder({
    writeFeed: async (topic) => {
      writes.push(topic);
      return { ok: true, version: writes.length - 1, unchanged: false };
    },
    confirmWrite: async () => ({ ok: false, reason: "read-back absent" }),
  });
  pub.markSubjectDirty(FORMAT, SUBJECT);

  for (let i = 0; i < 6; i++) await pub.flushOnce(deps);

  const h = pub.evidencePublisherHealth();
  assert.equal(h.dirty, 0, "set down, not still queued");
  assert.equal(h.stuck, 1);
  assert.equal(writes.length, 5, "bounded by SOCIAL_PUBLISH_MAX_FAILURES");
});

test("a subject that recovers loses its failure count", async () => {
  // Otherwise a subject that fails once a week would eventually be set down
  // during a perfectly healthy month.
  let broken = true;
  const writes: string[] = [];
  const { deps } = recorder({
    writeFeed: async (topic) => {
      writes.push(topic);
      return { ok: true, version: writes.length - 1, unchanged: false };
    },
    confirmWrite: async () => (broken ? { ok: false, reason: "read-back absent" } : { ok: true }),
  });
  for (let i = 0; i < 3; i++) {
    pub.markSubjectDirty(FORMAT, SUBJECT);
    await pub.flushOnce(deps);
  }
  broken = false;
  pub.markSubjectDirty(FORMAT, SUBJECT);
  await pub.flushOnce(deps);
  broken = true;
  for (let i = 0; i < 4; i++) {
    pub.markSubjectDirty(FORMAT, SUBJECT);
    await pub.flushOnce(deps);
  }

  // Four failures after the reset is still under the ceiling, so it is queued.
  assert.equal(pub.evidencePublisherHealth().stuck, 0);
  assert.equal(pub.evidencePublisherHealth().dirty, 1);
  assert.ok(writes.length > 0);
});
