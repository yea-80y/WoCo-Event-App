/**
 * The organiser's orders view, the server's part (#965): only what the server
 * alone knows. The browser reads each slot (owner, orderRef) from the chain and
 * each sealed order from our gateway itself, so a large event costs this route
 * the same as a small one - no chain read and no Swarm read per ticket.
 *
 * - which registration each series sells on (server state, onchain-events.json);
 * - when each slot was paid and its refund state (the Stripe sale record);
 * - which of the event's orders are erased or being erased, by root: the browser
 *   must hold this answer before it fetches or opens any order;
 * - paid orders not yet stored on Swarm, which nothing else can serve.
 */
import type { OrdersSeriesLedger, OrdersStatus } from "@woco/shared";
import type { SealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";
import { contractKey, type EventContractTarget } from "../chain/event-contract.js";
import { registrationContractFor } from "./onchain-registry.js";
import { slotPaidTimes, slotRefundStates, type SlotRefundState } from "../stripe/ticket-sales.js";
import { getOrderRecord, listOrders, type OrderRecord } from "../attendee-batch/ledger.js";
import { paidUnstored } from "../attendee-batch/held-orders.js";
import { erasureStarted } from "../attendee-batch/order-gateway.js";

export interface StatusSeries {
  seriesId: string;
  name: string;
  onChainEventId?: string;
  swarmManifestRef?: string;
}

export interface OrdersStatusDeps {
  registration(eventId: string, seriesId: string): EventContractTarget | undefined;
  paidTimes(onChainEventId: string, contract: string): Map<number, string>;
  refunds(onChainEventId: string, contract: string): Map<number, SlotRefundState>;
  orders(): Array<{ root: string; record: OrderRecord }>;
  record(root: string): OrderRecord | null;
  /** Without a record, the ledger's own is read. */
  erasureStarted(root: string, record?: OrderRecord | null): boolean;
  paidHeld(): Array<{ root: string; json: string; eventId?: string }>;
}

const liveDeps: OrdersStatusDeps = {
  registration: registrationContractFor,
  paidTimes: slotPaidTimes,
  refunds: slotRefundStates,
  orders: listOrders,
  record: getOrderRecord,
  erasureStarted,
  paidHeld: paidUnstored,
};

/** Roots one request may ask about: far above any event's supply, a bound on the work. */
export const MAX_STATUS_ROOTS = 20_000;

/**
 * The roots a request asks about, lowercase, 0x-stripped, deduplicated; null when
 * not an array of 64-hex strings within the bound.
 */
export function parseStatusRoots(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_STATUS_ROOTS) return null;
  const out = new Set<string>();
  for (const r of raw) {
    if (typeof r !== "string") return null;
    const hex = r.toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{64}$/.test(hex)) return null;
    out.add(hex);
  }
  return [...out];
}

/**
 * `roots` = the order roots the browser read from this event's slots. Erasure is
 * answered for each of them by root - never only through a record's eventId,
 * which a record could lack - plus every record of this event the ledger holds.
 */
export function ordersStatus(
  event: { eventId: string; title: string; series: StatusSeries[] },
  roots: string[] = [],
  deps: OrdersStatusDeps = liveDeps,
): OrdersStatus {
  const series = event.series.map((s) => {
    // Same rule as `/orders/count`: no manifest or no onchain id = never registered.
    const contract = s.swarmManifestRef && s.onChainEventId ? deps.registration(event.eventId, s.seriesId) : undefined;
    if (!contract || !s.onChainEventId) {
      return { seriesId: s.seriesId, seriesName: s.name, ledger: null, paidAt: {}, refund: {} };
    }
    const key = contractKey(contract);
    const ledger: OrdersSeriesLedger = {
      chainId: contract.chainId,
      contract: contract.address.toLowerCase(),
      version: contract.version,
      onChainEventId: s.onChainEventId.toLowerCase(),
    };
    return {
      seriesId: s.seriesId,
      seriesName: s.name,
      ledger,
      paidAt: Object.fromEntries(deps.paidTimes(s.onChainEventId, key)),
      refund: Object.fromEntries(deps.refunds(s.onChainEventId, key)),
    };
  });

  const erasedSet = new Set(
    deps
      .orders()
      .filter(({ root, record }) => record.eventId === event.eventId && deps.erasureStarted(root, record))
      .map(({ root }) => root),
  );
  for (const root of roots) {
    const record = deps.record(root);
    // Another event's order is not this organiser's to ask about. It could not show
    // here either: a box opens only under its own event and series.
    if (record?.eventId && record.eventId !== event.eventId) continue;
    if (deps.erasureStarted(root, record)) erasedSet.add(root);
  }
  const erased = [...erasedSet];

  const held: OrdersStatus["held"] = [];
  for (const h of deps.paidHeld()) {
    if (h.eventId !== event.eventId || deps.erasureStarted(h.root)) continue;
    try {
      held.push({ root: h.root, encryptedOrder: JSON.parse(h.json) as SealedBoxV2 });
    } catch (err) {
      console.warn(`[orders/status] held order ${h.root} is not JSON:`, err);
    }
  }

  return { eventId: event.eventId, eventTitle: event.title, series, erased, held };
}
