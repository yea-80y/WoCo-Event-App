/**
 * Sender pacing (#619): a first send to contacts new to the platform goes out
 * in hourly batches, with bounce and complaint checks between them.
 *
 * WHY. Every organiser's marketing leaves through ONE SES account, and SES
 * rates bounces and complaints per ACCOUNT: at 10% bounces it "might pause",
 * and a pause stops ticket email too. A stale imported list is mostly dead
 * mailboxes. Unpaced, 1,000 contacts that are 15% dead put 150 hard bounces on
 * the account in 80 seconds; paced, the first batch of 100 produces about 15,
 * which crosses the stop line, and the other 135 never happen.
 *
 * SENDER-AGNOSTIC ON PURPOSE. A sender is an opaque id (today an organiser's
 * wallet address), a batch is an opaque id, a contact is a hash. Nothing here
 * knows about events, lists or organisers, so the same module can sit behind a
 * sending service whose customers are not organisers at all.
 *
 * The numbers live in `@woco/shared` (`marketing/pacing.ts`) with their
 * sources; the checks in `evaluate.ts`. This file is the state: what each
 * sender has sent, what came back, and where they are on the ladder.
 *
 * STORED: `.data/sender-pacing/{sender}.json`, one per sender, and
 * `_platform.json`. Hash-only. MUST survive restarts — losing a sender's file
 * forgets a stop, and losing `nextAllowedAt` would let a restart shorten a wait.
 */

import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  PACING_BATCH_GAP_MS,
  PACING_PROOF_DELAY_MS,
  PACING_THRESHOLDS,
  PACING_WINDOW_MS,
  batchAllowance,
  crosses,
  nextUtcMidnight,
  utcDay,
  type PacingPosition,
} from "@woco/shared";
import { writeJsonAtomic } from "../marketing/persist.js";
import { evaluate, holdScope, type BatchCounts, type BatchKind, type Evaluation, type HoldCause } from "./evaluate.js";

export type { BatchKind, HoldCause } from "./evaluate.js";

const DIR = join(process.cwd(), ".data", "sender-pacing");
const PLATFORM_FILE = join(DIR, "_platform.json");

/**
 * A sender id becomes a file name, so it is held to a charset that cannot
 * escape the directory. A leading `_` is reserved for platform files.
 */
const SENDER_RE = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/;

const LOG_RETENTION_MS = 90 * 24 * 60 * 60_000;
/** Sending days are only ever counted up to the top rung; keep a little more. */
const SENDING_DAYS_KEPT = 10;
/** A held batch re-asks at this interval — often enough to resume promptly, rarely enough not to spin. */
const HELD_RETRY_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StoredBatch {
  /** `${jobId}:p` for proven contacts, `${jobId}:u${n}` for the n-th batch of new ones. */
  id: string;
  kind: BatchKind;
  startedAt: number;
  /** New contacts admitted (u batches). Counts against the day's ceiling. */
  admitted: number;
  accepted: number;
  lastAcceptedAt?: number;
  /** Accepted, awaiting the proof delay. New-contact batches only. */
  pendingProof: string[];
  bounces: Record<string, number>;
  /** By feedback type, `not-spam` included for the operator but never counted. */
  complaints: Record<string, number>;
  /** Events about addresses the provider refused to send to — no message went. */
  providerSuppressed: number;
}

interface LogEntry {
  at: number;
  by: string;
  action: "stop" | "lift";
  reason: string;
}

interface StoredSender {
  sender: string;
  stop?: { since: number; reason: string; by: string };
  /**
   * Batches started before this are ignored by the checks. Set by an operator
   * lift, so the evidence that caused a stop cannot re-cause it the moment it
   * is lifted — SES does the same after a review: "we adjust our calculations
   * to only consider bounces received after your changes were implemented."
   */
  baselineAt?: number;
  log: LogEntry[];
  /** Distinct UTC days (`YYYY-MM-DD`) with an admitted batch of new contacts. */
  sendingDays: string[];
  nextAllowedAt?: number;
  batches: StoredBatch[];
  /** Hashes delivered to without a hard bounce — exempt from pacing. */
  proven: string[];
}

interface Live {
  rec: StoredSender;
  proven: Set<string>;
}

export type PacingState =
  | { kind: "open" }
  | { kind: "held"; scope: "new" | "all"; causes: HoldCause[] }
  | { kind: "stopped"; since: string; reason: string; by: string };

export type AdmitResult =
  | { ok: true; size: number; rung: number }
  | { ok: false; code: "STOPPED" | "HELD" | "TOO_SOON" | "DAY_EXHAUSTED"; retryAt?: number };

export interface ComplaintInfo {
  feedbackType?: string;
  /** SES: `OnAccountSuppressionList` / `OnTenantSuppressionList` mean nothing was sent. */
  complaintSubType?: string | null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const senders = new Map<string, Live>();
let platform: Record<string, { accepted: number; bounces: number; complaints: number }> = {};
let platformDirty = false;
let loaded = false;

type Listener = (sender: string, state: PacingState) => void;
const listeners: Listener[] = [];
/**
 * The state last announced per sender. Compared against, rather than a
 * before/after pair, because a hold can lift with nothing happening at all:
 * the bad batch simply ages out of the window, and at that instant "before"
 * and "after" are the same reading.
 */
const announced = new Map<string, PacingState>();

function fileFor(sender: string): string {
  return join(DIR, `${sender}.json`);
}

export function isValidSenderId(sender: string): boolean {
  return SENDER_RE.test(sender);
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  if (!existsSync(DIR)) return;
  for (const name of readdirSync(DIR)) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(DIR, name), "utf-8"));
      if (name === "_platform.json") {
        platform = raw && typeof raw === "object" ? raw : {};
        continue;
      }
      const rec = raw as StoredSender;
      if (!rec?.sender || !isValidSenderId(rec.sender)) continue;
      senders.set(rec.sender, { rec, proven: new Set(rec.proven ?? []) });
    } catch {
      // One unreadable record must not stop the rest loading. It FAILS OPEN for
      // that sender (a lost stop), which is why the write path alarms through
      // `persistHealth` rather than being left to a log line.
      console.error(`[sender-pacing] Skipping unreadable record ${name}`);
    }
  }
}

function get(sender: string): Live {
  ensureLoaded();
  if (!isValidSenderId(sender)) throw new Error(`sender-pacing: invalid sender id`);
  let live = senders.get(sender);
  if (!live) {
    live = { rec: { sender, log: [], sendingDays: [], batches: [], proven: [] }, proven: new Set() };
    senders.set(sender, live);
  }
  return live;
}

function persist(live: Live): boolean {
  live.rec.proven = [...live.proven];
  return writeJsonAtomic(fileFor(live.rec.sender), live.rec, "sender-pacing");
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function countedComplaints(b: StoredBatch): number {
  let n = 0;
  for (const [type, c] of Object.entries(b.complaints)) if (type !== "not-spam") n += c;
  return n;
}

function windowBatches(rec: StoredSender, at: number): StoredBatch[] {
  const from = Math.max(at - PACING_WINDOW_MS, rec.baselineAt ?? -Infinity);
  return rec.batches.filter((b) => b.startedAt > at - PACING_WINDOW_MS && b.startedAt >= from);
}

function evaluateSender(rec: StoredSender, at: number): Evaluation {
  const counts: BatchCounts[] = windowBatches(rec, at).map((b) => ({
    kind: b.kind,
    startedAt: b.startedAt,
    accepted: b.accepted,
    bounces: b.bounces,
    complaints: countedComplaints(b),
  }));
  return evaluate(counts);
}

function stateOf(rec: StoredSender, at: number): PacingState {
  if (rec.stop) {
    return { kind: "stopped", since: new Date(rec.stop.since).toISOString(), reason: rec.stop.reason, by: rec.stop.by };
  }
  const { holds } = evaluateSender(rec, at);
  const scope = holdScope(holds);
  return scope ? { kind: "held", scope, causes: holds } : { kind: "open" };
}

function sameState(a: PacingState, b: PacingState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "held" && b.kind === "held") return a.scope === b.scope;
  return true;
}

/** Announce the sender's state if it differs from the last one announced. */
function settle(sender: string, at: number): PacingState {
  const live = senders.get(sender);
  const now: PacingState = live ? stateOf(live.rec, at) : { kind: "open" };
  const prev = announced.get(sender) ?? { kind: "open" };
  announced.set(sender, now);
  if (sameState(prev, now)) return now;
  for (const l of listeners) {
    try {
      l(sender, now);
    } catch (err) {
      console.error("[sender-pacing] state listener threw:", err);
    }
  }
  return now;
}

const STOP_REASON: Record<HoldCause, string> = {
  "new-bounce": "Too many of the new contacts bounced",
  "new-complaint": "Too many of the new contacts reported the email as spam",
  "all-bounce": "Too many of the sender's emails bounced",
  "all-complaint": "Too many of the sender's emails were reported as spam",
};

/**
 * Set the stop the moment a stop line is crossed. Sticky: only an operator
 * lifts it, mirroring SES, where a pause lasts until a person has reviewed it.
 */
function applyStopLine(live: Live, at: number): void {
  if (live.rec.stop) return;
  const { stop } = evaluateSender(live.rec, at);
  if (!stop) return;
  live.rec.stop = { since: at, reason: STOP_REASON[stop], by: "automatic" };
  live.rec.log.push({ at, by: "automatic", action: "stop", reason: STOP_REASON[stop] });
  console.error(`[sender-pacing] Sender ${live.rec.sender} STOPPED: ${STOP_REASON[stop]}`);
}

export function pacingState(sender: string, at = Date.now()): PacingState {
  return stateOf(get(sender).rec, at);
}

/** The details behind a hold or stop, for the organiser's copy. Counts only. */
export function pacingWindow(sender: string, at = Date.now()): Evaluation {
  return evaluateSender(get(sender).rec, at);
}

export function position(sender: string, at = Date.now()): PacingPosition {
  const { rec } = get(sender);
  const today = utcDay(at);
  const earlier = new Set(rec.sendingDays.filter((d) => d < today)).size;
  let admittedToday = 0;
  for (const b of rec.batches) {
    if (b.kind === "u" && utcDay(b.startedAt) === today) admittedToday += b.admitted;
  }
  return {
    earlierSendingDays: earlier,
    admittedToday,
    nextAllowedAt: rec.nextAllowedAt && rec.nextAllowedAt > at ? rec.nextAllowedAt : null,
    at,
  };
}

export function isProven(sender: string, hash: string): boolean {
  return get(sender).proven.has(hash);
}

/** Proven contacts may drain unless the sender is stopped or every send is held. */
export function mayDrain(sender: string, kind: BatchKind, at = Date.now()): boolean {
  const s = pacingState(sender, at);
  if (s.kind === "stopped") return false;
  if (kind === "p") return !(s.kind === "held" && s.scope === "all");
  return s.kind === "open";
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Open the next batch of new contacts, or say why not and when to ask again.
 *
 * Rung and day ceiling are recomputed HERE, at every batch start, from the
 * durable record — never cached on a job — so a restart, a second job from the
 * same sender, or a day rollover cannot hand out allowance twice.
 */
export function admit(sender: string, batchId: string, remaining: number, at = Date.now()): AdmitResult {
  const live = get(sender);
  if (!live.rec.stop) {
    applyStopLine(live, at);
    if (live.rec.stop) persist(live);
  }
  settle(sender, at);
  const state = stateOf(live.rec, at);
  if (state.kind === "stopped") return { ok: false, code: "STOPPED" };
  if (state.kind === "held") return { ok: false, code: "HELD", retryAt: at + HELD_RETRY_MS };
  if (live.rec.nextAllowedAt && at < live.rec.nextAllowedAt) {
    return { ok: false, code: "TOO_SOON", retryAt: live.rec.nextAllowedAt };
  }
  const allowance = batchAllowance(position(sender, at));
  if (allowance.size <= 0) return { ok: false, code: "DAY_EXHAUSTED", retryAt: nextUtcMidnight(at) };

  const size = Math.min(allowance.size, Math.max(0, Math.floor(remaining)));
  if (size <= 0) return { ok: false, code: "DAY_EXHAUSTED", retryAt: nextUtcMidnight(at) };

  live.rec.batches.push({
    id: batchId,
    kind: "u",
    startedAt: at,
    admitted: size,
    accepted: 0,
    pendingProof: [],
    bounces: {},
    complaints: {},
    providerSuppressed: 0,
  });
  const today = utcDay(at);
  if (!live.rec.sendingDays.includes(today)) {
    live.rec.sendingDays = [...live.rec.sendingDays, today].sort().slice(-SENDING_DAYS_KEPT);
  }
  live.rec.nextAllowedAt = at + PACING_BATCH_GAP_MS;
  persist(live);
  return { ok: true, size, rung: allowance.rung };
}

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

function findBatch(rec: StoredSender, batchId: string): StoredBatch | undefined {
  return rec.batches.find((b) => b.id === batchId);
}

/**
 * The provider accepted these messages. Proven-contact sends are counted but
 * never become proof — they were proven already. The platform total is NOT
 * touched here: `send.ts` counts every accepted message, of both kinds, once.
 */
export function recordAccepted(
  sender: string,
  batchId: string,
  kind: BatchKind,
  hashes: string[],
  at = Date.now(),
): void {
  if (hashes.length === 0) return;
  const live = get(sender);
  let batch = findBatch(live.rec, batchId);
  if (!batch) {
    batch = {
      id: batchId,
      kind,
      startedAt: at,
      admitted: 0,
      accepted: 0,
      pendingProof: [],
      bounces: {},
      complaints: {},
      providerSuppressed: 0,
    };
    live.rec.batches.push(batch);
  }
  batch.accepted += hashes.length;
  batch.lastAcceptedAt = at;
  if (batch.kind === "u") batch.pendingProof.push(...hashes);
  persist(live);
}

/**
 * A hard bounce attributed to a batch. Every `Permanent` subtype counts,
 * including the suppression-list ones SES leaves out of its own metric: this
 * measures the LIST, and an address the provider already refuses is the
 * strongest staleness evidence there is.
 *
 * @returns false when the batch is unknown or aged out — the event is dropped
 *   rather than guessed onto another batch.
 */
export function recordBounce(sender: string, batchId: string, subtype: string, n = 1, at = Date.now()): boolean {
  if (!isValidSenderId(sender)) return false;
  const live = get(sender);
  const batch = findBatch(live.rec, batchId);
  if (!batch || n <= 0) return false;
  const key = subtype || "Unknown";
  batch.bounces[key] = (batch.bounces[key] ?? 0) + n;
  applyStopLine(live, at);
  persist(live);
  settle(sender, at);
  return true;
}

/** Only a feedback report about a message that was actually sent counts. */
export function countsAsComplaint(info: ComplaintInfo): boolean {
  if (info.complaintSubType) return false;
  return info.feedbackType !== "not-spam";
}

export function recordComplaint(
  sender: string,
  batchId: string,
  info: ComplaintInfo,
  n = 1,
  at = Date.now(),
): boolean {
  if (!isValidSenderId(sender)) return false;
  const live = get(sender);
  const batch = findBatch(live.rec, batchId);
  if (!batch || n <= 0) return false;
  if (info.complaintSubType) {
    batch.providerSuppressed += n;
  } else {
    const key = info.feedbackType || "unspecified";
    batch.complaints[key] = (batch.complaints[key] ?? 0) + n;
  }
  applyStopLine(live, at);
  persist(live);
  settle(sender, at);
  return true;
}

// ---------------------------------------------------------------------------
// Platform totals — the account-level view, both kinds of mail
// ---------------------------------------------------------------------------

function platformDay(at: number) {
  const day = utcDay(at);
  platform[day] ??= { accepted: 0, bounces: 0, complaints: 0 };
  platformDirty = true;
  return platform[day]!;
}

export function recordPlatformAccepted(n = 1, at = Date.now()): void {
  ensureLoaded();
  platformDay(at).accepted += n;
}

/**
 * The platform view mirrors what SES counts, because its job is to warn before
 * SES acts: suppression-list bounces are left out, as SES leaves them out.
 */
export function recordPlatformBounce(subtype: string, n = 1, at = Date.now()): void {
  ensureLoaded();
  if (subtype === "OnAccountSuppressionList" || subtype === "OnTenantSuppressionList") return;
  platformDay(at).bounces += n;
}

export function recordPlatformComplaint(info: ComplaintInfo, n = 1, at = Date.now()): void {
  ensureLoaded();
  if (!countsAsComplaint(info)) return;
  platformDay(at).complaints += n;
}

function platformTotals(at: number) {
  let accepted = 0;
  let bounces = 0;
  let complaints = 0;
  for (let i = 0; i < 7; i++) {
    const d = platform[utcDay(at - i * 24 * 60 * 60_000)];
    if (!d) continue;
    accepted += d.accepted;
    bounces += d.bounces;
    complaints += d.complaints;
  }
  return { accepted, bounces, complaints };
}

function flushPlatform(): void {
  if (!platformDirty) return;
  platformDirty = false;
  if (!writeJsonAtomic(PLATFORM_FILE, platform, "sender-pacing")) platformDirty = true;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Promote proof, age out old batches, and notice holds lifting with time.
 *
 * @param blocked true for a hash the platform has suppressed since it was sent
 *   (a hard bounce or a complaint) — injected so this module never reads the
 *   suppression store.
 */
export function sweepPacing(blocked: (hash: string) => boolean, at = Date.now()): void {
  ensureLoaded();
  for (const live of senders.values()) {
    let changed = false;

    for (const b of live.rec.batches) {
      if (b.pendingProof.length === 0 || b.lastAcceptedAt === undefined) continue;
      if (at - b.lastAcceptedAt < PACING_PROOF_DELAY_MS) continue;
      for (const h of b.pendingProof) if (!blocked(h)) live.proven.add(h);
      b.pendingProof = [];
      changed = true;
    }

    const kept = live.rec.batches.filter((b) => b.startedAt > at - PACING_WINDOW_MS || b.pendingProof.length > 0);
    if (kept.length !== live.rec.batches.length) {
      live.rec.batches = kept;
      changed = true;
    }
    const log = live.rec.log.filter((e) => at - e.at < LOG_RETENTION_MS);
    if (log.length !== live.rec.log.length) {
      live.rec.log = log;
      changed = true;
    }

    if (changed) persist(live);
    settle(live.rec.sender, at);
  }

  for (const day of Object.keys(platform)) {
    if (day < utcDay(at - PACING_WINDOW_MS)) {
      delete platform[day];
      platformDirty = true;
    }
  }
  flushPlatform();
}

/** Called at shutdown so the platform totals of the last minute are not lost. */
export function flushPacing(): void {
  flushPlatform();
}

/**
 * A new import replaces the sender's list. Proof is kept only for contacts
 * still on it: proof exists to exempt someone from pacing, and a contact who
 * left the list has nothing to be exempted from.
 */
export function pruneProven(sender: string, keep: ReadonlySet<string>): void {
  const live = get(sender);
  let removed = false;
  for (const h of live.proven) {
    if (!keep.has(h)) {
      live.proven.delete(h);
      removed = true;
    }
  }
  if (removed) persist(live);
}

/** Art. 15 — the senders whose proof covers this contact. */
export function sendersProvenFor(hash: string): string[] {
  ensureLoaded();
  const out: string[] = [];
  for (const [sender, live] of senders) {
    if (live.proven.has(hash) || live.rec.batches.some((b) => b.pendingProof.includes(hash))) out.push(sender);
  }
  return out;
}

/**
 * Art. 17 — forget a contact's proof. Erased, unlike a broadcast's send
 * record: proof has no send-once role, and suppression is what keeps an erased
 * subject from being mailed.
 *
 * @returns false if any write failed.
 */
export function forgetHash(hash: string, sender?: string): boolean {
  ensureLoaded();
  let ok = true;
  for (const [id, live] of senders) {
    if (sender && id !== sender) continue;
    let changed = live.proven.delete(hash);
    for (const b of live.rec.batches) {
      const next = b.pendingProof.filter((h) => h !== hash);
      if (next.length !== b.pendingProof.length) {
        b.pendingProof = next;
        changed = true;
      }
    }
    if (changed) ok = persist(live) && ok;
  }
  return ok;
}

export function stopSender(sender: string, by: string, reason: string, at = Date.now()): PacingState {
  const live = get(sender);
  live.rec.stop = { since: at, reason, by };
  live.rec.log.push({ at, by, action: "stop", reason });
  persist(live);
  return settle(sender, at);
}

/**
 * The only way out of a stop. Resets the evidence baseline so the same
 * bounces cannot re-stop the sender on the next event.
 */
export function liftSender(sender: string, by: string, reason: string, at = Date.now()): PacingState {
  const live = get(sender);
  delete live.rec.stop;
  live.rec.baselineAt = at;
  live.rec.log.push({ at, by, action: "lift", reason });
  persist(live);
  return settle(sender, at);
}

export function onPacingStateChange(listener: Listener): void {
  listeners.push(listener);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface SenderPacingHealth {
  /** False when any sender is stopped, or the platform's 7-day rate is over a hold line. */
  ok: boolean;
  stopped: number;
  held: { new: number; all: number };
  platform7d: { accepted: number; bounces: number; complaints: number; bounceOk: boolean; complaintOk: boolean };
}

/** For /api/health, which is public: counts only, never a sender id. */
export function pacingHealth(at = Date.now()): SenderPacingHealth {
  ensureLoaded();
  let stopped = 0;
  const held = { new: 0, all: 0 };
  for (const live of senders.values()) {
    const s = stateOf(live.rec, at);
    if (s.kind === "stopped") stopped++;
    else if (s.kind === "held") held[s.scope]++;
  }
  const p = platformTotals(at);
  const bounceOk = !crosses(PACING_THRESHOLDS.holdBounce, p.bounces, p.accepted);
  const complaintOk = !crosses(PACING_THRESHOLDS.holdComplaint, p.complaints, p.accepted);
  return {
    ok: stopped === 0 && bounceOk && complaintOk,
    stopped,
    held,
    platform7d: { ...p, bounceOk, complaintOk },
  };
}

/** For the operator route, behind OPS_TOKEN. Still hash-free. */
export function listForOps(at = Date.now()) {
  ensureLoaded();
  return [...senders.values()].map(({ rec, proven }) => {
    const pos = position(rec.sender, at);
    const ev = evaluateSender(rec, at);
    const bounceSubtypes: Record<string, number> = {};
    let providerSuppressed = 0;
    for (const b of windowBatches(rec, at)) {
      for (const [k, n] of Object.entries(b.bounces)) bounceSubtypes[k] = (bounceSubtypes[k] ?? 0) + n;
      providerSuppressed += b.providerSuppressed;
    }
    return {
      sender: rec.sender,
      state: stateOf(rec, at),
      rung: batchAllowance(pos).rung,
      admittedToday: pos.admittedToday,
      nextAllowedAt: pos.nextAllowedAt ? new Date(pos.nextAllowedAt).toISOString() : null,
      window: { all: ev.all, new: ev.new, holds: ev.holds, bounceSubtypes, providerSuppressed },
      proven: proven.size,
      log: rec.log.map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Tests only — memory AND disk, so suites start from empty. */
export function _resetPacingForTest(): void {
  rmSync(DIR, { recursive: true, force: true });
  senders.clear();
  announced.clear();
  platform = {};
  platformDirty = false;
  listeners.length = 0;
  loaded = false;
}

/** Tests only — drops memory, keeps disk. Models a restart. */
export function _reloadPacingForTest(): void {
  senders.clear();
  announced.clear();
  platform = {};
  platformDirty = false;
  loaded = false;
}
