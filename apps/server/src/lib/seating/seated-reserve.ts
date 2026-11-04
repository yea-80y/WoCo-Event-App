/**
 * Holding seats (docs/SEATING.md "Selling a seat"). The reserve route runs every gate a
 * hold shares with general admission (cancellation, keys, privacy notice, sales windows,
 * sale contract), then this: the pinned plan, one chain read and our own sales checked
 * under the series lock (`reserveSeats`), and the hold's priced view - the ONLY figures a
 * page shows for a seated order, so what is shown is what checkout charges.
 */

import type { ContentfulStatusCode } from "hono/utils/http-status";
import { cardOrderAmountsMulti, type PaymentConfig, type SeriesSummary } from "@woco/shared";
import type { SeatedHold } from "@woco/shared/seating/reserve";
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
import { holdFeeKey, seatedPriceRefusal } from "./seated-checkout.js";
import { pinnedSeatPlan, readSeatChain } from "./seat-reads.js";
import { seatStateRead } from "./seat-state-gate.js";
import { seatStateView } from "@woco/shared/seating/state";

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
  seatStateRead: typeof seatStateRead;
}

const liveDeps: SeatedReserveDeps = {
  pinnedSeatPlan,
  readSeatChain,
  mintedSeats,
  lookupOnChainEventId,
  noteChainCancelled,
  expireSession: expireCheckoutSession,
  seatStateRead,
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
    /** The event's carrier signer (`eventKeys`): whose seat-state feed is the organiser's. */
    feedSigner: string;
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
    feeKey: holdFeeKey(payment),
    reusable: (h) => seatedPriceRefusal(h, a.series.seating, payment) === null,
    expireSession: deps.expireSession,
    verify: async () => {
      // The organiser's holds and confirmations, beside the chain read they are checked
      // with: unreadable refuses, like the chain (seat-state-gate.ts).
      const [chainRead, organiser] = await Promise.all([
        deps.readSeatChain(a.contract, onChainEventId, a.seats).then(
          (v) => ({ ok: true as const, v }),
          (err: unknown) => ({ ok: false as const, err }),
        ),
        deps.seatStateRead({ eventId: a.eventId, signer: a.feedSigner, planDigest: a.planDigest, seats: plan.seats.length }),
      ]);
      if (!chainRead.ok) {
        const err = chainRead.err;
        console.warn(`[reserve/seats] chain read failed for ${a.eventId.slice(0, 8)}:`, err instanceof Error ? err.message : String(err));
        return { ok: false, status: 503, error: SEATS_UNREADABLE };
      }
      if (organiser.status === "unavailable") {
        console.warn(`[reserve/seats] seat state unreadable for ${a.eventId.slice(0, 8)}: ${organiser.reason}`);
        return { ok: false, status: 503, error: SEATS_UNREADABLE };
      }
      const chain = chainRead.v;
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
        organiser: seatStateView(plan, a.planDigest, organiser.status === "found" ? organiser.state : null),
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

/** The hold as every page shows it (`SeatedHold`, shared with the clients). */
export function seatedHoldView(h: Reservation, payment: Pick<PaymentConfig, "currency" | "feePassedToCustomer" | "buyerFeePercent" | "coverFees">): SeatedHold {
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
