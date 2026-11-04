/**
 * Holding seats (docs/SEATING.md "Selling a seat"). The reserve route runs every gate a
 * hold shares with general admission (cancellation, keys, privacy notice, sales windows,
 * sale contract), then this: the pinned plan, one chain read and our own sales checked
 * under the series lock (`reserveSeats`), and the hold's priced view - the ONLY figures a
 * page shows for a seated order, so what is shown is what checkout charges.
 */

import type { ContentfulStatusCode } from "hono/utils/http-status";
import { cardOrderAmountsMulti, type PaymentConfig, type SeriesSummary } from "@woco/shared";
import { contractKey, type EventContractTarget } from "../chain/event-contract.js";
import { lookupOnChainEventId } from "../event/onchain-registry.js";
import { noteChainCancelled } from "../event/ledger2-sale-status.js";
import {
  releaseSeatedHold,
  reserveSeats,
  type HoldCheckout,
  type Reservation,
  type SessionExpiry,
} from "../event/reservation-store.js";
import { expireCheckoutSession } from "../stripe/checkout-session-expire.js";
import { mintedSeats } from "../stripe/ticket-sales.js";
import { checkSeats, SEATS_NOT_ON_SALE, SEATS_UNREADABLE } from "./seat-check.js";
import { pinnedSeatPlan, readSeatChain } from "./seat-reads.js";

export interface Reply {
  status: ContentfulStatusCode;
  body: Record<string, unknown>;
}

export interface SeatedReserveDeps {
  pinnedSeatPlan: typeof pinnedSeatPlan;
  readSeatChain: typeof readSeatChain;
  mintedSeats(onChainEventId: string, contract: string): ReadonlySet<number>;
  lookupOnChainEventId(eventId: string, seriesId: string): string | null;
  noteChainCancelled(eventId: string, onChainEventId: string): void;
  expireSession(c: HoldCheckout): Promise<SessionExpiry>;
}

const liveDeps: SeatedReserveDeps = {
  pinnedSeatPlan,
  readSeatChain,
  mintedSeats,
  lookupOnChainEventId,
  noteChainCancelled: (eventId, id) => noteChainCancelled(eventId, id),
  expireSession: (c) => expireCheckoutSession(c),
};

const refuse = (status: ContentfulStatusCode, error: string, extra: Record<string, unknown> = {}): Reply =>
  ({ status, body: { ok: false, error, ...extra } });

export async function reserveSeated(
  a: {
    eventId: string;
    seriesId: string;
    seats: number[];
    planDigest: string;
    series: Pick<SeriesSummary, "swarmManifestRef" | "seating" | "payment">;
    contract: EventContractTarget;
    seatCap: { sawLiveSupply(n: number): void; cap(): number };
    replaceReservationId?: string;
    clientKey?: string;
    ip?: string;
  },
  deps: SeatedReserveDeps = liveDeps,
): Promise<Reply> {
  // Seats exist only on ledger2, and the mint goes to this server's own registration.
  const onChainEventId = deps.lookupOnChainEventId(a.eventId, a.seriesId);
  const payment = a.series.payment;
  if (a.contract.version !== "ledger2" || !onChainEventId || !payment?.stripeEnabled) return refuse(409, SEATS_NOT_ON_SALE);

  const pinned = await deps.pinnedSeatPlan(a.series.swarmManifestRef, a.planDigest);
  if (!pinned.ok) return refuse(pinned.status, pinned.error, pinned.status === 409 ? { code: "PLAN_CHANGED" } : {});
  const plan = pinned.plan;

  const r = await reserveSeats({
    eventId: a.eventId,
    seriesId: a.seriesId,
    seats: a.seats,
    planDigest: a.planDigest.toLowerCase(),
    perIpSeatCap: a.seatCap.cap,
    replaceReservationId: a.replaceReservationId,
    clientKey: a.clientKey,
    ip: a.ip,
    expireSession: deps.expireSession,
    verify: async () => {
      let chain;
      try {
        chain = await deps.readSeatChain(a.contract, onChainEventId, a.seats);
      } catch (err) {
        console.warn(`[reserve/seats] chain read failed for ${a.eventId.slice(0, 8)}:`, err instanceof Error ? err.message : String(err));
        return { ok: false, status: 503, error: SEATS_UNREADABLE };
      }
      if (chain.event) {
        a.seatCap.sawLiveSupply(Number(chain.event.totalSupply));
        if (chain.event.cancelled) deps.noteChainCancelled(a.eventId, onChainEventId);
      }
      return checkSeats({
        plan,
        planDigest: a.planDigest,
        seating: a.series.seating,
        payment,
        seats: a.seats,
        minted: deps.mintedSeats(onChainEventId, contractKey(a.contract)),
        chain,
      });
    },
  });
  if (!r.ok) {
    return refuse(r.status, r.error, {
      ...(r.conflicts ? { conflicts: r.conflicts } : {}),
      ...(r.available !== undefined ? { available: r.available } : {}),
    });
  }
  return { status: 200, body: { ok: true, data: seatedHoldView(r.reservation, payment) } };
}

export interface SeatedHoldView {
  reservationId: string;
  expiresAt: string;
  quantity: number;
  planDigest: string;
  seats: Array<{ seat: number; label: string; band: string; bandName: string; priceMinor: number; chargeMinor: number }>;
  amounts: {
    currency: string;
    mode: string;
    feePercent: number;
    subtotalMinor: number;
    orderFeeMinor: number;
    bookingFeeMinor: number;
    totalMinor: number;
  };
  /** A Stripe page is open for this hold: the page offers "Pay" again, not a new hold. */
  checkout: boolean;
}

/** The hold as a page shows it: each seat's pinned price and charge, and the order's total. */
export function seatedHoldView(h: Reservation, payment: Pick<PaymentConfig, "currency" | "feePassedToCustomer" | "buyerFeePercent" | "coverFees">): SeatedHoldView {
  const info = h.seatInfo ?? [];
  const seats = h.seats ?? [];
  const a = cardOrderAmountsMulti(payment, info.map((s) => s.priceMinor));
  return {
    reservationId: h.id,
    expiresAt: h.expiresAt,
    quantity: h.quantity,
    planDigest: h.planDigest ?? "",
    seats: seats.map((k, i) => ({
      seat: k,
      label: info[i].label,
      band: info[i].band,
      bandName: info[i].bandName,
      priceMinor: info[i].priceMinor,
      chargeMinor: a.chargeMinor[i],
    })),
    amounts: {
      currency: payment.currency,
      mode: a.mode,
      feePercent: a.feePercent,
      subtotalMinor: a.subtotalMinor,
      orderFeeMinor: a.orderFeeMinor,
      bookingFeeMinor: a.bookingFeeMinor,
      totalMinor: a.totalMinor,
    },
    checkout: !!h.checkout && Date.parse(h.checkout.expiresAt) > Date.now(),
  };
}

/** The buyer lets go of a seated hold: its open Stripe page is closed first. */
export async function releaseSeated(id: string, expireSession: SeatedReserveDeps["expireSession"] = liveDeps.expireSession): Promise<Reply> {
  const out = await releaseSeatedHold(id, expireSession);
  if (out === "released") return { status: 200, body: { ok: true } };
  if (out === "paid") return refuse(409, "These seats have been paid for");
  return refuse(503, "We couldn't release these seats just now. Try again in a moment.");
}
