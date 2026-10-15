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
 * Etherna may hold that the network does not are exactly the ones listed here.
 * An address not listed is one our bee's 404 decides; no time window could say
 * that.
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
 * TRUSTED ONLY WHEN COMPLETE. The read rule applies once the list has been
 * recording for `WARMUP_MS` - from the file's creation, and again after any
 * change that did not reach disk (a restart would load a list without it).
 * Sends made by a build without this file (a rollback) are not listed: delete
 * the file when rolling forward, which restarts the warm-up.
 *
 * MUST SURVIVE RESTARTS. Losing it leaves failover chunks on the WoCo batch for
 * good (still readable, never moved) and restarts the warm-up. A file that exists
 * and cannot be read is never overwritten: failover and the read rule are both
 * off until it is restored, and `/api/health` `ethernaFailover` alarms.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../marketing/persist.js";

/** How long the list must have been recording before an unlisted address is trusted. */
export const WARMUP_MS = 60 * 60 * 1000;
/**
 * No sweep judges an entry younger than this. Each send has a 60 s ceiling, and
 * every attempt refreshes its entry, so a sweep never decides on a send that
 * may still land in Etherna's store.
 */
export const SETTLE_MIN_AGE_MS = 5 * 60 * 1000;

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
const OWNER = /^[0-9a-f]{40}$/;
const PARENT = /^0x[0-9a-f]{40}$/;

let entries = new Map<string, RelayEntry>();
let since = 0;
let unreadable: string | null = null;
let recordFailures = 0;
let readsCleared = 0;
let loaded = false;
let now = () => Date.now();
// Resolved on first use, so a test can move the working directory first.
const file = () => join(process.cwd(), ".data", "etherna-relay-ledger.json");

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
  if (typeof e.at !== "string" || typeof e.updatedAt !== "string") return null;
  return {
    owner: e.owner,
    identifier: e.identifier,
    ...(e.parent ? { parent: e.parent } : {}),
    status: e.status,
    at: e.at,
    updatedAt: e.updatedAt,
  };
}

function refuseFile(why: string): void {
  unreadable = why;
  console.error(
    `[relay-ledger] ALARM: etherna-relay-ledger.json ${why} - the Etherna failover and its read rule are OFF, ` +
      "and the file will NOT be written until it is repaired or restored and the server restarted " +
      "(/api/health ethernaFailover)",
  );
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  let raw: string;
  try {
    raw = readFileSync(file(), "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT") return refuseFile(`exists but could not be read (${code ?? "unknown error"})`);
    // Written now, not on the first send: `since` must survive a restart that
    // comes before any send, or the warm-up would never end on a quiet server.
    since = now();
    persist();
    return;
  }
  let obj: { v?: unknown; since?: unknown; entries?: unknown };
  try {
    obj = JSON.parse(raw);
  } catch {
    return refuseFile("is not valid JSON");
  }
  const parsedSince = Date.parse(String(obj?.since));
  if (obj?.v !== 1 || Number.isNaN(parsedSince) || !obj.entries || typeof obj.entries !== "object") {
    return refuseFile("is not a v1 relay ledger");
  }
  const loadedEntries = new Map<string, RelayEntry>();
  for (const [address, v] of Object.entries(obj.entries as Record<string, unknown>)) {
    const e = ADDR.test(address) ? parseEntry(v) : null;
    // A bad row cannot be dropped - it may be the only record of a chunk that is
    // in Etherna alone - so the whole file is refused.
    if (!e) return refuseFile(`holds an unreadable entry (${address.slice(0, 16)})`);
    loadedEntries.set(address, e);
  }
  entries = loadedEntries;
  since = parsedSince;
}

function persist(): boolean {
  const out = { v: 1, since: new Date(since).toISOString(), entries: Object.fromEntries(entries) };
  if (writeJsonAtomic(file(), out, "relay-ledger")) return true;
  // Memory is right, the file is not: until the list has been whole on disk for
  // a full warm-up again, the read rule does not trust it.
  recordFailures++;
  since = now();
  return false;
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

/**
 * Before a POST to Etherna: from here the address may be in Etherna's store.
 * Every attempt refreshes the entry (see SETTLE_MIN_AGE_MS). A failover entry
 * being moved back stays one until the move is confirmed.
 */
export function noteEthernaSend(address: string, owner: string, identifier: string): void {
  ensureLoaded();
  if (unreadable) return;
  const a = norm(address);
  const prev = entries.get(a);
  if (prev?.status === "failover") return;
  const t = new Date(now()).toISOString();
  entries.set(a, { owner: norm(owner), identifier: norm(identifier), status: "pending", at: prev?.at ?? t, updatedAt: t });
  persist();
}

/** Stamped on the WoCo batch in place of Etherna. False when it could not be listed. */
export function noteFailover(address: string, owner: string, identifier: string, parent?: string): boolean {
  ensureLoaded();
  if (unreadable) return false;
  const a = norm(address);
  const t = new Date(now()).toISOString();
  entries.set(a, {
    owner: norm(owner),
    identifier: norm(identifier),
    ...(parent ? { parent: parent.toLowerCase() } : {}),
    status: "failover",
    at: entries.get(a)?.at ?? t,
    updatedAt: t,
  });
  return persist();
}

/** Done with: seen on our bee, moved to Etherna, or held by neither. One write for the lot. */
export function resolveEntries(addresses: string[]): void {
  let changed = false;
  for (const a of addresses) changed = entries.delete(norm(a)) || changed;
  if (changed) persist();
}

/** Up to `limit` entries of one status old enough for a sweep to judge. */
export function dueEntries(status: RelayStatus, limit: number): Array<RelayEntry & { address: string }> {
  ensureLoaded();
  const t = now();
  const out: Array<RelayEntry & { address: string }> = [];
  for (const [address, e] of entries) {
    if (out.length >= limit) break;
    if (e.status === status && t - Date.parse(e.updatedAt) >= SETTLE_MIN_AGE_MS) out.push({ address, ...e });
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
  // Mode first: with the rail off this never loads the file, so reads behave
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
  recordFailures: number;
  readsCleared: number;
  pending: number;
  failover: number;
  oldestPendingAt: string | null;
  oldestFailoverAt: string | null;
} {
  ensureLoaded();
  let pending = 0;
  let failover = 0;
  let oldestPendingAt: string | null = null;
  let oldestFailoverAt: string | null = null;
  for (const e of entries.values()) {
    if (e.status === "failover") {
      failover++;
      if (!oldestFailoverAt || e.at < oldestFailoverAt) oldestFailoverAt = e.at;
    } else {
      pending++;
      if (!oldestPendingAt || e.at < oldestPendingAt) oldestPendingAt = e.at;
    }
  }
  return {
    readable: unreadable === null,
    ...(unreadable ? { unreadable } : {}),
    since: unreadable ? null : new Date(since).toISOString(),
    warm: unreadable === null && now() - since >= WARMUP_MS,
    recordFailures,
    readsCleared,
    pending,
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
export function __resetRelayLedgerForTest(opts: { now?: () => number } = {}): void {
  entries = new Map();
  since = 0;
  unreadable = null;
  recordFailures = 0;
  readsCleared = 0;
  loaded = false;
  now = opts.now ?? (() => Date.now());
}
