# Referral earnings

AUTHORITY on what a referrer is owed (#12). The promise is ToS §9; the rate is
`REFERRAL_SHARE_SCHEDULE` in `packages/shared/src/event/types.ts`; the code is
`apps/server/src/lib/campaign/earnings*.ts`. Design consult: Fable 5.1, 2026-11-03.

## Derived, not stored

Every statement is computed on request from:

- the payout ledger (`.data/stripe-payout-ledger.json`): which sales, which event, whether the organiser was paid;
- Stripe: the ApplicationFee on each sale (`amount` less `amount_refunded`), its charge's refunds and disputes, the organiser payout's status;
- the organiser's referral confirmation (`woco.referral-confirmation.v1`, permanent);
- the payout journal (`.data/referral-payout-journal.json`): payouts made, withholds, lifts. Append-only, the only new state.

## The rules

- A sale earns if it is a ticket sale (never shop, never reconciliation) made at or after its organiser's `confirmedAt`.
- Base = the platform fee WoCo kept on it, in the fee's currency. Never the charge amount.
- Share = the schedule entry in force on the SALE date. A change is a new entry from the date in its notice, so it never touches earnings already accrued.
- Payable when: the organiser's payout is `released` with a positive net, the event is over (`releaseAfter` passed, and not the 14-day no-date fallback), and Stripe reads that payout `paid`. Before that: pending.
- Earns nothing (owner 2026-11-03): refunded in full, chargeback lost, fee returned in full. An open dispute is pending, not zero. A partial refund that keeps the fee earns the full fee.
- Withholds (§9: self-referral, fraud, breach) hold a referrer, a referee or one sale. Held earnings stay on the statement; a lift releases them.
- Exact per sale (minor units x 10 000), summed, rounded down once per payout. The remainder stays owed.
- A reversal after a payout leaves the balance negative. It is netted against later earnings and never clawed back (owner 2026-11-03). Rare: payouts follow the event, so only a late chargeback can do it.
- Anything unreadable (a confirmation, a fee, a payout) is pending and listed in `diagnostics`, never a guess.

## Running a payout (manual)

1. `GET /api/ops/referral-earnings` - each referrer's `dueMinor` per currency, with lines and diagnostics.
2. Send the stablecoin to the referrer's own account address (the confirmation's `referrer`) on the network you told them about.
3. `POST /api/ops/referral-earnings/payouts` with `referrer, currency, amountMinor` (= `dueMinor`), `network, asset, sentAmount, txHash, by`. Refused if the amount is not what is due now, the transaction is already recorded, or the journal is unreadable. The server freezes the lines it settles.

Withhold: `POST /api/ops/referral-earnings/withholds {by, scope, key, reason}`; lift: `POST .../withholds/:id/lift {by, reason}`.

## Not built

Per-referrer rates, caps and an end period (§9 allows them; add them to the schedule when one is decided). A referrer-facing view. Automated sending. No statement is ever published: 40% of 1.5% gives away the organiser's takings.
