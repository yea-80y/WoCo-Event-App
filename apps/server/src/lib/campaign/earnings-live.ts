/**
 * The Stripe and Swarm reads behind referral earnings (#12), kept apart from
 * the derivation (earnings.ts) so its rules are testable without either.
 */

import type Stripe from "stripe";
import { getStripe } from "../stripe/client.js";
import { readLatestCharge } from "../stripe/checkout-provenance-live.js";
import { listAllEntries, type PayoutLedgerEntry } from "../stripe/payout-ledger.js";
import { readConfirmation, type RecordRead } from "./issuer.js";
import { journalEntries, journalReadable } from "./earnings-journal.js";
import type { EarningsReads, PayoutStatus, SaleRead } from "./earnings.js";
import type { ReferralConfirmationV1 } from "@woco/shared";

// A confirmation is permanent (version 0, write-once), so one found is found for
// good. Absent and unavailable are asked again on every run.
const foundConfirmations = new Map<string, RecordRead<ReferralConfirmationV1>>();

async function confirmation(organiser: string): Promise<RecordRead<ReferralConfirmationV1>> {
  const known = foundConfirmations.get(organiser);
  if (known) return known;
  const read = await readConfirmation(organiser);
  if (read.status === "found") foundConfirmations.set(organiser, read);
  return read;
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "read failed";
}

async function sale(entry: PayoutLedgerEntry): Promise<SaleRead> {
  try {
    let feeId = entry.applicationFeeId ?? null;
    if (!feeId) {
      if (!entry.paymentIntentId) return { status: "unavailable", reason: "no fee id and no payment intent on the entry" };
      const charge = await readLatestCharge(entry.paymentIntentId, entry.stripeAccountId);
      feeId = charge?.feeId ?? null;
      if (!feeId) return { status: "unavailable", reason: "no application fee on the sale's charge" };
    }
    // The platform key reads only OUR fees (checkout-provenance.ts).
    const fee = await getStripe().applicationFees.retrieve(feeId, { expand: ["charge"] });
    const charge = fee.charge;
    if (typeof charge === "string") return { status: "unavailable", reason: "charge not expanded" };
    const account = typeof fee.account === "string" ? fee.account : fee.account.id;
    const disputes: string[] = [];
    if ((charge as Stripe.Charge).disputed) {
      for await (const d of getStripe().disputes.list({ charge: charge.id, limit: 100 }, { stripeAccount: account })) {
        disputes.push(d.status);
      }
    }
    return {
      status: "found",
      facts: {
        feeId: fee.id,
        feeAmount: fee.amount,
        feeRefunded: fee.amount_refunded ?? 0,
        currency: fee.currency,
        account,
        chargeAmount: charge.amount,
        chargeRefunded: charge.amount_refunded,
        disputes,
      },
    };
  } catch (err) {
    return { status: "unavailable", reason: errName(err) };
  }
}

const PAYOUT_STATUSES: ReadonlySet<string> = new Set(["paid", "pending", "in_transit", "failed", "canceled"]);

async function payoutStatus(payoutId: string, account: string): Promise<PayoutStatus> {
  try {
    const p = await getStripe().payouts.retrieve(payoutId, {}, { stripeAccount: account });
    return PAYOUT_STATUSES.has(p.status) ? (p.status as PayoutStatus) : "unavailable";
  } catch {
    return "unavailable";
  }
}

export const liveEarningsReads: EarningsReads = {
  entries: listAllEntries,
  journal: journalEntries,
  journalReadable,
  confirmation,
  sale,
  payoutStatus,
};
