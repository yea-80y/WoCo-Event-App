/**
 * The Etherna relay ledger (#912): every SOC this server has sent to Etherna and
 * not yet seen on our bee, and every one it stamped on the WoCo batch instead.
 *
 * WHY A LEDGER AND NOT A CLOCK. While Etherna cannot be asked, a read of an
 * Etherna-stamped feed used to be no answer at all (`soc-read.ts`): the head
 * might sit in Etherna's store, not yet on the network, and writing over it
 * splits the feed. But this server is Etherna's ONLY writer - client SOCs all go
 * through `POST /api/swarm/soc`, nothing in apps/web or packages/embed uploads
 * there, and every server send goes through `postSocToEtherna` - so the chunks
 * Etherna may hold that the network does not are the ones listed here. An
 * address not listed is one our bee's 404 decides; no time window could say that.
 *
 * TWO ASSUMPTIONS, both outside this code. (1) Etherna eventually pushes what it
 * accepts. A chunk it took onto a batch the network refuses (a dead batch) never
 * arrives, and once the warm-up has passed its address reads absent during an
 * outage and may be written again - a repair for every reader that asks our bee
 * first, which is all of ours, and a split only from Etherna's own side. (2) No
 * other process writes to Etherna with this account: a dev server holding the
 * production Etherna key is a second writer with its own ledger.
 *
 *   pending  - sent to Etherna (written BEFORE the request leaves); not yet seen
 *              on our bee. Whether Etherna confirmed it changes nothing here.
 *   failover - stamped on the WoCo batch in place of Etherna; to be posted there.
 *
 * `failover.ts` sweeps both: pending goes once our bee serves the chunk (or
 * neither store has it), failover once Etherna has taken the same bytes.
 *
 * ADDRESSES ONLY (owner decision, 2026-10-16): the SOC owner and identifier that
 * make the address, and the relaying account (for the batch a chunk moves back
 * to). Never the bytes: a failover chunk is re-read from our bee to be moved.
 *
 * ONE FILE PER ENTRY, AND A CEILING. Any account can sign SOCs for keys it
 * controls, so the list must not grow without bound or cost a rewrite of
 * everything per change: each entry is its own small file (the `held-orders/`
 * pattern), and past MAX_ENTRIES nothing more is listed - the rail then behaves
 * exactly as with it off, and health is red. Never worse than off.
 *
 * TRUSTED ONLY WHEN COMPLETE. The read rule applies once the list has been
 * recording for `WARMUP_MS`: from when the rail was switched on (nothing is
 * recorded while it is off), and again after any send that could not be listed
 * or written to disk (retried each sweep tick; health is red until it lands).
 * Sends made by a build without this ledger (a rollback) are not listed either:
 * delete the directory when rolling forward, which restarts the warm-up.
 *
 * MUST SURVIVE RESTARTS. Losing it leaves failover chunks on the WoCo batch for
 * good (still readable, never moved) and restarts the warm-up. An entry or state
 * file that cannot be read is never overwritten: failover and the read rule are
 * both off until it is restored, and `/api/health` `ethernaFailover` alarms.
 */

import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { calculateSocAddress } from "@woco/shared";
import { writeJsonAtomic } from "../marketing/persist.js";

/** How long the list must have been recording before an unlisted address is trusted. */
export const WARMUP_MS = 60 * 60 * 1000;
/**
 * No sweep judges an entry younger than this. Each send has a 60 s ceiling, and
 * every attempt refreshes its entry, so a sweep never decides on a send that
 * may still land in Etherna's store.
 */
export const SETTLE_MIN_AGE_MS = 5 * 60 * 1000;
/**
 * A send not on our bee this long after it first went is the push alarm: Etherna
 * took it and the network never got it (2026-10-20, every save for a day). The
 * sweep looks at ~5 min and again at ~10, so two misses come first.
 */
export const PENDING_ALARM_MS = 15 * 60 * 1000;
/** On this ledger's clock. `at`, never `updatedAt`: a repeat send and a restart both refresh that. */
export const pastPushAlarm = (at: string): boolean => now() - Date.parse(at) >= PENDING_ALARM_MS;
/** Past this the rail is off: ~10 days of the relay's per-account hourly limit, a few MB of files. */
export const MAX_ENTRIES = 10_000;
/**
 * A full list restarts the warm-up on every send it cannot take. While the
 * `since` ON DISK is under this old, a restart already loads the list as cold,
 * so the write can wait for the next tick. Judged by what the disk holds, never
 * by when it was last written: the write at boot puts an old `since` there.
 */
export const STATE_REWRITE_MIN_MS = 60 * 1000;

export type FailoverMode = "off" | "auto" | "force";
export type RelayStatus = "pending" | "failover";

export interface RelayEntry {
  /** SOC owner, 40 hex. */
  owner: string;
  /** SOC identifier, 64 hex. */
  identifier: string;
  /** The relaying account (0x, lowercase), for the batch a failover chunk moves to. */
  parent?: string;
  status: RelayStatus;
  at: string;
  updatedAt: string;
}

const ADDR = /^[0-9a-f]{64}$/;
const ENTRY_FILE = /^([0-9a-f]{64})\.json$/;
const OWNER = /^[0-9a-f]{40}$/;
const PARENT = /^0x[0-9a-f]{40}$/;

let entries = new Map<string, RelayEntry>();
let since = 0;
let unreadable: string | null = null;
let recordFailures = 0;
let lastRecordFailureAt: string | null = null;
/** Changes memory has and the disk does not: retried on each sweep tick (`retryUnsaved`). */
const unsaved = new Set<string>();
let stateUnsaved = false;
/** The warm-up restarted while the disk's `since` was still recent; the tick writes it. */
let stateBehind = false;
/** The `since` the state file holds, as last written. */
let diskSince = 0;
/** Sweep spacing, in memory: a restart checks everything soon. */
const backoff = new Map<string, { n: number; nextAt: number }>();
const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
let unlisted = 0;
let readsCleared = 0;
let loaded = false;
let now = () => Date.now();
let maxEntries = MAX_ENTRIES;
// Resolved on each use, so a test can move the working directory first.
const dir = () => join(process.cwd(), ".data", "etherna-relay-ledger");
const stateFile = () => join(dir(), "_state.json");
const entryFile = (address: string) => join(dir(), `${address}.json`);

/**
 * `ETHERNA_FAILOVER`: off (default) | auto | force. `force` stamps every relayed
 * Etherna write on WoCo, to drill the rail without an outage. A value this build
 * does not know is `off`, reported as `configError`, never fatal.
 */
export function failoverMode(): { mode: FailoverMode; configError?: string } {
  const raw = (process.env.ETHERNA_FAILOVER ?? "").trim().toLowerCase();
  if (raw === "" || raw === "off") return { mode: "off" };
  if (raw === "auto" || raw === "force") return { mode: raw };
  return { mode: "off", configError: `ETHERNA_FAILOVER="${raw.slice(0, 20)}" is not off|auto|force` };
}

function norm(hex: string): string {
  return hex.toLowerCase().replace(/^0x/, "");
}

function parseEntry(v: unknown): RelayEntry | null {
  const e = v as Partial<RelayEntry> | null;
  if (!e || typeof e !== "object") return null;
  if (typeof e.owner !== "string" || !OWNER.test(e.owner)) return null;
  if (typeof e.identifier !== "string" || !ADDR.test(e.identifier)) return null;
  if (e.parent !== undefined && (typeof e.parent !== "string" || !PARENT.test(e.parent))) return null;
  if (e.status !== "pending" && e.status !== "failover") return null;
  if (typeof e.at !== "string" || Number.isNaN(Date.parse(e.at))) return null;
  if (typeof e.updatedAt !== "string" || Number.isNaN(Date.parse(e.updatedAt))) return null;
  return {
    owner: e.owner,
    identifier: e.identifier,
    ...(e.parent ? { parent: e.parent } : {}),
    status: e.status,
    at: e.at,
    updatedAt: e.updatedAt,
  };
}

function refuse(why: string): void {
  unreadable = why;
  console.error(
    `[relay-ledger] ALARM: .data/etherna-relay-ledger ${why} - the Etherna failover and its read rule are OFF, ` +
      "and nothing will be written there until it is repaired or restored and the server restarted " +
      "(/api/health ethernaFailover)",
  );
}

const code = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  let names: string[] = [];
  try {
    names = readdirSync(dir());
  } catch (err) {
    if (code(err) !== "ENOENT") return refuse(`could not be listed (${code(err) ?? "unknown error"})`);
  }
  let state: { v?: unknown; since?: unknown; mode?: unknown } | null = null;
  try {
    state = JSON.parse(readFileSync(stateFile(), "utf-8"));
  } catch (err) {
    if (code(err) !== "ENOENT") return refuse("has an unreadable _state.json");
  }
  const parsedSince = Date.parse(String(state?.since));
  if (state && (state.v !== 1 || Number.isNaN(parsedSince))) return refuse("has a _state.json this build does not read");
  const loadedEntries = new Map<string, RelayEntry>();
  for (const name of names) {
    const m = ENTRY_FILE.exec(name);
    if (!m) continue; // _state.json, or a temp file a crashed write left
    let e: RelayEntry | null = null;
    try {
      e = parseEntry(JSON.parse(readFileSync(join(dir(), name), "utf-8")));
    } catch {
      /* refused below */
    }
    // A bad entry cannot be dropped - it may be the only record of a chunk that
    // is in Etherna alone - so the whole ledger is refused. So is one filed under
    // an address its own owner and identifier do not make: it would guard the
    // wrong address, silently, for ever.
    if (!e) return refuse(`holds an unreadable entry (${name.slice(0, 16)})`);
    if (socAddressHex(e.owner, e.identifier) !== m[1]) return refuse(`holds an entry filed under the wrong address (${name.slice(0, 16)})`);
    // A send cut off by the restart may still be landing in Etherna's store:
    // nothing is judged for SETTLE_MIN_AGE_MS from now. Memory only.
    loadedEntries.set(m[1], { ...e, updatedAt: new Date(now()).toISOString() });
  }
  entries = loadedEntries;
  // Nothing is recorded while the rail is off, so turning it on starts the warm-up.
  since = state && state.mode !== "off" && failoverMode().mode !== "off" ? parsedSince : now();
  writeState();
}

function recordFailure(): void {
  recordFailures++;
  lastRecordFailureAt = new Date(now()).toISOString();
}

function socAddressHex(owner: string, identifier: string): string {
  return Buffer.from(calculateSocAddress(Buffer.from(identifier, "hex"), Buffer.from(owner, "hex"))).toString("hex");
}

function writeState(): boolean {
  stateUnsaved = !writeJsonAtomic(
    stateFile(),
    { v: 1, since: new Date(since).toISOString(), mode: failoverMode().mode },
    "relay-ledger",
  );
  if (stateUnsaved) recordFailure();
  else {
    diskSince = since;
    stateBehind = false;
  }
  return !stateUnsaved;
}

/** A send that could not be listed: the list is not whole, so its warm-up starts again. */
function lostCompleteness(): void {
  since = now();
  if (now() - diskSince >= STATE_REWRITE_MIN_MS) writeState();
  else stateBehind = true;
}

function writeEntry(address: string, e: RelayEntry): void {
  entries.set(address, e);
  backoff.delete(address);
  if (writeJsonAtomic(entryFile(address), e, "relay-ledger")) {
    unsaved.delete(address);
    return;
  }
  // Memory is right, the disk is not: a restart would load a list without it.
  // Retried until it lands; health is red meanwhile.
  unsaved.add(address);
  recordFailure();
  lostCompleteness();
}

/**
 * Write again what did not land (the sweep's tick). While anything is unsaved a
 * restart would load an incomplete list, so `/api/health` stays red until this
 * clears it - restart only after, or delete the directory first.
 */
export function retryUnsaved(): void {
  if (!loaded || unreadable) return;
  for (const a of [...unsaved]) {
    const e = entries.get(a);
    if (!e) unsaved.delete(a);
    else if (writeJsonAtomic(entryFile(a), e, "relay-ledger")) unsaved.delete(a);
  }
  if (stateUnsaved || stateBehind) writeState();
}

/** At boot, so the warm-up runs from the first process that recorded. */
export function loadRelayLedger(): void {
  ensureLoaded();
}

/** Readable, so it can be written and trusted. Failover and the read rule are off without it. */
export function relayLedgerUsable(): boolean {
  ensureLoaded();
  return unreadable === null;
}

/** Room for one more entry. A full list is the rail switched off. */
export function relayLedgerHasRoom(): boolean {
  ensureLoaded();
  return entries.size < maxEntries;
}

/**
 * Before a POST to Etherna: from here the address may be in Etherna's store.
 * Every attempt refreshes the entry (see SETTLE_MIN_AGE_MS). A failover entry
 * being moved back stays one until the move is confirmed. Nothing is recorded
 * with the rail off.
 */
export function noteEthernaSend(address: string, owner: string, identifier: string): void {
  if (failoverMode().mode === "off") return;
  ensureLoaded();
  if (unreadable) return;
  const a = norm(address);
  const prev = entries.get(a);
  if (prev?.status === "failover") return;
  if (!prev && entries.size >= maxEntries) {
    unlisted++;
    lostCompleteness();
    return;
  }
  const t = new Date(now()).toISOString();
  // A repeat send only restarts the settle age; that lives in memory (a restart
  // restarts it anyway). One file write per new address, not per attempt.
  if (prev) {
    entries.set(a, { ...prev, updatedAt: t });
    backoff.delete(a);
    return;
  }
  writeEntry(a, { owner: norm(owner), identifier: norm(identifier), status: "pending", at: t, updatedAt: t });
}

/**
 * About to be stamped on the WoCo batch in place of Etherna. Written BEFORE the
 * stamp: a stamp that then fails leaves an entry the sweep ends (neither store
 * has it). False when it could not be listed - the caller must not detour then.
 */
export function noteFailover(address: string, owner: string, identifier: string, parent?: string): boolean {
  ensureLoaded();
  if (unreadable) return false;
  const a = norm(address);
  const prev = entries.get(a);
  if (!prev && entries.size >= maxEntries) {
    unlisted++;
    return false;
  }
  const t = new Date(now()).toISOString();
  writeEntry(a, {
    owner: norm(owner),
    identifier: norm(identifier),
    ...(parent ? { parent: parent.toLowerCase() } : {}),
    status: "failover",
    at: prev?.at ?? t,
    updatedAt: t,
  });
  return true;
}

type Seen = { address: string; updatedAt: string };
/** The entry still as the sweep read it? A send since then means it is not the sweep's to change. */
const unchanged = (v: Seen) => entries.get(norm(v.address))?.updatedAt === v.updatedAt;

/** A failover chunk our bee no longer has but Etherna does: it is back to "sent, not on the network". */
export function markPending(v: Seen): void {
  if (!unchanged(v)) return;
  const a = norm(v.address);
  const e = entries.get(a)!;
  writeEntry(a, { ...e, status: "pending", updatedAt: new Date(now()).toISOString() });
}

/** Done with: seen on our bee, moved to Etherna, or held by neither - unless sent again since. */
export function resolveEntries(seen: Seen[]): void {
  for (const v of seen) {
    if (!unchanged(v)) continue;
    const a = norm(v.address);
    entries.delete(a);
    backoff.delete(a);
    unsaved.delete(a);
    try {
      unlinkSync(entryFile(a));
    } catch (err) {
      // A file left behind reloads as listed: one address over-protected until
      // the next sweep resolves it again. Never under-protected.
      if (code(err) !== "ENOENT") console.warn(`[relay-ledger] could not remove ${a.slice(0, 12)}…: ${code(err)}`);
    }
  }
}

/**
 * Checked and kept: not looked at again for a while, doubling each time up to a
 * day - so a chunk that never settles (a dead batch's) costs a network search a
 * day, not one a pass, and never holds the entries behind it.
 */
export function deferEntries(addresses: string[]): void {
  for (const raw of addresses) {
    const a = norm(raw);
    if (!entries.has(a)) continue;
    const n = (backoff.get(a)?.n ?? 0) + 1;
    backoff.set(a, { n, nextAt: now() + Math.min(SETTLE_MIN_AGE_MS * 2 ** (n - 1), BACKOFF_MAX_MS) });
  }
}

/** Etherna is taking chunks back again: whatever waited out the outage is due now, not hours from now. */
export function undeferAll(status: RelayStatus): void {
  for (const [a, e] of entries) if (e.status === status) backoff.delete(a);
}

/**
 * A send past PENDING_ALARM_MS just reached our bee: Etherna is pushing again, so
 * every pending entry is due now, not up to a day from now with the push alarm
 * red meanwhile. Each keeps its count, so one that still never arrives (a dead
 * batch's) costs one more look per such event and backs off from where it was.
 */
export function recheckPending(): void {
  const t = now();
  for (const [a, e] of entries) {
    const b = backoff.get(a);
    if (e.status === "pending" && b) b.nextAt = t;
  }
}

/** Up to `limit` entries of one status a sweep may judge now: old enough, and not deferred. */
export function dueEntries(status: RelayStatus, limit: number): Array<RelayEntry & { address: string }> {
  ensureLoaded();
  const t = now();
  const out: Array<RelayEntry & { address: string }> = [];
  for (const [address, e] of entries) {
    if (out.length >= limit) break;
    if (e.status !== status || t - Date.parse(e.updatedAt) < SETTLE_MIN_AGE_MS) continue;
    if ((backoff.get(address)?.nextAt ?? 0) > t) continue;
    out.push({ address, ...e });
  }
  return out;
}

/**
 * The read rule's half (#912): may our bee's 404 stand while Etherna cannot be
 * asked? Only with the failover on, the list readable and complete for a full
 * warm-up, and nothing listed at this address - not even a failover entry,
 * whose chunk existed and must never be written over.
 */
export function relayLedgerClearsAbsent(address: string): boolean {
  // Mode first: with the rail off this never loads the ledger, so reads behave
  // exactly as they did before it existed.
  if (failoverMode().mode === "off") return false;
  ensureLoaded();
  if (unreadable || now() - since < WARMUP_MS || entries.has(norm(address))) return false;
  readsCleared++;
  return true;
}

export function relayLedgerState(): {
  readable: boolean;
  unreadable?: string;
  since: string | null;
  warm: boolean;
  full: boolean;
  dirty: boolean;
  recordFailures: number;
  lastRecordFailureAt: string | null;
  unlisted: number;
  readsCleared: number;
  pending: number;
  /** Pending past PENDING_ALARM_MS since first listed (a failover entry turned pending keeps its `at`). */
  stalePending: number;
  failover: number;
  oldestPendingAt: string | null;
  oldestFailoverAt: string | null;
} {
  ensureLoaded();
  let pending = 0;
  let stalePending = 0;
  let failover = 0;
  let oldestPendingAt: string | null = null;
  let oldestFailoverAt: string | null = null;
  for (const e of entries.values()) {
    if (e.status === "failover") {
      failover++;
      if (!oldestFailoverAt || e.at < oldestFailoverAt) oldestFailoverAt = e.at;
    } else {
      pending++;
      if (pastPushAlarm(e.at)) stalePending++;
      if (!oldestPendingAt || e.at < oldestPendingAt) oldestPendingAt = e.at;
    }
  }
  return {
    readable: unreadable === null,
    ...(unreadable ? { unreadable } : {}),
    since: unreadable ? null : new Date(since).toISOString(),
    warm: unreadable === null && now() - since >= WARMUP_MS,
    full: entries.size >= maxEntries,
    dirty: unsaved.size > 0 || stateUnsaved,
    recordFailures,
    lastRecordFailureAt,
    unlisted,
    readsCleared,
    pending,
    stalePending,
    failover,
    oldestPendingAt,
    oldestFailoverAt,
  };
}

export function getRelayEntry(address: string): RelayEntry | undefined {
  ensureLoaded();
  return entries.get(norm(address));
}

/** Tests only: forget memory so the next call reloads from disk, on the given clock. */
export function __resetRelayLedgerForTest(opts: { now?: () => number; maxEntries?: number } = {}): void {
  maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  entries = new Map();
  since = 0;
  unreadable = null;
  recordFailures = 0;
  lastRecordFailureAt = null;
  unsaved.clear();
  stateUnsaved = false;
  stateBehind = false;
  diskSince = 0;
  backoff.clear();
  unlisted = 0;
  readsCleared = 0;
  loaded = false;
  now = opts.now ?? (() => Date.now());
}
