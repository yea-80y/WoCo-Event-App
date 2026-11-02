/**
 * Chain-end guard (#294).
 *
 * `WoCoEventV2.eventEndTs` is fixed at registration and has NO setter, while
 * the feed's `endDate` is freely editable — so an organiser who extends an
 * event keeps every UI and every feed-based gate selling tickets that 100% of
 * mints will refuse (`SalesClosed`), i.e. charge-then-auto-refund on every
 * post-end sale. Two halves close it:
 *
 *  - EDIT-TIME (option 1 of the issue): `update-meta` refuses an `endDate`
 *    that extends past any registered series' on-chain end, so an honest
 *    organiser learns the limit at the moment of the edit rather than from a
 *    stream of refunds.
 *  - SALE-TIME (option 2): create-checkout and the webhook consult the chain
 *    end directly, so a divergence that arrives any other way — a
 *    client-signed (Phase B) feed the organiser edits with their own key, a
 *    pre-fix edit — still refuses the charge before it happens.
 *
 * Before ledger2 the chain end is immutable, so it is memoized forever per
 * (chain, event id): after the first read the sale-time backstop costs ZERO RPCs.
 * A ledger2 end can move later, so it is memoized for a minute (below). Only
 * positive answers are cached — an `EventNotFound` may be a mis-cached id or a
 * wrong chain, and pinning it would make the guard permanently blind there.
 */

import {
  getOnChainEventEnd as realGetOnChainEventEnd,
  getOnChainEventEndAt as realGetOnChainEventEndAt,
  getActiveChainId,
  getEventContractVersion,
  contractKey,
  type EventContractTarget,
} from "../chain/event-contract.js";

/**
 * LEDGER2 MOVES IT (#995). On ledger2 the organiser can move the cutoff LATER
 * (`extendSalesEndWithSignature`, through our relay or anyone's), so its end is
 * remembered for {@link LEDGER2_END_TTL_MS} only, and dropped at once when our relay
 * lands an extension ({@link invalidateChainEnd}). Staleness errs safe: an
 * extension only moves the end later, so a stale value refuses a sale the chain
 * would take (a lost sale for up to a minute), never charges one it would refuse.
 * The sale path itself does not use this memo on ledger2: it reads the end fresh
 * with the supply (`lib/event/ledger2-sale-status.ts`). Every earlier version's end
 * has no setter and stays memoized for good.
 */
export const LEDGER2_END_TTL_MS = 60_000;

interface EndMemo {
  endMs: number;
  /** Epoch ms after which it is read again; Infinity for an end that cannot move. */
  until: number;
}

/** `${chainId}:${onChainEventId}` → registered end. */
const _endMemo = new Map<string, EndMemo>();
/**
 * `${chainId}:${contract}:${onChainEventId}` → registered end. Keyed by contract
 * as well (#563): V2 ids are not domain-separated by contract, so two contracts on
 * one chain can hold the same id with different ends.
 */
const _endMemoAt = new Map<string, EndMemo>();

function remember(memo: Map<string, EndMemo>, k: string, endMs: number, movable: boolean, now: number): void {
  memo.set(k, { endMs, until: movable ? now + LEDGER2_END_TTL_MS : Infinity });
}

function recall(memo: Map<string, EndMemo>, k: string, now: number): number | undefined {
  const hit = memo.get(k);
  if (!hit) return undefined;
  if (now >= hit.until) {
    memo.delete(k);
    return undefined;
  }
  return hit.endMs;
}

/** Our relay moved this registration's cutoff: forget the old one everywhere. */
export function invalidateChainEnd(contract: EventContractTarget, onChainEventId: string): void {
  const id = onChainEventId.toLowerCase();
  _endMemoAt.delete(`${contractKey(contract)}:${id}`);
  _endMemo.delete(`${contract.chainId}:${id}`);
}

/** Test seam — production always reads the real contract. */
export type ChainEndReader = typeof realGetOnChainEventEnd;
export type ChainEndReaderAt = typeof realGetOnChainEventEndAt;

/** Reset the memo (tests only). */
export function _resetChainEndMemoForTests(): void {
  _endMemo.clear();
  _endMemoAt.clear();
}

/**
 * `chainEventEndMs` on the contract a registration LIVES on — the money path's
 * form (#563): create-checkout and fulfilment pass the recorded contract, so an
 * old registration's end is read where it was registered, not on today's env
 * contract (where its id does not exist and the guard would go blind).
 */
export async function chainEventEndMsAt(
  contract: EventContractTarget,
  onChainEventId: string,
  read: ChainEndReaderAt = realGetOnChainEventEndAt,
  now: number = Date.now(),
): Promise<number | null> {
  const k = `${contractKey(contract)}:${onChainEventId.toLowerCase()}`;
  const hit = recall(_endMemoAt, k, now);
  if (hit !== undefined) return hit;
  const endSec = await read(contract, onChainEventId);
  if (endSec === null) return null;
  const endMs = endSec * 1000;
  remember(_endMemoAt, k, endMs, contract.version === "ledger2", now);
  return endMs;
}

/**
 * The registered on-chain sales end in epoch ms, or null when the chain has no
 * record (unregistered, or a V1 deployment). Throws on transport failure —
 * callers choose fail-open (sale-time backstop) or refuse (edit-time guard)
 * explicitly.
 */
export async function chainEventEndMs(
  onChainEventId: string,
  chainId: number = getActiveChainId(),
  read: ChainEndReader = realGetOnChainEventEnd,
  now: number = Date.now(),
  /** Skip the memo (still refreshing it): the edit-time guard on a ledger2 contract. */
  fresh = false,
): Promise<number | null> {
  const k = `${chainId}:${onChainEventId.toLowerCase()}`;
  const hit = fresh ? undefined : recall(_endMemo, k, now);
  if (hit !== undefined) return hit;
  const endSec = await read(onChainEventId, chainId);
  if (endSec === null) return null;
  const endMs = endSec * 1000;
  // This form reads the env-selected contract: movable when that is ledger2.
  remember(_endMemo, k, endMs, defaultIsLedger2(chainId), now);
  return endMs;
}

function defaultIsLedger2(chainId: number): boolean {
  try {
    return getEventContractVersion(chainId) === "ledger2";
  } catch {
    return true;
  }
}

export type EndDateEditVerdict =
  | { ok: true }
  | { ok: false; error: string };

/** The prefix `routes/events.ts` update-meta maps to a 400. */
export const END_DATE_PAST_SALES_CLOSE = "The end date can't be later than ticket sales close";

/**
 * EDIT-TIME guard: may the event's `endDate` become `newEndMs`?
 *
 * Reads the chain end of every registered series (memoized, parallel) and
 * refuses when the new end passes ANY of them — each series mints against its
 * own registration. No registered series ⇒ nothing to diverge from ⇒ ok.
 * An unreadable chain refuses THE EXTENSION (never other edits — the caller
 * only invokes this for extensions): allowing an unverifiable extension is the
 * exact hole this guard exists to close. Error strings are stable prefixes the
 * route maps to 4xx/503 (`routes/events.ts` update-meta).
 */
export async function checkEndDateExtension(args: {
  series: Array<{ onChainEventId?: string }>;
  newEndMs: number;
  chainId?: number;
  read?: ChainEndReader;
}): Promise<EndDateEditVerdict> {
  const ids = args.series.map((s) => s.onChainEventId).filter((id): id is string => !!id);
  if (ids.length === 0) return { ok: true };

  // On ledger2 the organiser has just moved the cutoff (the browser extends it before
  // this edit), possibly through a send whose receipt our relay never saw: read fresh,
  // or the edit is refused for up to a minute (Fable sign-off C6). Extensions are rare.
  let movable = false;
  let ends: Array<number | null>;
  try {
    const chainId = args.chainId ?? getActiveChainId();
    movable = defaultIsLedger2(chainId);
    ends = await Promise.all(ids.map((id) => chainEventEndMs(id, chainId, args.read, Date.now(), movable)));
  } catch {
    return {
      ok: false,
      error: "Could not verify when ticket sales close - please try extending the date again in a moment",
    };
  }

  const known = ends.filter((e): e is number => e !== null);
  if (known.length === 0) return { ok: true };
  const minEnd = Math.min(...known);
  if (args.newEndMs > minEnd) {
    return {
      ok: false,
      error: movable
        ? `${END_DATE_PAST_SALES_CLOSE} (${new Date(minEnd).toISOString()}). Save the later date from your ` +
          "event's dashboard, which moves ticket sales with it, then try again."
        : `${END_DATE_PAST_SALES_CLOSE} (${new Date(minEnd).toISOString()}). Sales close at a fixed ` +
          "time set when your tickets were created, so a later end date would sell tickets that can't " +
          "be issued. You can always make it earlier.",
    };
  }
  return { ok: true };
}
