/**
 * The seated route's draft (docs/SEATING.md): a layout, a price per band and how
 * the booking fee is charged, turned into the one seated ticket type publish sends.
 */

import { BUYER_FEE_DEFAULT_PCT, ticketPriceMeetsMinimum, MIN_TICKET_PRICE } from "@woco/shared";
import type { SeatLayout } from "@woco/shared/seating/layout";
import { freezeSeatPlan, seatPlanProblems, type SeatPlan } from "@woco/shared/seating/plan";
import { cardPayment, type Ccy, type FeeChoice } from "../events/payment-settings.js";
import type { PaymentConfig } from "@woco/shared";

export interface SeatedDraft {
  seriesId: string;
  /** What the tickets say they are for ("Seats", "Dinner and show"). */
  name: string;
  layout: SeatLayout | null;
  /** Band id -> price as typed. */
  prices: Record<string, string>;
  currency: Ccy;
  fee: FeeChoice;
  /** Where the layout came from in the organiser's library, if anywhere. */
  sourceId?: string;
}

export interface SeatedSeries {
  seriesId: string;
  name: string;
  description: string;
  totalSupply: number;
  payment: PaymentConfig;
  seating: { plan: SeatPlan; bands: { id: string; price: string }[] };
}

const PRICE_RE = /^\d{1,6}(\.\d{1,2})?$/;

/** Why the seated draft cannot be published yet, in the organiser's words; empty when it can. */
export function seatedDraftProblems(d: SeatedDraft): string[] {
  if (!d.layout) return ["Choose a seating plan."];
  const out: string[] = [];
  if (seatPlanProblems(d.layout).length) out.push("Open the seating plan and fix what its check shows.");
  if (!d.name.trim()) out.push("Give the seats a name for the tickets.");
  const used = new Set<string>();
  for (const it of d.layout.items) {
    const lists = it.kind === "rows" ? it.rows.map((r) => r.seats) : it.kind === "table" ? [it.seats] : [];
    for (const l of lists) for (const s of l) if (!("g" in s)) used.add(s.b);
  }
  for (const b of d.layout.bands) {
    if (!used.has(b.id)) continue;
    const p = (d.prices[b.id] ?? "").trim();
    if (!PRICE_RE.test(p) || !ticketPriceMeetsMinimum(p)) out.push(`${b.name}: set a price of at least ${MIN_TICKET_PRICE}.00.`);
  }
  return out;
}

/** The seated ticket type to publish, or null while `seatedDraftProblems` has anything to say. */
export function seatedSeries(d: SeatedDraft): SeatedSeries | null {
  if (!d.layout || seatedDraftProblems(d).length) return null;
  const plan = freezeSeatPlan(d.layout, d.sourceId);
  const bands = plan.bands.map((b) => ({ id: b.id, price: normalisePrice(d.prices[b.id]) }));
  const lowest = bands.reduce((m, b) => (parseFloat(b.price) < parseFloat(m) ? b.price : m), bands[0].price);
  return {
    seriesId: d.seriesId,
    name: d.name.trim(),
    description: "",
    totalSupply: plan.seats.length,
    payment: cardPayment(lowest, d.currency, d.fee),
    seating: { plan, bands },
  };
}

export type Admission = "general" | "seated";

/**
 * What a create flow publishes: the general-admission ticket types, or the seated
 * ticket type (once it is complete) plus any standing tickets sold beside it. Both
 * routes' drafts are kept by the host; only the chosen one is published.
 */
export function publishableSeries<T extends { seriesId: string }>(
  admission: Admission,
  seated: SeatedDraft,
  standingToo: boolean,
  series: T[],
): (T | SeatedSeries)[] {
  if (admission === "general") return series;
  const s = seatedSeries(seated);
  return [...(s ? [s] : []), ...(standingToo ? series : [])];
}

/** "12" -> "12.00", "12.5" -> "12.50": one spelling per price. */
export function normalisePrice(p: string | undefined): string {
  const n = parseFloat((p ?? "").trim());
  return Number.isFinite(n) ? n.toFixed(2) : "";
}

export function newSeatedDraft(currency: Ccy): SeatedDraft {
  return {
    seriesId: `seats-${crypto.randomUUID().slice(0, 12)}`,
    name: "Seats",
    layout: null,
    prices: {},
    currency,
    fee: { feePassedToCustomer: true, coverFees: false, buyerFeePercent: BUYER_FEE_DEFAULT_PCT },
  };
}
