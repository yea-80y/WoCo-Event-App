/**
 * The two probes behind the `/api/health` postage and paymaster sections
 * (#421, #522).
 *
 * WHY A TIMER AND NOT A READ-THROUGH. `/api/health` is polled by uptime checks
 * and read by hand during an incident; it must answer instantly and must never
 * be the thing that makes an RPC or a bee slow. So the readings are refreshed
 * on a background interval and the handler serves whatever was last read,
 * stamped with WHEN — and `stale` when the refresher itself has stopped. A
 * check that cannot check has to be visible, not silently frozen at its last
 * happy answer.
 *
 * All verdict logic lives in ./alarms.ts, which has no network and no clock.
 * This module is the plumbing: read, park the reading, log transitions.
 */

import { JsonRpcProvider, Contract, formatEther, parseEther } from "ethers";
import { ENTRY_POINT_V07_ADDRESS, KERNEL_CHAIN_ID, SELF_FUNDED_PAYMASTER_ADDRESS } from "@woco/shared";
import { getChainRpcUrl } from "../chain/event-contract.js";
import { BEE_URL, POSTAGE_BATCH_ID } from "../../config/swarm.js";
import { readEthernaStamp } from "../etherna/batches.js";
import {
  type Check,
  type StampReading,
  type StampVerdicts,
  type Verdict,
  combine,
  evaluateChainLag,
  evaluatePaymaster,
  evaluateStamp,
  isStale,
  readThresholdsFromEnv,
} from "./alarms.js";

export const PROBE_INTERVAL_MS = 60_000;
/** Etherna is an external OAuth service — probed a fifth as often, on purpose. */
export const ETHERNA_PROBE_INTERVAL_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;

/** The ZeroDev ceiling the server CANNOT see, named so nobody infers it can. */
const PAYMASTER_NOTE =
  "EntryPoint deposit only. The ZeroDev monthly policy caps (sponsored gas and userOps per month) are dashboard-only and are NOT visible here.";

interface Reading<T> {
  at: number | null;
  value: T | null;
  error: string | null;
}

const empty = <T>(): Reading<T> => ({ at: null, value: null, error: null });

let paymasterReading = empty<bigint>();
let beeReading = empty<StampReading & { immutable: boolean | null }>();
let chainstateReading = empty<{ block: number; chainTip: number }>();
let ethernaReading = empty<StampReading & { immutable: boolean | null }>();

// ---------------------------------------------------------------------------
// Live readers — injectable so every rule above can be tested without a network
// ---------------------------------------------------------------------------

export interface HealthReaders {
  deposit(): Promise<bigint>;
  beeStamp(batchId: string): Promise<Record<string, unknown>>;
  chainstate(): Promise<Record<string, unknown>>;
  ethernaStamp(batchId: string): Promise<Record<string, unknown>>;
}

const ENTRY_POINT_ABI = ["function balanceOf(address account) view returns (uint256)"];

let provider: JsonRpcProvider | null = null;
function entryPoint(): Contract {
  if (!provider) provider = new JsonRpcProvider(getChainRpcUrl(KERNEL_CHAIN_ID), KERNEL_CHAIN_ID);
  return new Contract(ENTRY_POINT_V07_ADDRESS, ENTRY_POINT_ABI, provider);
}

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${what} timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
      t.unref?.();
    }),
  ]);
}

async function beeGet(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BEE_URL}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  // The stamps API is not exposed on every endpoint BEE_URL can point at, and a
  // gateway answering HTML with a 200 must read as "could not tell", not as data.
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) {
    throw new Error(`GET ${path} → not JSON (stamps API not exposed here?)`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export const liveReaders: HealthReaders = {
  deposit: async () => {
    const wei = await withTimeout(
      entryPoint().balanceOf(SELF_FUNDED_PAYMASTER_ADDRESS) as Promise<bigint>,
      "EntryPoint balanceOf",
    );
    return wei;
  },
  beeStamp: (batchId) => beeGet(`/stamps/${batchId}`),
  chainstate: () => beeGet("/chainstate"),
  ethernaStamp: (batchId) => readEthernaStamp(batchId, TIMEOUT_MS) as Promise<Record<string, unknown>>,
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * A stamp is only a reading when EVERY field a verdict depends on is there.
 *
 * A partial answer parsed leniently is the worst outcome available: it looks
 * like data, so it produces a verdict, and the verdict is about fields the node
 * never sent.
 */
function parseStamp(raw: Record<string, unknown>): (StampReading & { immutable: boolean | null }) | null {
  const depth = num(raw.depth);
  const bucketDepth = num(raw.bucketDepth);
  const utilization = num(raw.utilization);
  const batchTTL = num(raw.batchTTL);
  if (depth === null || bucketDepth === null || utilization === null || batchTTL === null) return null;
  if (typeof raw.usable !== "boolean") return null;
  return {
    depth,
    bucketDepth,
    utilization,
    batchTTL,
    usable: raw.usable,
    immutable: typeof raw.immutableFlag === "boolean" ? raw.immutableFlag : null,
  };
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Enough to identify a batch in a log, never enough to be the batch. */
function batchLabel(batchId: string): string {
  return `${batchId.slice(0, 12)}…`;
}

// ---------------------------------------------------------------------------
// Transition-only logging
// ---------------------------------------------------------------------------

export type Logger = (line: string) => void;

const lastVerdict = new Map<string, Verdict>();

/**
 * One line at boot, one per crossing, and nothing at all in between.
 *
 * A warning on every tick is a warning nobody reads by the second day, which is
 * the same as no alarm — and the point of this whole change is that the three
 * postage near-misses were all found by hand.
 */
function noteVerdict(name: string, check: Check, log: Logger): void {
  if (lastVerdict.has(name) && lastVerdict.get(name) === check.ok) return;
  lastVerdict.set(name, check.ok);
  const word = check.ok === true ? "ok" : check.ok === false ? "ALARM" : "unknown";
  log(`[health] ${name}: ${word}${check.reason ? ` — ${check.reason}` : ""}`);
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

export async function refreshPaymaster(readers: HealthReaders = liveReaders, log: Logger = console.warn): Promise<void> {
  try {
    paymasterReading = { at: Date.now(), value: await readers.deposit(), error: null };
  } catch (err) {
    paymasterReading = { at: Date.now(), value: null, error: msg(err) };
  }
  noteVerdict("paymaster", paymasterHealth(), log);
}

export async function refreshPostage(
  readers: HealthReaders = liveReaders,
  log: Logger = console.warn,
  includeEtherna = true,
): Promise<void> {
  if (POSTAGE_BATCH_ID) {
    try {
      const parsed = parseStamp(await readers.beeStamp(POSTAGE_BATCH_ID));
      beeReading = parsed
        ? { at: Date.now(), value: parsed, error: null }
        : { at: Date.now(), value: null, error: "stamp response was missing fields" };
    } catch (err) {
      beeReading = { at: Date.now(), value: null, error: msg(err) };
    }
    try {
      const raw = await readers.chainstate();
      const block = num(raw.block);
      const chainTip = num(raw.chainTip);
      chainstateReading =
        block !== null && chainTip !== null
          ? { at: Date.now(), value: { block, chainTip }, error: null }
          : { at: Date.now(), value: null, error: "chainstate response was missing fields" };
    } catch (err) {
      chainstateReading = { at: Date.now(), value: null, error: msg(err) };
    }
  }

  const ethernaBatch = process.env.ETHERNA_PLATFORM_BATCH ?? "";
  if (includeEtherna && ethernaBatch && process.env.ETHERNA_API_KEY) {
    try {
      const parsed = parseStamp(await readers.ethernaStamp(ethernaBatch));
      ethernaReading = parsed
        ? { at: Date.now(), value: parsed, error: null }
        : { at: Date.now(), value: null, error: "stamp response was missing fields" };
    } catch (err) {
      ethernaReading = { at: Date.now(), value: null, error: msg(err) };
    }
  }

  const section = postageHealth();
  noteVerdict("postage.bee.ttl", section.bee.checks.ttl, log);
  noteVerdict("postage.bee.utilization", section.bee.checks.utilization, log);
  noteVerdict("postage.bee.usable", section.bee.checks.usable, log);
  noteVerdict("postage.chain", section.chain, log);
  if (section.etherna.configured) noteVerdict("postage.etherna", section.etherna, log);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export interface PaymasterSection extends Check {
  stale: boolean;
  checkedAt: string | null;
  chainId: number;
  address: string;
  entryPoint: string;
  depositEth: string | null;
  minEth: string;
  configError?: string;
  error?: string;
  note: string;
}

export function paymasterHealth(now: number = Date.now()): PaymasterSection {
  const { paymaster: cfg } = readThresholdsFromEnv(process.env);
  const verdict = evaluatePaymaster({
    depositWei: paymasterReading.value,
    minWei: parseEther(cfg.minEth),
    reason: paymasterReading.error,
  });
  return {
    ...verdict,
    stale: isStale(paymasterReading.at, now, PROBE_INTERVAL_MS),
    checkedAt: paymasterReading.at === null ? null : new Date(paymasterReading.at).toISOString(),
    chainId: KERNEL_CHAIN_ID,
    address: SELF_FUNDED_PAYMASTER_ADDRESS,
    entryPoint: ENTRY_POINT_V07_ADDRESS,
    depositEth: paymasterReading.value === null ? null : formatEther(paymasterReading.value),
    minEth: cfg.minEth,
    ...(cfg.configError ? { configError: cfg.configError } : {}),
    ...(paymasterReading.error ? { error: paymasterReading.error } : {}),
    note: PAYMASTER_NOTE,
  };
}

interface StampSection {
  batch: string | null;
  depth: number | null;
  bucketDepth: number | null;
  utilization: number | null;
  bucketCap: number | null;
  batchTTL: number | null;
  batchTTLDays: number | null;
  usable: boolean | null;
  immutable: boolean | null;
  checks: Pick<StampVerdicts, "ttl" | "utilization" | "usable">;
  ok: Verdict;
  reason?: string;
  error?: string;
}

export interface PostageSection {
  ok: Verdict;
  stale: boolean;
  checkedAt: string | null;
  thresholds: { ttlMinSeconds: number; utilizationMaxPct: number; chainLagMaxBlocks: number };
  bee: StampSection;
  chain: Check & { block: number | null; chainTip: number | null; lag: number | null };
  etherna: StampSection & { configured: boolean; checkedAt: string | null; stale: boolean };
  configError?: string;
}

const unread = (reason: string): Pick<StampVerdicts, "ttl" | "utilization" | "usable"> => ({
  ttl: { ok: null, reason },
  utilization: { ok: null, reason },
  usable: { ok: null, reason },
});

function stampSection(reading: Reading<StampReading & { immutable: boolean | null }>, batchId: string, t: {
  ttlMinSeconds: number;
  utilizationMaxPct: number;
  chainLagMaxBlocks: number;
}): StampSection {
  if (!batchId) {
    const reason = "batch id not configured";
    return {
      batch: null, depth: null, bucketDepth: null, utilization: null, bucketCap: null,
      batchTTL: null, batchTTLDays: null, usable: null, immutable: null,
      checks: unread(reason), ok: null, reason,
    };
  }
  if (reading.value === null) {
    const reason = reading.error ?? "not read yet";
    return {
      batch: batchLabel(batchId), depth: null, bucketDepth: null, utilization: null, bucketCap: null,
      batchTTL: null, batchTTLDays: null, usable: null, immutable: null,
      checks: unread(reason), ok: null, reason,
      ...(reading.error ? { error: reading.error } : {}),
    };
  }
  const v = evaluateStamp(reading.value, t);
  return {
    batch: batchLabel(batchId),
    depth: reading.value.depth,
    bucketDepth: reading.value.bucketDepth,
    utilization: reading.value.utilization,
    bucketCap: v.bucketCap,
    batchTTL: reading.value.batchTTL,
    batchTTLDays: v.batchTTLDays,
    usable: reading.value.usable,
    immutable: reading.value.immutable,
    checks: { ttl: v.ttl, utilization: v.utilization, usable: v.usable },
    ok: v.ok,
  };
}

export function postageHealth(now: number = Date.now()): PostageSection {
  const { postage: cfg } = readThresholdsFromEnv(process.env);
  const thresholds = {
    ttlMinSeconds: cfg.ttlMinSeconds,
    utilizationMaxPct: cfg.utilizationMaxPct,
    chainLagMaxBlocks: cfg.chainLagMaxBlocks,
  };

  const bee = stampSection(beeReading, POSTAGE_BATCH_ID, thresholds);
  const block = chainstateReading.value?.block ?? null;
  const chainTip = chainstateReading.value?.chainTip ?? null;
  const chain = {
    ...evaluateChainLag(
      {
        block,
        chainTip,
        reason: chainstateReading.error ?? (POSTAGE_BATCH_ID ? null : "chainstate probe idle: no batch configured"),
      },
      cfg.chainLagMaxBlocks,
    ),
    block,
    chainTip,
  };

  const ethernaBatch = process.env.ETHERNA_PLATFORM_BATCH ?? "";
  const configured = Boolean(ethernaBatch) && Boolean(process.env.ETHERNA_API_KEY);
  const etherna = {
    ...(configured
      ? stampSection(ethernaReading, ethernaBatch, thresholds)
      : {
          ...stampSection(ethernaReading, "", thresholds),
          reason: "ETHERNA_PLATFORM_BATCH or ETHERNA_API_KEY not set",
        }),
    configured,
    checkedAt: ethernaReading.at === null ? null : new Date(ethernaReading.at).toISOString(),
    stale: configured && isStale(ethernaReading.at, now, ETHERNA_PROBE_INTERVAL_MS),
  };

  // An UNCONFIGURED Etherna batch is deliberately left out of the roll-up. It is
  // "not applicable", not "could not be read", and folding it in would pin
  // `postage.ok` to null forever on a bee-only deployment — an alarm that is
  // permanently unknown is an alarm nobody watches.
  const checks: Array<{ ok: Verdict }> = [bee, chain, ...(configured ? [etherna] : [])];

  return {
    ok: combine(checks),
    stale: isStale(beeReading.at, now, PROBE_INTERVAL_MS),
    checkedAt: beeReading.at === null ? null : new Date(beeReading.at).toISOString(),
    thresholds,
    bee,
    chain,
    etherna,
    ...(cfg.configError ? { configError: cfg.configError } : {}),
  };
}

/**
 * Bee batch state for the evidence publisher (#312), served from THIS module's
 * cache.
 *
 * The publisher used to run its own five-minute stamp fetch. Two probes reading
 * the same batch on two clocks can disagree about whether it is alive, and the
 * one that answers "fine" is the one that holds off nothing — so there is one
 * read and one cache. Refreshes on demand only if the timer is not running.
 */
export async function beeBatchState(): Promise<{ usable: boolean | null; ttl: number | null }> {
  if (beeReading.at === null || Date.now() - beeReading.at > ETHERNA_PROBE_INTERVAL_MS) {
    await refreshPostage(liveReaders, console.warn, false);
  }
  return { usable: beeReading.value?.usable ?? null, ttl: beeReading.value?.batchTTL ?? null };
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let ethernaDueAt = 0;

export function startHealthProbes(): void {
  if (timer) return;
  const tick = () => {
    const etherna = Date.now() >= ethernaDueAt;
    if (etherna) ethernaDueAt = Date.now() + ETHERNA_PROBE_INTERVAL_MS;
    void refreshPaymaster().catch((err) => console.warn("[health] paymaster probe threw:", err));
    void refreshPostage(liveReaders, console.warn, etherna).catch((err) =>
      console.warn("[health] postage probe threw:", err),
    );
  };
  tick();
  timer = setInterval(tick, PROBE_INTERVAL_MS);
  timer.unref?.();
  console.log("[health] postage + paymaster probes started");
}

/** Tests only. */
export function __resetHealthProbes(): void {
  if (timer) clearInterval(timer);
  timer = null;
  ethernaDueAt = 0;
  paymasterReading = empty<bigint>();
  beeReading = empty<StampReading & { immutable: boolean | null }>();
  chainstateReading = empty<{ block: number; chainTip: number }>();
  ethernaReading = empty<StampReading & { immutable: boolean | null }>();
  lastVerdict.clear();
  provider = null;
}
