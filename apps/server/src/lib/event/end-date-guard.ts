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
 * The chain end is immutable, so it is memoized forever per (chain, event id):
 * after the first read the sale-time backstop costs ZERO RPCs. Only positive
 * answers are cached — an `EventNotFound` may be a mis-cached id or a wrong
 * chain, and pinning it would make the guard permanently blind there.
 */

import { getOnChainEventEnd as realGetOnChainEventEnd, getActiveChainId } from "../chain/event-contract.js";

/** `${chainId}:${onChainEventId}` → registered end in epoch MS. */
const _endMemo = new Map<string, number>();

/** Test seam — production always reads the real contract. */
export type ChainEndReader = typeof realGetOnChainEventEnd;

/** Reset the memo (tests only). */
export function _resetChainEndMemoForTests(): void {
  _endMemo.clear();
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
): Promise<number | null> {
  const k = `${chainId}:${onChainEventId.toLowerCase()}`;
  const hit = _endMemo.get(k);
  if (hit !== undefined) return hit;
  const endSec = await read(onChainEventId, chainId);
  if (endSec === null) return null;
  const endMs = endSec * 1000;
  _endMemo.set(k, endMs);
  return endMs;
}

export type EndDateEditVerdict =
  | { ok: true }
  | { ok: false; error: string };

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

  let ends: Array<number | null>;
  try {
    ends = await Promise.all(ids.map((id) => chainEventEndMs(id, args.chainId, args.read)));
  } catch {
    return {
      ok: false,
      error: "Could not verify the on-chain sales end — please try extending the date again in a moment",
    };
  }

  const known = ends.filter((e): e is number => e !== null);
  if (known.length === 0) return { ok: true };
  const minEnd = Math.min(...known);
  if (args.newEndMs > minEnd) {
    return {
      ok: false,
      error:
        "endDate cannot extend past the on-chain sales end " +
        `(${new Date(minEnd).toISOString()}) — ticket sales are registered on-chain with a fixed close, ` +
        "so an extended date would sell tickets every mint refuses. Shortening is always allowed.",
    };
  }
  return { ok: true };
}
