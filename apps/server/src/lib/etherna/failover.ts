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
  relayLedgerState,
  relayLedgerUsable,
  resolveEntries,
} from "./relay-ledger.js";
import { ethernaSource, verifyStoredSoc, wocoBeeSource, type RawSocRead } from "../swarm/soc-read.js";

export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** Per status per pass: each check of an entry our bee lacks is a network search. */
export const SWEEP_PER_PASS = 20;
/** What a failover-mode relay gives Etherna before stamping on WoCo instead. */
export const FAILOVER_ETHERNA_ATTEMPTS = 2;
export const FAILOVER_ETHERNA_TIMEOUT_MS = 10_000;

export type RelayPlan = "etherna" | "etherna-then-woco" | "woco";

/**
 * Where a relayed Etherna-routed SOC goes. `ethernaRefused`: the router already
 * knows Etherna's batch cannot take it (#610 - gone, unusable, full).
 *
 * Off, or a ledger that cannot be written, is exactly the old behaviour: a chunk
 * stamped on WoCo unlisted would never move back.
 */
export function relayPlan(ethernaRefused?: string): RelayPlan {
  const { mode } = failoverMode();
  if (mode === "off" || !relayLedgerUsable()) return "etherna";
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

/** One pass. Exported for tests; the timer calls it. */
export async function sweepRelayLedger(io: SweepIo = liveIo): Promise<{ settled: number; migrated: number }> {
  const done: string[] = [];

  for (const e of dueEntries("pending", SWEEP_PER_PASS)) {
    const bee = await io.readBee(e.address);
    if (bee.status === "found") {
      if (verifyStoredSoc(bee.raw, e.owner, e.identifier).ok) done.push(e.address);
      continue;
    }
    // Neither store holds it: nothing can surface later to be written over.
    if (bee.status === "absent" && (await io.readEtherna(e.address)).status === "absent") done.push(e.address);
  }
  const settled = done.length;

  let migrated = 0;
  for (const e of dueEntries("failover", SWEEP_PER_PASS)) {
    if (ethernaPaused() !== null) break;
    const bee = await io.readBee(e.address);
    if (bee.status === "absent") {
      // Our copy is gone. Etherna holding it, or nobody holding it, both end the
      // entry; only "could not ask" keeps it.
      if ((await io.readEtherna(e.address)).status !== "unavailable") done.push(e.address);
      continue;
    }
    if (bee.status !== "found" || !verifyStoredSoc(bee.raw, e.owner, e.identifier).ok) continue;
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
        timeoutMs: FAILOVER_ETHERNA_TIMEOUT_MS * 3,
      });
    } catch (err) {
      // Etherna cannot take writes yet, or its batch cannot (`route` throws
      // PlatformBatchUnavailable, #610): the rest wait for the next pass.
      lastMigrationError = { at: new Date().toISOString(), error: ((err as Error)?.message ?? String(err)).slice(0, 200) };
      break;
    }
    io.offer(e.address).catch(() => undefined);
    done.push(e.address);
    migrated++;
  }

  resolveEntries(done);
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
    sweepRelayLedger()
      .catch((err) => console.error("[etherna-failover] sweep failed:", err))
      .finally(() => {
        running = false;
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref();
}

/**
 * `/api/health` `ethernaFailover`. RED when the ledger cannot be trusted (file
 * unreadable, a write that did not land) or the mode is not understood. Waiting
 * entries are reported, not alarmed on: they wait on an Etherna outage, which is
 * Etherna's, and `postage.etherna` watches its batch.
 */
export function ethernaFailoverHealth(): Record<string, unknown> {
  const { mode, configError } = failoverMode();
  const ledger = relayLedgerState();
  return {
    ok: ledger.readable && !configError && ledger.recordFailures === 0,
    mode,
    ...(configError ? { configError } : {}),
    ledger,
    sinceBoot: { ...stats },
    lastSweepAt,
    ...(lastMigrationError ? { lastMigrationError } : {}),
  };
}

/** Tests only. */
export function __resetFailoverStatsForTest(): void {
  stats.failedOver = 0;
  stats.settled = 0;
  stats.migrated = 0;
  lastSweepAt = null;
  lastMigrationError = null;
}
