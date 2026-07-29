/**
 * The organiser-facing shape of `GET /api/stripe/payouts`.
 *
 * Shared so the server's response and the payouts screen cannot drift: this is
 * money the organiser is owed, and a silently renamed field would show them a
 * blank where their balance should be. The mechanism behind it — manual payout
 * schedule, per-sale ledger, release sweep — lives in docs/PAYOUTS.md.
 *
 * Every amount is an INTEGER in minor units, exactly as Stripe reports it.
 * Sum in minor units; divide only when formatting for display.
 */

export type PayoutEntryStatus = "held" | "released" | "void";

/** One paid Checkout Session, as the organiser sees it. */
export interface PayoutEntryView {
  /** Stripe Checkout Session id — one sale. */
  sessionId: string;
  kind: "event" | "shop";
  eventId?: string;
  shopId?: string;
  /** Lowercase ISO code the buyer was charged in. */
  currency: string;
  /**
   * Lowercase ISO code the funds actually settled in, when Stripe converted the
   * charge because the account has no bank account in `currency`. `netAmount`
   * is in THIS currency whenever it is set.
   */
  settlementCurrency: string | null;
  /** What the buyer paid, in `currency`. */
  grossAmount: number;
  /** Credited to the organiser after Stripe's fees, ours, and any refund. */
  netAmount: number | null;
  /**
   * False while the entry is held: a refund can still land and change the net.
   * The UI must label held totals as estimates rather than promises.
   */
  netIsFinal: boolean;
  recordedAt: string;
  /** Earliest release — ISO date. */
  releaseAfter: string;
  status: PayoutEntryStatus;
  releasedAt: string | null;
  payoutId: string | null;
  /**
   * Released BEFORE the event because Stripe's country hold ceiling ran out
   * (docs/PAYOUTS.md §3.1). Visible rather than silent — for these sales the
   * attendee-protection story does not hold.
   */
  forcedByCeiling: boolean;
  /** Set with status "void" — refunded, or the sale never became a ticket. */
  voidReason: string | null;
}

export interface PayoutsResponse {
  /** Always "manual" today — every connected account is held until release. */
  schedule: "manual";
  /** Currency → integer minor units currently held, keyed by settlement currency. */
  heldByCurrency: Record<string, number>;
  /** ISO date of the soonest release among held entries, or null if none. */
  nextReleaseAt: string | null;
  entries: PayoutEntryView[];
}
