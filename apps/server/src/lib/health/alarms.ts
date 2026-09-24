/**
 * Pure verdicts for the `/api/health` postage, paymaster, ENS-parent, sub-ENS
 * minting and ticket minting alarms (#421, #522, #420, #598, #662).
 *
 * No network, no clock of its own, no env reads beyond the one function that
 * exists to read env. Everything here is a function of its arguments, so the
 * rules that decide "is this an alarm" can be tested without a bee, an RPC or a
 * timer — and so a mutation to one of them is visibly red.
 *
 * THREE VERDICTS, NEVER TWO. `ok` is `true | false | null`, and `null` means
 * the probe could not read. Collapsing an unreadable probe into `true` is the
 * 2026-08-10 failure exactly: a bee behind on the postage contract answered
 * confidently, stamped a day of uploads against a batch that was already dead,
 * and every upload returned 200. Collapsing it into `false` is no better — it
 * cries wolf until nobody reads the endpoint. Unknown is its own answer.
 */

import { ENS_GRACE_PERIOD_DAYS } from "@woco/shared";

/** `true` = healthy, `false` = alarm, `null` = could not read. */
export type Verdict = true | false | null;

export interface Check {
  ok: Verdict;
  /** Short, operator-facing, no values that are secret. Present unless `ok`. */
  reason?: string;
}

export interface Thresholds {
  ttlMinSeconds: number;
  utilizationMaxPct: number;
  chainLagMaxBlocks: number;
}

export interface ThresholdConfig {
  paymaster: { minEth: string; configError?: string };
  postage: Thresholds & { configError?: string };
  ensParent: { minDays: number; configError?: string };
  subEnsMinting: { sponsorMinEth: string; configError?: string };
  ticketMinting: { minMintable: number; configError?: string };
}

export const DEFAULT_PAYMASTER_MIN_ETH = "0.0005";
export const DEFAULT_TTL_MIN_SECONDS = 604_800;
export const DEFAULT_UTILIZATION_MAX_PCT = 90;
export const DEFAULT_CHAIN_LAG_MAX_BLOCKS = 720;
/**
 * WHY 120 DAYS AND NOT 30. Renewing `woco.eth` is a MANUAL transaction from the
 * Safe — it needs a human, a signer quorum and mainnet gas, none of which are
 * available on demand. Firing four months out means the alarm sounds a full
 * month before the 90-day grace period would even begin, so an alarm that is
 * missed, ignored over a holiday, or read by somebody who cannot sign still has
 * the entire grace period behind it before a single `*.woco.eth` name stops
 * resolving. A 30-day threshold would spend that margin on nothing.
 */
export const DEFAULT_ENS_EXPIRY_MIN_DAYS = 120;
/**
 * The sponsor wallet's floor on the sub-ENS chain (#598). About 25M gas at
 * Arbitrum One's 0.02 gwei (2026-09-19): roughly 80-100 sponsored mints, or
 * about 20 relayed releases at their padded worst case. The same order as the
 * paymaster's floor, and for the same reason — enough warning to top up by
 * hand before anyone notices.
 */
export const DEFAULT_SUB_ENS_SPONSOR_MIN_ETH = "0.0005";
/**
 * The ticket sponsor's mint headroom floor (#662): the largest order
 * create-checkout accepts. Below it, the next maximum order is already refused,
 * so the alarm fires before a buyer finds out rather than after. A Safe cap set
 * below this keeps the alarm on — deliberately: such a cap refuses every order
 * that size, every hour.
 */
export const DEFAULT_TICKET_MINT_ALLOWANCE_MIN = 10;

/** A decimal ETH amount, no exponent, at most 18 decimals — `parseEther` fodder. */
const DECIMAL_ETH = /^\d+(\.\d{1,18})?$/;

function envInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  invalid: string[],
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    invalid.push(name);
    return fallback;
  }
  return n;
}

/**
 * Thresholds from env, with the defaults baked in.
 *
 * A bad value NEVER throws. Refusing to boot over a typo'd alarm threshold
 * would take the whole server down to protect a warning light; falling back
 * silently would leave an operator believing a threshold they set is in force.
 * So: fall back, and SAY SO in the section itself.
 */
function envEth(env: NodeJS.ProcessEnv, name: string, fallback: string, invalid: string[]): string {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (DECIMAL_ETH.test(raw.trim()) && Number(raw) > 0) return raw.trim();
  invalid.push(name);
  return fallback;
}

export function readThresholdsFromEnv(env: NodeJS.ProcessEnv): ThresholdConfig {
  const pmInvalid: string[] = [];
  const minEth = envEth(env, "PAYMASTER_DEPOSIT_MIN_ETH", DEFAULT_PAYMASTER_MIN_ETH, pmInvalid);

  const postInvalid: string[] = [];
  const ttlMinSeconds = envInt(env, "POSTAGE_TTL_MIN_SECONDS", DEFAULT_TTL_MIN_SECONDS, postInvalid);
  const utilizationMaxPct = envInt(env, "POSTAGE_UTILIZATION_MAX_PCT", DEFAULT_UTILIZATION_MAX_PCT, postInvalid);
  const chainLagMaxBlocks = envInt(env, "BEE_CHAIN_LAG_MAX_BLOCKS", DEFAULT_CHAIN_LAG_MAX_BLOCKS, postInvalid);

  const ensInvalid: string[] = [];
  const minDays = envInt(env, "ENS_EXPIRY_MIN_DAYS", DEFAULT_ENS_EXPIRY_MIN_DAYS, ensInvalid);

  const mintInvalid: string[] = [];
  const sponsorMinEth = envEth(env, "SUB_ENS_SPONSOR_MIN_ETH", DEFAULT_SUB_ENS_SPONSOR_MIN_ETH, mintInvalid);

  const ticketInvalid: string[] = [];
  const minMintable = envInt(env, "TICKET_MINT_ALLOWANCE_MIN", DEFAULT_TICKET_MINT_ALLOWANCE_MIN, ticketInvalid);

  return {
    paymaster: { minEth, configError: configError(pmInvalid) },
    postage: { ttlMinSeconds, utilizationMaxPct, chainLagMaxBlocks, configError: configError(postInvalid) },
    ensParent: { minDays, configError: configError(ensInvalid) },
    subEnsMinting: { sponsorMinEth, configError: configError(mintInvalid) },
    ticketMinting: { minMintable, configError: configError(ticketInvalid) },
  };
}

function configError(invalid: string[]): string | undefined {
  if (invalid.length === 0) return undefined;
  return `ignored (not a positive number), using default: ${invalid.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Paymaster
// ---------------------------------------------------------------------------

export function evaluatePaymaster(r: {
  depositWei: bigint | null;
  minWei: bigint;
  reason?: string | null;
}): Check {
  if (r.depositWei === null) {
    return { ok: null, reason: r.reason || "EntryPoint deposit could not be read" };
  }
  if (r.depositWei < r.minWei) {
    return { ok: false, reason: "EntryPoint deposit below minimum — Kernel userOps will start failing" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Postage batch
// ---------------------------------------------------------------------------

export interface StampReading {
  depth: number;
  bucketDepth: number;
  utilization: number;
  batchTTL: number;
  usable: boolean;
}

export interface StampVerdicts {
  /** Chunks one bucket can hold before the next write overwrites an older one. */
  bucketCap: number;
  batchTTLDays: number;
  ttl: Check;
  utilization: Check;
  usable: Check;
  ok: Verdict;
}

/**
 * Chunks per bucket at this depth. `utilization` is reported PER BUCKET by bee,
 * so the ceiling it is measured against is `2^(depth-bucketDepth)` — not `2^depth`,
 * which is the whole batch and would make a full bucket look like 0.001% used.
 */
export function bucketCapacity(depth: number, bucketDepth: number): number {
  return 2 ** (depth - bucketDepth);
}

/**
 * WHY TWO UTILIZATION RULES. A percentage cannot express "one slot left": on an
 * 8-slot bucket, 7/8 is 87.5% and sails under a 90% threshold, yet the very next
 * chunk into that bucket overwrites an older one — silently, because the batch is
 * mutable (`immutableFlag: false`) and bee returns 200 either way. So the
 * absolute rule (`>= cap - 1`) is what actually catches the small-bucket case,
 * and the percentage is what catches the large-bucket one. Either fires.
 */
export function evaluateStamp(s: StampReading, t: Thresholds): StampVerdicts {
  const bucketCap = bucketCapacity(s.depth, s.bucketDepth);
  const pctCeiling = Math.ceil((bucketCap * t.utilizationMaxPct) / 100);
  const full = s.utilization >= bucketCap - 1 || s.utilization >= pctCeiling;

  const utilization: Check = full
    ? {
        ok: false,
        reason: `bucket ${s.utilization}/${bucketCap} — dilute now, a full bucket overwrites older chunks without an error`,
      }
    : { ok: true };

  const ttl: Check =
    s.batchTTL <= 0
      ? { ok: false, reason: "batch has expired — every write is unpaid" }
      : s.batchTTL < t.ttlMinSeconds
        ? { ok: false, reason: `batch expires in ${daysOf(s.batchTTL)}d — top up` }
        : { ok: true };

  const usable: Check = s.usable ? { ok: true } : { ok: false, reason: "bee reports the batch unusable" };

  return { bucketCap, batchTTLDays: daysOf(s.batchTTL), ttl, utilization, usable, ok: combine([ttl, utilization, usable]) };
}

function daysOf(seconds: number): number {
  return Math.round((seconds / 86_400) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Bee chain lag
// ---------------------------------------------------------------------------

/**
 * A bee behind the postage contract answers every stamp question from stale
 * state, so the lag is not a statistic about the node — it is the confidence
 * interval on every other verdict in this section (#421, 2026-08-10).
 */
export function evaluateChainLag(
  r: { block: number | null; chainTip: number | null; reason?: string | null },
  maxLag: number,
): Check & { lag: number | null } {
  if (r.block === null || r.chainTip === null) {
    return { ok: null, reason: r.reason || "chainstate could not be read", lag: null };
  }
  const lag = Math.max(0, r.chainTip - r.block);
  if (lag > maxLag) {
    return { ok: false, reason: `bee is ${lag} blocks behind the chain — its postage answers are stale`, lag };
  }
  return { ok: true, lag };
}

// ---------------------------------------------------------------------------
// ENS parent registration (#420)
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

export interface EnsExpiryVerdict extends Check {
  /** ISO instant the registration lapses, or null when there is no reading. */
  expiresAt: string | null;
  /** Signed, one decimal. Negative means the name is already in its grace. */
  daysRemaining: number | null;
  /** Expiry + the 90-day owner-only grace: when records actually stop. */
  graceEndsAt: string | null;
}

const NO_READING = { expiresAt: null, daysRemaining: null, graceEndsAt: null } as const;

/**
 * Is `woco.eth` renewed far enough ahead that a human can still act?
 *
 * WHY PAST-EXPIRY IS `false` AND NOT A SECOND VERDICT. The 90-day grace is a
 * margin, not a state to be relaxed about: during it the name resolves exactly
 * as before, so nothing an operator can SEE changes until the day it releases
 * and every `*.woco.eth` name — the app's own frontend included — goes dark at
 * once. An alarm that softened once the deadline passed would be loudest while
 * there was still a year of slack and quietest at the moment of maximum danger.
 * `graceEndsAt` is what says how long the door stays open.
 *
 * WHY ZERO IS AN ALARM AND NOT AN UNKNOWN. `BaseRegistrar.nameExpires` answers
 * 0 for a label it has never issued. For the label WE hardcode that is a
 * positive statement with exactly two causes, and both are alarms: the name was
 * released, or the watch is reading the wrong label and has been green about
 * nothing.
 */
export function evaluateEnsExpiry(r: {
  expiresAtSec: bigint | null;
  minDays: number;
  /** Milliseconds. Passed in, never read from the clock, so this stays pure. */
  now: number;
  reason?: string | null;
}): EnsExpiryVerdict {
  if (r.expiresAtSec === null) {
    return { ok: null, reason: r.reason || "registrar could not be read", ...NO_READING };
  }
  if (r.expiresAtSec === 0n) {
    return { ok: false, reason: "not registered", ...NO_READING };
  }

  const expiresAtMs = Number(r.expiresAtSec) * 1000;
  const graceEndsAtMs = expiresAtMs + ENS_GRACE_PERIOD_DAYS * MS_PER_DAY;
  // Rounded to a tenth of a day, and the verdict is taken on the SAME number the
  // section publishes — so the figure an operator reads always explains it.
  const daysRemaining = Math.round(((expiresAtMs - r.now) / MS_PER_DAY) * 10) / 10;
  const reading = {
    expiresAt: new Date(expiresAtMs).toISOString(),
    daysRemaining,
    graceEndsAt: new Date(graceEndsAtMs).toISOString(),
  };

  if (r.now >= graceEndsAtMs) {
    return {
      ok: false,
      reason: `RELEASED — expired ${Math.abs(daysRemaining)}d ago and past the ${ENS_GRACE_PERIOD_DAYS}-day grace; the name is registrable by anyone`,
      ...reading,
    };
  }
  if (daysRemaining < 0) {
    return {
      ok: false,
      reason: `EXPIRED ${Math.abs(daysRemaining)}d ago — owner-only renewal until ${reading.graceEndsAt}, records still resolve until then`,
      ...reading,
    };
  }
  if (daysRemaining < r.minDays) {
    return {
      ok: false,
      reason: `expires in ${daysRemaining}d — renew from the Safe, one mainnet transaction`,
      ...reading,
    };
  }
  return { ok: true, ...reading };
}

// ---------------------------------------------------------------------------
// Sub-ENS minting (#598)
// ---------------------------------------------------------------------------

/**
 * Whether the registry still lists WoCoRegistrar. Registry v2.2 ends EVERY
 * registrar grant when the admin seat changes hands, so a handover whose batch
 * forgot `addRegistrar` stops new names and name updates — while every
 * existing name keeps resolving, which is exactly why it would go unnoticed.
 */
export function evaluateRegistrarEnrolled(r: { enrolled: boolean | null; reason?: string | null }): Check {
  if (r.enrolled === null) return { ok: null, reason: r.reason || "registrar enrolment could not be read" };
  if (!r.enrolled) {
    return {
      ok: false,
      reason:
        "WoCoRegistrar is not enrolled in the registry — new names and name updates are refused. After an admin handover the new admin must addRegistrar(WoCoRegistrar)",
    };
  }
  return { ok: true };
}

/** The names sponsor pays for every mint and every relayed pointer write and release. */
export function evaluateSponsorBalance(r: { balanceWei: bigint | null; minWei: bigint; reason?: string | null }): Check {
  if (r.balanceWei === null) return { ok: null, reason: r.reason || "sponsor balance could not be read" };
  if (r.balanceWei < r.minWei) {
    return {
      ok: false,
      reason: "names sponsor wallet below minimum on the sub-ENS chain — mints and relayed pointer writes and releases will start failing",
    };
  }
  return { ok: true };
}

/**
 * Whether the registrar still lists the key this server mints with. The Safe
 * can `removeSponsor` without telling this process (the leaked-key response),
 * and the wrong key in env reads healthy everywhere else until the first mint.
 */
export function evaluateSponsorAuthorised(r: { authorised: boolean | null; reason?: string | null }): Check {
  if (r.authorised === null) return { ok: null, reason: r.reason || "sponsor authorisation could not be read" };
  if (!r.authorised) {
    return {
      ok: false,
      reason: "the sponsor key is not an authorised sponsor on WoCoRegistrar — new names are refused",
    };
  }
  return { ok: true };
}

/** A registrar-wide mint window as `globalMintAllowance()` answers it. */
export interface GlobalMintReading {
  remaining: number;
  windowResetsAt: number;
}

/**
 * The registrar-wide mint cap (registrar v2.2). `remaining == 0` means names
 * are being refused for EVERYONE right now — and a cap tripped by nobody the
 * product can account for is the leaked-key detector (Fable sponsor-key
 * consult §3). `"unsupported"` is a registrar from before the cap: nothing to
 * watch, and not an unknown.
 */
export function evaluateGlobalMint(r: { reading: GlobalMintReading | "unsupported" | null; reason?: string | null }): Check {
  if (r.reading === null) return { ok: null, reason: r.reason || "registrar-wide mint allowance could not be read" };
  if (r.reading === "unsupported") return { ok: true };
  if (r.reading.remaining === 0) {
    return {
      ok: false,
      reason: "the registrar-wide mint cap is spent — every new name is refused until the window resets. If the product did not mint them, treat the names key as leaked",
    };
  }
  return { ok: true };
}

/**
 * The Coinbase Smart Wallet factory, at its canonical address and with its
 * pinned code, on the names' chain. A name minted to a CSW parent on a chain
 * where that account can never be deployed is a name nobody controls, so this
 * alarms only while Coinbase login is on (Fable sponsor-key consult §11.1).
 */
export function evaluateCswFactory(r: {
  codehash: string | null;
  expected: string;
  required: boolean;
  reason?: string | null;
}): Check {
  if (!r.required) return { ok: true };
  if (r.codehash === null) return { ok: null, reason: r.reason || "Coinbase Smart Wallet factory could not be read" };
  if (r.codehash.toLowerCase() !== r.expected.toLowerCase()) {
    return {
      ok: false,
      reason: "the Coinbase Smart Wallet factory is missing or different on the sub-ENS chain — a name minted to a Coinbase account there may be uncontrollable",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Ticket minting on the events contract (#662)
// ---------------------------------------------------------------------------

/** Whether the ticket sponsor is still on the events contract's allow-list. */
export function evaluateTicketSponsorAuthorised(r: { authorised: boolean | null; reason?: string | null }): Check {
  if (r.authorised === null) return { ok: null, reason: r.reason || "ticket sponsor authorisation could not be read" };
  if (!r.authorised) {
    return {
      ok: false,
      reason: "the ticket sponsor key is not an authorised sponsor on the events contract — every paid checkout is refused",
    };
  }
  return { ok: true };
}

/** `sponsorMintAllowance(sponsor)` as the ledger answers it. */
export interface TicketMintReading {
  perHour: number;
  mintable: number;
  windowResetsAt: number;
}

/**
 * The ticket sponsor's hourly mint headroom (WoCoTicketLedger, audit 959 M-1).
 * The cap is shared by every event the sponsor mints into, so one busy on-sale
 * can spend an hour another event's buyers then wait out (audit 960 L-7) — the
 * natspec's intended remedy is exactly this watch, and raising the cap.
 *
 * `"no-cap"` is a contract version without the cap (V1, V2): nothing to watch,
 * and not an unknown. `perHour` 0 is the owner's stop lever and always an
 * alarm; so is a window the product did not account for spending, which is
 * what a leaked sponsor key looks like from here.
 */
export function evaluateTicketMintAllowance(r: {
  reading: TicketMintReading | "no-cap" | null;
  min: number;
  reason?: string | null;
}): Check {
  if (r.reading === null) return { ok: null, reason: r.reason || "ticket sponsor mint allowance could not be read" };
  // An uncapped sponsor's `mintable` reads UNLIMITED_MINTS, so it clears the floor below.
  if (r.reading === "no-cap") return { ok: true };
  if (r.reading.perHour === 0) {
    return {
      ok: false,
      reason:
        "the events contract's mint cap for the ticket sponsor is 0 — the owner has stopped it, and every paid checkout is refused until setSponsorMintCap raises it",
    };
  }
  if (r.reading.mintable < r.min) {
    return {
      ok: false,
      reason:
        `${r.reading.mintable} of ${r.reading.perHour}/h left in the ticket sponsor's mint window (alarm below ${r.min}), ` +
        `resets ${new Date(r.reading.windowResetsAt * 1000).toISOString()} — larger orders are refused until then. ` +
        "If the product did not mint them, treat the ticket sponsor key as leaked",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Aggregation + freshness
// ---------------------------------------------------------------------------

/** False beats null beats true — an alarm is never masked by an unknown. */
export function combine(checks: ReadonlyArray<{ ok: Verdict }>): Verdict {
  if (checks.some((c) => c.ok === false)) return false;
  if (checks.some((c) => c.ok === null)) return null;
  return true;
}

/**
 * Three missed ticks and the reading stops being evidence.
 *
 * A check that cannot check is the failure mode #421 is actually about, so the
 * timer having died has to be visible ON the section rather than inferred from
 * a `checkedAt` an operator would have to subtract by hand.
 */
export function isStale(checkedAtMs: number | null, nowMs: number, intervalMs: number): boolean {
  if (checkedAtMs === null) return true;
  return nowMs - checkedAtMs >= intervalMs * 3;
}
