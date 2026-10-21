/**
 * The Etherna failover (#912): when Etherna cannot take a relayed save, stamp it
 * on the WoCo batch so the user sees no downtime, then move it back.
 *
 * Three pieces, each small:
 *   - `relayPlan`: where a relayed SOC goes (`POST /api/swarm/soc` only, slice 1).
 *   - the read rule: `relayLedgerClearsAbsent` (relay-ledger.ts), used by soc-read.
 *   - `sweepRelayLedger`: every SWEEP_INTERVAL_MS, drop pending entries our bee
 *     now serves, and post each failover chunk to Etherna - the same signed bytes,
 *     re-read from our bee, so the same address with nothing for the user to do.
 *
 * The move back needs no signer: a SOC's signature covers its identifier and
 * content, not the batch, so any batch can stamp it again.
 */

import { ETHERNA_GATEWAY_URL, splitStoredSoc } from "@woco/shared";
import { ethernaPaused } from "./breaker.js";
import { batchForDeploy, platformEthernaBatch, type BatchSelection } from "./batch-router.js";
import { postSocToEtherna, registerEthernaOffer } from "./upload.js";
import {
  dueEntries,
  failoverMode,
  loadRelayLedger,
  markPending,
  PENDING_ALARM_MS,
  recheckPending,
  relayLedgerHasRoom,
  relayLedgerState,
  relayLedgerUsable,
  deferEntries,
  resolveEntries,
  retryUnsaved,
  undeferAll,
} from "./relay-ledger.js";
import { ethernaSource, verifyStoredSoc, wocoBeeSource, type RawSocRead } from "../swarm/soc-read.js";

export const SWEEP_INTERVAL_MS = 60 * 1000;
/** Per pass. A pending check our bee cannot answer at once is a network search, so fewer. */
export const SETTLE_PER_PASS = 50;
export const MIGRATE_PER_PASS = 100;
/** What a failover-mode relay gives Etherna before stamping on WoCo instead. */
export const FAILOVER_ETHERNA_ATTEMPTS = 2;
export const FAILOVER_ETHERNA_TIMEOUT_MS = 10_000;
/** A move back waits on nobody, so it can give Etherna longer than a save does. */
export const MIGRATE_ETHERNA_TIMEOUT_MS = 30_000;

export type RelayPlan = "etherna" | "etherna-then-woco" | "woco";

/**
 * Where a relayed Etherna-routed SOC goes. `ethernaRefused`: the router already
 * knows Etherna's batch cannot take it (#610 - gone, unusable, full).
 *
 * Off, or a ledger that cannot be written or is full, is exactly the old
 * behaviour: a chunk stamped on WoCo unlisted would never move back.
 */
export function relayPlan(ethernaRefused?: string): RelayPlan {
  const { mode } = failoverMode();
  if (mode === "off" || !relayLedgerUsable() || !relayLedgerHasRoom()) return "etherna";
  if (mode === "force" || ethernaRefused !== undefined || ethernaPaused() !== null) return "woco";
  return "etherna-then-woco";
}

const stats = { failedOver: 0, settled: 0, migrated: 0 };
let lastSweepAt: string | null = null;
let lastMigrationError: { at: string; error: string } | null = null;

/** The relay stamped one on WoCo. */
export function noteFailedOver(): void {
  stats.failedOver++;
}

export interface SweepIo {
  readBee: (address: string) => Promise<RawSocRead>;
  readEtherna: (address: string) => Promise<RawSocRead>;
  /** The Etherna batch a chunk moves to. Throws when there is none that can take it. */
  route: (parent?: string) => BatchSelection;
  post: typeof postSocToEtherna;
  offer: (address: string) => Promise<void>;
}

const liveIo: SweepIo = {
  readBee: (a) => wocoBeeSource.read(a),
  readEtherna: (a) => ethernaSource.read(a),
  // The relaying account's own live batch, else the platform batch - the same
  // choice the relay makes, taken now: the batch it was meant for may be gone.
  route: (parent) =>
    parent
      ? batchForDeploy({ ownerAddress: parent, gatewayUrl: ETHERNA_GATEWAY_URL, deployType: "event" })
      : platformEthernaBatch(),
  post: postSocToEtherna,
  offer: registerEthernaOffer,
};

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/**
 * Etherna cannot take writes right now - a timeout or network fault (no status),
 * 429, 5xx, or no batch to take them (`route` throws PlatformBatchUnavailable,
 * #610): every other chunk would meet the same, so the pass stops. A 4xx is about
 * this chunk or its account's batch, and the pass goes on without it.
 */
function ethernaCannotWrite(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === undefined || status === 429 || status >= 500;
}

/**
 * Both stores said 404 once already, at this exact entry. An Etherna 404 decides
 * a drop on its status alone, so it must say so twice, at least SETTLE_MIN_AGE_MS
 * apart - a gateway 404 during their deploy is not a verdict. Keyed by the
 * entry's `updatedAt`: a new send starts the count again.
 */
const absentOnce = new Set<string>();
function bothAbsent(e: { address: string; updatedAt: string }): boolean {
  const key = `${e.address}:${e.updatedAt}`;
  if (absentOnce.delete(key)) return true;
  absentOnce.add(key);
  if (absentOnce.size > 50_000) absentOnce.clear();
  return false;
}
/** Any other answer: the two must be in a row. */
function notAbsent(e: { address: string; updatedAt: string }): void {
  absentOnce.delete(`${e.address}:${e.updatedAt}`);
}

/**
 * One pass. Exported for tests; the timer calls it.
 *
 * Entries it checks and keeps wait longer each time (`deferEntries`), so a chunk
 * that can never settle or move costs one look per round, never the whole pass.
 */
export async function sweepRelayLedger(
  io: SweepIo = liveIo,
  perPass: { settle: number; migrate: number } = { settle: SETTLE_PER_PASS, migrate: MIGRATE_PER_PASS },
): Promise<{ settled: number; migrated: number }> {
  const done: Array<{ address: string; updatedAt: string }> = [];
  const kept: string[] = [];

  // Any chunk reaching our bee while the push alarm is red: Etherna is pushing
  // again, so the stale ones are due now, not at their next backed-off look.
  const alarmRed = relayLedgerState().stalePending > 0;
  let arrived = false;
  for (const e of dueEntries("pending", perPass.settle)) {
    const bee = await io.readBee(e.address);
    if (bee.status === "found" && verifyStoredSoc(bee.raw, e.owner, e.identifier).ok) {
      done.push(e);
      arrived = true;
      continue;
    }
    // Neither store holds it: nothing can surface later to be written over.
    const gone = bee.status === "absent" && (await io.readEtherna(e.address)).status === "absent";
    if (gone && bothAbsent(e)) done.push(e);
    else {
      if (!gone) notAbsent(e);
      kept.push(e.address);
    }
  }
  const settled = done.length;

  let migrated = 0;
  for (const e of dueEntries("failover", perPass.migrate)) {
    if (ethernaPaused() !== null) break;
    const bee = await io.readBee(e.address);
    if (bee.status === "absent") {
      // Our copy is gone. Etherna holding it is "sent, not on the network" - the
      // state the ledger exists to list - so it goes back to pending. Nobody
      // holding it ends the entry; "could not ask" keeps it.
      const eth = await io.readEtherna(e.address);
      if (eth.status === "absent" && bothAbsent(e)) done.push(e);
      else {
        if (eth.status !== "absent") notAbsent(e);
        if (eth.status === "found") markPending(e);
        else kept.push(e.address);
      }
      continue;
    }
    if (bee.status !== "found" || !verifyStoredSoc(bee.raw, e.owner, e.identifier).ok) {
      kept.push(e.address);
      continue;
    }
    const parts = splitStoredSoc(bee.raw)!;
    const body = new Uint8Array(parts.span.length + parts.payload.length);
    body.set(parts.span);
    body.set(parts.payload, parts.span.length);
    try {
      const dest = io.route(e.parent);
      await io.post({
        ownerHex: e.owner,
        identifierHex: e.identifier,
        sigHex: hex(parts.signature),
        body,
        batchId: dest.batchId,
        timeoutMs: MIGRATE_ETHERNA_TIMEOUT_MS,
      });
    } catch (err) {
      lastMigrationError = { at: new Date().toISOString(), error: ((err as Error)?.message ?? String(err)).slice(0, 200) };
      kept.push(e.address);
      if (ethernaCannotWrite(err)) break;
      continue;
    }
    io.offer(e.address).catch(() => undefined);
    done.push(e);
    // The first chunk Etherna takes back after an outage: the ones that backed
    // off during it are due on the next pass, not hours later.
    if (migrated++ === 0) undeferAll("failover");
  }

  resolveEntries(done);
  // Before the deferral, so what this pass just looked at keeps its normal wait.
  if (arrived && alarmRed) recheckPending();
  deferEntries(kept);
  stats.settled += settled;
  stats.migrated += migrated;
  lastSweepAt = new Date().toISOString();
  if (migrated > 0) console.log(`[etherna-failover] moved ${migrated} chunk(s) back to Etherna`);
  return { settled, migrated };
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** At boot. Runs in every mode: entries written while the rail was on still move back. */
export function startRelayLedgerSweep(): void {
  loadRelayLedger();
  if (timer) return;
  timer = setInterval(() => {
    if (running || !relayLedgerUsable()) return;
    running = true;
    retryUnsaved();
    sweepRelayLedger()
      .catch((err) => console.error("[etherna-failover] sweep failed:", err))
      .finally(() => {
        running = false;
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref();
}

/**
 * `/api/health` `ethernaFailover`. RED when the ledger cannot be trusted (a file
 * unreadable, a write still not on disk - `dirty`), is full (the rail is then
 * off), or the mode is not understood. During an Etherna outage the breaker reads
 * open much of the time: each pass's first move-back attempt trips it. Expected. Failover
 * entries are reported, not alarmed on: they wait on an Etherna outage, which is
 * Etherna's, and `postage.etherna` watches its batch.
 *
 * `push` is RED while a pending send is past PENDING_ALARM_MS: Etherna said yes and
 * our bee still cannot find it (2026-10-20). Also red while either store cannot be
 * asked - during an Etherna outage a refused send stays listed and nothing can
 * settle or drop it - which is worth a page too. Says nothing under `force`, which
 * lists nothing pending. It clears when the sweep sees the chunk or both stores say
 * absent; any chunk arriving while it is red puts every pending entry due at once.
 * One that never will - its batch died before Etherna pushed it - is cleared by
 * moving its file out with the server stopped. Unknown (`null`) while the list
 * cannot be read.
 */
export function ethernaFailoverHealth(): Record<string, unknown> {
  const { mode, configError } = failoverMode();
  const ledger = relayLedgerState();
  return {
    ok: ledger.readable && !ledger.full && !ledger.dirty && !configError,
    mode,
    ...(configError ? { configError } : {}),
    push: { ok: ledger.readable ? ledger.stalePending === 0 : null, alarmAfterMinutes: PENDING_ALARM_MS / 60_000 },
    ledger,
    sinceBoot: { ...stats },
    lastSweepAt,
    ...(lastMigrationError ? { lastMigrationError } : {}),
  };
}

/** Tests only. */
export function __resetFailoverStatsForTest(): void {
  absentOnce.clear();
  stats.failedOver = 0;
  stats.settled = 0;
  stats.migrated = 0;
  lastSweepAt = null;
  lastMigrationError = null;
}
