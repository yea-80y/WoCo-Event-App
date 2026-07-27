# Payouts — how organiser money moves

Authoritative for payout timing, the Stripe Connect configuration it depends on, and
the constraints Stripe imposes on it. Pricing/fee arithmetic lives in
`PRICING_AND_EMAIL.md` (§15/§16 are the current sections); this doc is the mechanism.

Built 2026-07-27. Every Stripe behaviour below is either quoted from their docs with a
link, or flagged **UNVERIFIED**. Nothing here is inferred.

---

## 1. The model in one paragraph

Ticketing is future delivery: the buyer pays now for something delivered later. If an
organiser is paid immediately and the event is then cancelled, refunds hit an empty
balance and someone else absorbs the loss. So every connected account is created on a
**manual payout schedule** and its takings are released by a job after the event has
happened. This is Stripe's own recommended pattern for our vertical, not our invention —
their support, 2026-07-27:

> "This is the recommended pattern for future-delivery businesses like event ticketing,
> as it lets you hold organiser funds until after the event date and only release them
> when you're satisfied the event has taken place."

We deliberately do **not** use `delay_days`: self-serve caps it at 7 days, and going
beyond needs an account-team "backend extension". Manual has no such ceiling.

**Do not call this escrow.** Stripe, verbatim: *"Escrow has a precise legal definition,
and Stripe doesn't provide escrow services or support escrow accounts."* The funds sit in
the organiser's own Stripe balance throughout. We control *when they are released*, and
nothing more. The legal docs must use "delayed payouts", never "escrow" or "we hold your
money".

---

## 2. What was built

| File | Role |
|---|---|
| `lib/stripe/payout-policy.ts` | Every timing constant + Stripe's hold ceilings. The only place these numbers live. |
| `lib/stripe/payout-ledger.ts` | `.data/stripe-payout-ledger.json` — one entry per paid session, with its release date. |
| `lib/stripe/payout-release.ts` | The sweep: decides what is due, pays it, marks it. Hourly. |
| `lib/stripe/payout-schedule.ts` | `ensureManualPayoutSchedule()` — sets `interval: "manual"`. |
| `scripts/payout-schedule-audit.ts` | Audits (and with `--fix`, corrects) the schedule on every existing account. |
| `GET /api/stripe/payouts` | Organiser's own held/released takings. Backs the terms' promise to tell them when funds release. |
| `test/payout-release.test.ts` | 25 tests over the failure modes below. |

Wired into `routes/stripe.ts`: `interval: "manual"` at account creation; a self-healing
correction on `account.updated`; a ledger entry on every paid session (tickets **and**
shop orders); a void on full auto-refund. Sweep starts in `index.ts`.

### Why a per-sale ledger and not "pay out the balance"

A connected account has **one pooled balance across every event it has ever sold.** An
organiser with a gig next week and a festival in six months has both sets of takings in
the same pot. Paying out the available balance after the gig hands over the festival's
advance too. The ledger is what makes "release only what *this* event earned" expressible.

### Amounts are net, read from Stripe

Released amounts come from the charge's **balance transaction** (`bt.net`), not from our
own arithmetic: gross − Stripe processing − our `application_fee_amount`, then minus each
refund's own (negative) balance transaction. Whether a refund returns the processing fee
varies by region, and whether it returns our application fee depends on
`refund_application_fee` — so we read what Stripe actually did rather than predict it.

### Crash safety

The sweep **selects the entry set, pays exactly its sum, then marks it released** — in
that order. The payout's idempotency key is derived from the selected session ids, so a
crash between the Stripe call and the ledger write re-selects the same set next run,
replays the same key, and Stripe returns the original payout instead of making a second.
(Stripe idempotency keys expire after 24h; the sweep runs hourly.)

An entry is never released on a guess: an unresolvable net, an unreadable balance, or a
failed payout all leave it held.

---

## 3. Stripe's hard limits

### 3.1 Maximum hold — 90 days in the UK

[docs.stripe.com/connect/manual-payouts](https://docs.stripe.com/connect/manual-payouts):
*"You must pay out the funds within the time period specified below, based on the
business's country."*

| Country | Limit |
|---|---|
| Thailand | 10 days |
| United States | 2 years |
| **All other countries (incl. UK)** | **90 days** |

**This runs from each charge, not from the event.** Consequences:

- Sales made **within ~90 days of the event** are fully covered by the hold.
- Sales made **earlier than that cannot be** — festival/early-bird money is released to
  the organiser *before* their event, by law of Stripe's ceiling, not by choice.
- `payout-policy.ts` subtracts a **7-day safety margin**, so a missed sweep or an API
  outage cannot push us past the deadline. Breaching it is a compliance problem.
- Ceiling-forced releases are flagged `forcedByCeiling` on the entry, logged as a
  warning, and tagged in the payout's Stripe metadata. These are the sales where our
  attendee-protection story does not hold, and they must be visible rather than silent.

**For that exposed tail, delayed payouts provide no protection.** Refunds still work —
Stripe debits the connected account's balance — but if the funds have gone the balance
goes negative, and who absorbs it is decided entirely by the Connect liability
configuration (§4). The remaining levers are product ones, not code: limit how far ahead
an unproven organiser may sell, hold a partial reserve, or require cancellation cover for
festival-scale on-sales. Those belong to the §7 tier decisions.

### 3.2 A manual schedule is NOT a lock 🚨

[Platform controls](https://docs.stripe.com/connect/platform-controls-for-stripe-dashboard-accounts),
verbatim:

> "Connected accounts can still make manual payouts after you, as the platform, choose to
> restrict connected accounts from updating their own payout schedule."

> "If you need full control over your connected accounts' payouts and want to restrict
> your connected accounts from being able to make their own payouts, contact us with a
> detailed description of your use case."

So `interval: "manual"` stops **automatic** payouts. An Express organiser can still pay
themselves out of their own Express Dashboard, before their event. **Until Stripe grants
the platform control that blocks this, the hold is the default funds sit under — not a
guarantee they stay there.** Open with Stripe (§6).

This does not make the build pointless: it removes the automatic fast payout that is the
common case, and it is a precondition for the lock. But no attendee-facing or
organiser-facing promise may be written as though funds cannot move.

---

## 4. Our Connect configuration

| | Current (Option A) | Managed Risk (Option B) |
|---|---|---|
| Account type | `express`, Accounts v1 | platform-level reconfiguration |
| `controller.losses.payments` | `application` — **WoCo** carries negative balances | `stripe` |
| Fees collector | platform | account |
| `application_fee_amount` | yes, 1.5% | **yes** — Stripe support, 2026-07-27 |
| £2/monthly active account | yes | no |
| 0.25% + 10p per payout | yes | no |
| Payout schedule | `manual`, set by us | **UNVERIFIED** — see §6 |

**Status 2026-07-27:** Stripe confirmed application fees survive Managed Risk (*"I don't
see any indications that will limit the collection of application fees while on Managed
Risk. You are welcome to collect application fees accordingly."*). Per
`PRICING_AND_EMAIL.md` §16 that resolves the launch blocker in favour of **Option B**.
Record it as a support agent's read, not a documented guarantee.

The §3.1 finding **strengthens** that decision: for long-lead sales the payout hold
cannot protect anyone, so who carries the negative balance is the only real control — and
under Managed Risk that is Stripe.

Everything in §2 is required under **both** options: an organiser paid before their event
who then cancels leaves attendees unrefundable regardless of who absorbs the accounting
loss.

---

## 5. Timing constants

All in `payout-policy.ts`. Changing them changes when real money moves.

| Constant | Value | Why |
|---|---|---|
| `POST_EVENT_RELEASE_DAYS` | 2 | Covers same-night no-show/refund requests after the event ends. |
| `SHOP_RELEASE_DAYS` | 7 | Shop/POS goods are delivered immediately — no event to wait for. Without this rule the manual schedule would freeze merchants' shop takings **forever**, since it holds the whole account balance, not just ticket money. |
| `FALLBACK_RELEASE_DAYS` | 14 | Event with no parseable date. Must neither strand funds nor dump them immediately. |
| `HOLD_CEILING_SAFETY_DAYS` | 7 | Margin inside Stripe's country limit. |
| Sweep interval | 1h | Payout timing is measured in days. No sweep at boot — a restart loop must not hammer Stripe. |

**If the sweep stops running, no organiser gets paid** and funds eventually breach §3.1.
Its absence is a production alarm, not a degraded feature.

---

## 6. Open with Stripe

Send on the existing thread — all three are cheap to ask while it is live.

**One ask, two parts** — they are the same conversation and should not be split:

1. **Restrict connected accounts from self-initiating payouts** (§3.2). Requires a support
   request with a use-case description. Without it our hold is advisory. Use case: UK
   event ticketing, future delivery, funds held until after the event to protect attendee
   refunds on cancellation.
2. **Does that restriction survive Managed Risk?** The payout-control page says *"Platforms
   that manage fraud and dispute liability, **or** have platform controls, can adjust the
   payout interval."* That is a disjunction: granting (1) should satisfy the second limb
   independently of who carries liability. **Our reading, not Stripe's words — get it
   confirmed**, because if the hold does not survive, Option B removes our attendee
   protection entirely and the trade changes shape.

> ~~3. Do existing connected accounts migrate?~~ **DEAD — do not ask.** We are pre-launch.
> The 12 connected accounts are test accounts at zero balance (verified 2026-07-27 before
> the schedule fix). If they cannot migrate we discard them. The question has no decision
> attached to it, and asking it invites Stripe to treat us as a live platform with an
> installed base — which is the opposite of the position we want going into this.

**UNVERIFIED, worth confirming:** how long after a charge a refund can still be issued
through Stripe. Not stated on `docs.stripe.com/refunds`. Matters for long-lead events: if
there is a limit shorter than the sales window, tickets sold far in advance may not be
refundable through Stripe at all, and refunds would have to be handled out of band.

---

## 7. Is this industry standard?

**Yes — post-event payout is the norm in ticketing, not an unusual restriction.** Stripe
calls it the recommended pattern for future-delivery businesses (§1), and the mainstream
platforms (Skiddle, Eventbrite, Fatsoma, DICE) all pay organisers after the event rather
than at point of sale. The outlier is Ticket Tailor, which puts organisers on their own
Stripe account with immediate settlement — the model `PRICING_AND_EMAIL.md` §7 already
identifies as carrying the attendee-protection gap.

`POST_EVENT_RELEASE_DAYS = 2` is when *we* initiate the payout; bank settlement adds 1–3
business days on top, so the organiser experience is "paid a few days after your event",
which is where the market sits.

> **UNVERIFIED:** the exact payout windows competitors advertise. Worth pinning down for
> pricing/positioning copy before we publish a comparison, rather than quoting from memory.

Standard practices this build does follow, and where they live:

| Practice | Where |
|---|---|
| Idempotent payout creation | key derived from the released set, `payout-release.ts` |
| Integer minor units throughout — never floats on money | ledger + policy |
| Amounts read from the provider, not re-derived locally | `resolveNet` via balance transactions |
| Never mix currencies in one payout | grouped by account+currency, tested |
| Reconcilable audit trail sale → payout | ledger entry + `payoutId` + Stripe payout metadata |
| Fail closed — no release on unknown state | unresolvable net / unreadable balance / failed payout all stay held |
| Liveness alarm on the money-moving job | `payoutSweepHealth()` on `/api/health` |
| 6-year retention of financial records | `PRIVACY_POLICY.md` §10 (Companies Act 2006, HMRC) |

## 8. Security of the store

What the ledger contains: Stripe account/session/PaymentIntent ids, the organiser's wallet
address, amounts, dates. What it does **not** contain: card data, attendee identifiers,
email addresses, or any credential.

- **PCI DSS scope is unchanged.** These are direct charges — card details go buyer → Stripe
  and never touch WoCo infrastructure (`DATA_INVENTORY.md` §5.1).
- **Not reachable over HTTP.** The server has no static-file middleware over `.data`.
  `GET /api/stripe/payouts` is `requireAuth` and scoped to the caller's own verified
  `parentAddress` — an organiser cannot read another's.
- **Gitignored** (`.data/` and `**/.data/`).
- **File mode 0600**, directory 0700 on fresh installs; written write-then-rename so a
  crash cannot truncate it.

> ⚠️ **Ops gap, needs a decision — pre-existing, not introduced here.** The live store at
> `/opt/woco/woco-data` is directory `755` with files `644`: world-readable to any host
> user, and it holds the marketing suppression list, gate bindings and Stripe account map
> as well. Single-tenant VM with root-only SSH keeps practical exposure low, but `644` is
> below standard for financial and personal data. Tightening it needs care because files
> there are owned by a mix of `root` and uid `1000` — changing modes or ownership carelessly
> can stop the container writing. There is also no encryption at rest beyond the provider's
> disk, and no verified backup of `woco-data` (a lost ledger strands organiser funds).

## 9. Operations

```bash
# Audit the payout schedule on every connected account (read-only), on the VM.
# -w /app matters: the store is process.cwd()/.data and the server's cwd is /app.
# From the wrong directory it finds no accounts — the script exits 1 rather than
# reporting a clean audit of nothing.
docker compose exec -w /app server npx tsx apps/server/scripts/payout-schedule-audit.ts
docker compose exec -w /app server npx tsx apps/server/scripts/payout-schedule-audit.ts --fix

# Locally against the dev store
cd apps/server && npx tsx scripts/payout-schedule-audit.ts

# Watch the sweep
docker compose logs -f server | grep payout
```

`.data/stripe-payout-ledger.json` **MUST survive restarts** — same class as
`stripe-accounts.json` and `marketing-suppression.json`. Losing it either strands
organiser funds in a frozen balance or releases them with no record of which event they
belong to. It is written write-then-rename so a crash mid-write cannot truncate it into a
file that reads back as "nothing held".

**Deploy note:** existing connected accounts were created before this shipped and are on
Stripe's automatic schedule. Run the audit with `--fix` after deploying, or their funds
are not being held at all. `account.updated` self-heals any account that emits an update,
but a dormant onboarded account may never emit one.
