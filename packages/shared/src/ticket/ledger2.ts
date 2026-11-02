/**
 * WoCoTicketLedger version 2: what an account's own browser needs to move its events'
 * organiser key (`crypto/organiser-key.ts`), and what the server's sponsorship rules
 * check that call against (`apps/server/src/lib/zerodev/sponsor-policy.ts`).
 *
 * The address lives HERE, not in server env alone, so a browser re-pointing its events
 * takes it from the code it runs rather than from a server reply. Empty until the Safe
 * deploy: fill it in the same change that sets the server's ledger2 env, or the
 * server's override and this disagree (the server refuses to boot when they do).
 */

export interface Ledger2Deployment {
  /** Lowercase. */
  address: string;
  /** The block the ledger was deployed in: no log of it predates this, so scans start here. */
  deployBlock: number;
}

/** Deployed WoCoTicketLedger v2 by chain id. Fill both fields from the deploy receipt. */
export const LEDGER2_DEPLOYMENTS: Readonly<Record<number, Ledger2Deployment>> = {};

/** Deployed WoCoTicketLedger v2 by chain id, lowercase. */
export const TICKET_LEDGER2_ADDRESSES: Readonly<Record<number, string>> = Object.fromEntries(
  Object.entries(LEDGER2_DEPLOYMENTS).map(([chainId, d]) => [Number(chainId), d.address]),
);

export const SET_ORGANISER_KEY_FN = "function setOrganiserKey(bytes32[] eventIds, address key)" as const;

/** The reads that decide which events a key move covers. */
export const LEDGER2_ORGANISER_KEY_READ_ABI = [
  "function getEvent(bytes32 eventId) view returns (uint64 totalSupply, uint64 nextSlot, address organiser, bytes32 manifestRef)",
  "function getEventStatus(bytes32 eventId) view returns (uint64 eventEndTs, bool cancelled)",
  "function getOrganiserKey(bytes32 eventId) view returns (address)",
  "error EventNotFound()",
] as const;

/**
 * The two logs an account's events are found by, from the chain alone (no platform
 * index): every event registered naming it as organiser, and every sponsor the owner
 * ever added (the registrants whose registrations are real, below).
 */
export const LEDGER2_REGISTERED_EVENT =
  "event Registered(bytes32 indexed eventId, address indexed organiser, address indexed registrant, uint64 supply, bytes32 manifestRef, uint64 eventEndTs)" as const;
export const LEDGER2_SPONSOR_ADDED_EVENT = "event SponsorAdded(address indexed sponsor)" as const;

/**
 * Events re-pointed in ONE operation. Bounds the gas of the passkey-removal operation
 * that carries the move (roughly 30k gas an event), so the removal stays well inside
 * the sponsorship's per-operation ceiling; the rest follow in operations of their own.
 */
export const MAX_ORGANISER_KEY_IDS = 50;

/**
 * Events the removal's own op carries - fewer than one op may. That op also renews the
 * co-owner list and moves the key ring, and a refusal at the gas ceiling while fees are
 * up would refuse the REMOVAL with it (Fable sign-off 2026-11-02); the rest follow in
 * the after-step's own ops, which can wait for fees without blocking anything.
 */
export const ORGANISER_KEY_IDS_WITH_FLIP = 20;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const ZERO_ID = `0x${"0".repeat(64)}`;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

/** The ledger v2 address on `chainId`, or null when it is not deployed there. */
export function ticketLedger2Address(chainId: number): string | null {
  return TICKET_LEDGER2_ADDRESSES[chainId] ?? null;
}

/** The ledger v2 deployment on `chainId`, or null when it is not deployed there. */
export function ticketLedger2Deployment(chainId: number): Ledger2Deployment | null {
  return LEDGER2_DEPLOYMENTS[chainId] ?? null;
}

/**
 * A build's ledger override, `address` or `address:deployBlock` (dev and sandbox, where
 * the shared table is empty). Without a block the scan starts at 0: slow, never short
 * an event. Null when it is not a well-formed override.
 */
export function parseLedger2Override(raw: string | null | undefined): Ledger2Deployment | null {
  const v = raw?.trim().toLowerCase();
  if (!v) return null;
  const [address, block] = v.split(":");
  if (!address || !ADDRESS.test(address)) return null;
  if (block === undefined) return { address, deployBlock: 0 };
  if (!/^\d+$/.test(block)) return null;
  return { address, deployBlock: Number(block) };
}

/**
 * A key move WoCo sends: 1..MAX distinct, non-zero ids, and a key that is neither zero
 * nor the ledger. The contract skips an id already on the key and reverts the batch on
 * an id that is not the caller's, so the sender reads each id first.
 */
export function isValidOrganiserKeyMove(ledger: string, ids: readonly string[], key: string): boolean {
  const l = ledger.toLowerCase();
  const k = key.toLowerCase();
  if (!ADDRESS.test(l) || !ADDRESS.test(k) || k === ZERO_ADDRESS || k === l) return false;
  if (ids.length === 0 || ids.length > MAX_ORGANISER_KEY_IDS) return false;
  const seen = new Set<string>();
  for (const id of ids) {
    const v = id.toLowerCase();
    if (!BYTES32.test(v) || v === ZERO_ID || seen.has(v)) return false;
    seen.add(v);
  }
  return true;
}

/** One event as the ledger reads it now: the live truth a key move is planned from. */
export interface OrganiserKeyEventState {
  id: string;
  organiser: string;
  key: string;
  eventEndTs: number;
  cancelled: boolean;
  /** Tickets minted so far. */
  nextSlot: number;
}

/** One call's answer in a multicall that allows failure (viem's shape). */
export type MulticallResult = { status: "success"; result: unknown } | { status: "failure"; error: unknown };

/**
 * The live states from a multicall of [getEvent, getEventStatus, getOrganiserKey] per id,
 * in `ids` order. An id the ledger does not know (`isNotFound` on its getEvent) is left
 * out: it is not an event to move, so it must not keep a catch-up pending for ever. Any
 * other failure is "error" - unread is never "nothing to move".
 */
export function organiserKeyStatesFrom(
  ids: readonly string[],
  res: readonly MulticallResult[],
  isNotFound: (error: unknown) => boolean,
): OrganiserKeyEventState[] | "error" {
  if (res.length !== ids.length * 3) return "error";
  const out: OrganiserKeyEventState[] = [];
  for (let i = 0; i < ids.length; i++) {
    const [ev, status, key] = [res[3 * i]!, res[3 * i + 1]!, res[3 * i + 2]!];
    if (ev.status === "failure" && isNotFound(ev.error)) continue;
    if (ev.status !== "success" || status.status !== "success" || key.status !== "success") return "error";
    const [, nextSlot, organiser] = ev.result as readonly [bigint, bigint, string, string];
    const [eventEndTs, cancelled] = status.result as readonly [bigint, boolean];
    out.push({
      id: ids[i]!.toLowerCase(),
      organiser: organiser.toLowerCase(),
      key: (key.result as string).toLowerCase(),
      eventEndTs: Number(eventEndTs),
      cancelled,
      nextSlot: Number(nextSlot),
    });
  }
  return out;
}

/**
 * Which events move onto `newKey`, in the order they should: only the account's own
 * (`organiser`), never a cancelled one (every terms action refuses it), never one
 * already there. Still on sale first, the busiest first - where a removed device
 * cancelling, moving seats or changing supply hurts most - then ended ones, which still
 * move: every other terms action refuses an ended event, but `cancelEvent` has no cutoff,
 * so an old key could still cancel one.
 */
export function planOrganiserKeyMoves(
  states: readonly OrganiserKeyEventState[],
  organiser: string,
  newKey: string,
  nowSeconds: number,
): string[] {
  const o = organiser.toLowerCase();
  const k = newKey.toLowerCase();
  return states
    .filter((s) => s.organiser.toLowerCase() === o && !s.cancelled && s.key.toLowerCase() !== k)
    .map((s) => ({ s, ended: s.eventEndTs <= nowSeconds ? 1 : 0 }))
    .sort((a, b) => a.ended - b.ended || b.s.nextSlot - a.s.nextSlot)
    .map(({ s }) => s.id.toLowerCase());
}
