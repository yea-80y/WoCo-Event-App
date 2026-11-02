/**
 * `/api/health` -> `ledger2Relay`: whether WoCo can submit what organisers sign for
 * their ledger2 events (capacity, sales cutoff, seat moves, cancels), and any event
 * the chain says is cancelled while the server's own record still sells it.
 *
 * Inert, and green, while no ledger2 is deployed on the active chain. Once one is:
 * red when the relay key is unset or shared, its gas below `LEDGER2_RELAY_MIN_ETH`, the
 * code at Multicall3 or the ledger not what the relay expects, or a chain-cancelled
 * event is still open in the server's record (the organiser confirms it from the
 * dashboard; nothing writes the money path's record from a chain read).
 * Public data only: addresses, a balance, event ids.
 */

import { formatEther, parseEther } from "ethers";
import { combine, isStale, readThresholdsFromEnv, type Check, type Verdict } from "./alarms.js";
import { getActiveChainId, ledger2Address } from "../chain/event-contract.js";
import {
  readRelayBalance,
  relayAddress,
  relayKeyConflict,
  verifyRelayCode,
} from "../chain/ledger2-relay-chain.js";
import { cancellationGate } from "../event/cancellations.js";
import { chainCancelledUnrecorded } from "../event/ledger2-sale-status.js";

const PROBE_INTERVAL_MS = 60_000;

interface Reading<T> {
  at: number | null;
  value: T | null;
  error: string | null;
}

let balance: Reading<bigint> = { at: null, value: null, error: null };
let code: Reading<{ ok: boolean; reason?: string }> = { at: null, value: null, error: null };

function target(): { chainId: number; ledger: string } | null {
  try {
    const chainId = getActiveChainId();
    const ledger = ledger2Address(chainId);
    return ledger ? { chainId, ledger } : null;
  } catch {
    return null;
  }
}

function keySet(): boolean {
  return !!process.env.LEDGER2_RELAY_PRIVATE_KEY?.trim();
}

export async function refreshLedger2Relay(): Promise<void> {
  const t = target();
  if (!t || !keySet() || relayKeyConflict()) return;
  try {
    balance = { at: Date.now(), value: await readRelayBalance(t.chainId), error: null };
  } catch (err) {
    balance = { at: Date.now(), value: null, error: (err as { shortMessage?: string }).shortMessage ?? "read failed" };
  }
  try {
    const c = await verifyRelayCode(t.chainId, t.ledger);
    code = { at: Date.now(), value: c.ok ? { ok: true } : { ok: false, reason: c.reason }, error: null };
  } catch (err) {
    code = { at: Date.now(), value: null, error: (err as { shortMessage?: string }).shortMessage ?? "read failed" };
  }
}

export interface Ledger2RelaySection {
  ok: Verdict;
  /** A ledger2 is deployed on the active chain; false = nothing to relay, always green. */
  active: boolean;
  chainId: number | null;
  ledger: string | null;
  relay: string | null;
  balanceEth: string | null;
  minEth: string;
  chainCancelledUnrecorded: Array<{ eventId: string; onChainEventId: string; seenAt: string }>;
  checks: { key: Check; balance: Check; code: Check; chainCancelled: Check };
  stale: boolean;
  checkedAt: string | null;
  configError?: string;
}

export function ledger2RelayHealth(now: number = Date.now()): Ledger2RelaySection {
  const { ledger2Relay: cfg } = readThresholdsFromEnv(process.env);
  const t = target();
  const unrecorded = chainCancelledUnrecorded((eventId) => cancellationGate(eventId) === "open");
  const chainCancelled: Check = unrecorded.length === 0
    ? { ok: true }
    : { ok: false, reason: "an event is cancelled on chain but still on sale in the server's record - the organiser confirms it from the dashboard" };
  const base = {
    chainId: t?.chainId ?? null,
    ledger: t?.ledger ?? null,
    minEth: cfg.minEth,
    chainCancelledUnrecorded: unrecorded,
    ...(cfg.configError ? { configError: cfg.configError } : {}),
  };
  if (!t) {
    const idle: Check = { ok: true };
    return {
      ...base,
      ok: combine([chainCancelled]),
      active: false,
      relay: null,
      balanceEth: null,
      checks: { key: idle, balance: idle, code: idle, chainCancelled },
      stale: false,
      checkedAt: null,
    };
  }

  const conflict = relayKeyConflict();
  const key: Check = !keySet()
    ? { ok: false, reason: "LEDGER2_RELAY_PRIVATE_KEY is not set - organisers cannot change capacity, dates or seats, or cancel on chain" }
    : conflict
      ? { ok: false, reason: conflict }
      : { ok: true };
  let relay: string | null = null;
  try {
    relay = key.ok ? relayAddress() : null;
  } catch {
    relay = null;
  }
  const balanceCheck: Check = !key.ok
    ? { ok: false, reason: key.reason }
    : balance.value === null
      ? { ok: null, reason: balance.error ?? "relay balance not read yet" }
      : balance.value < parseEther(cfg.minEth)
        ? { ok: false, reason: "relay key below minimum - organisers' signed changes will stop being submitted" }
        : { ok: true };
  const codeCheck: Check = !key.ok
    ? { ok: false, reason: key.reason }
    : code.value === null
      ? { ok: null, reason: code.error ?? "contract code not checked yet" }
      : code.value.ok
        ? { ok: true }
        : { ok: false, reason: `${code.value.reason} - every relay is refused` };

  const reads = [balance.at, code.at];
  const oldest = reads.some((at) => at === null) ? null : Math.min(...(reads as number[]));
  return {
    ...base,
    ok: combine([key, balanceCheck, codeCheck, chainCancelled]),
    active: true,
    relay,
    balanceEth: balance.value === null ? null : formatEther(balance.value),
    checks: { key, balance: balanceCheck, code: codeCheck, chainCancelled },
    stale: key.ok ? isStale(oldest, now, PROBE_INTERVAL_MS) : false,
    checkedAt: oldest === null ? null : new Date(oldest).toISOString(),
  };
}

/** Tests only. */
export function _resetLedger2RelayHealthForTests(): void {
  balance = { at: null, value: null, error: null };
  code = { at: null, value: null, error: null };
}
