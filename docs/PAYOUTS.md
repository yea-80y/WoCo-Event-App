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
| `lib/stripe/payout-intents.ts` | `.data/stripe-payout-intents.json` — write-ahead journal of in-flight payouts (see Crash safety). |
| `lib/stripe/payout-release.ts` | The sweep: decides what is due, pays it, marks it. Hourly. |
| `lib/stripe/payout-schedule.ts` | `ensureManualPayoutSchedule()` — sets `interval: "manual"`. |
| `scripts/payout-schedule-audit.ts` | Audits (and with `--fix`, corrects) the schedule on every existing account. |
| `GET /api/stripe/payouts` | Organiser's own held/released takings. Backs the terms' promise to tell them when funds release. |
| `lib/stripe/payout-view.ts` | Ledger → the organiser-facing response. `netIsFinal` + settlement-currency keying live here. |
| `POST /api/stripe/dashboard-link` | Single-use Express Dashboard login link ("Manage bank details"). Minted per click, never stored or emailed — Stripe's own rule. |
| `creator/payouts/PayoutsScreen.svelte` | The organiser's Payouts screen at `#/creator/payouts` (issue #93). |
| `creator/payouts/payouts-model.ts` | Pure grouping/totalling/labelling for that screen. |
| `test/payout-release.test.ts` · `test/payout-view.test.ts` | 36 tests over the failure modes below; 13 over the organiser-facing response. |

Wired into `routes/stripe.ts`: `interval: "manual"` at account creation; a self-healing
correction on `account.updated`; a ledger entry on every paid session (tickets **and**
shop orders); a void on full auto-refund. Sweep starts in `index.ts`.

### Why a per-sale ledger and not "pay out the balance"

A connected account has **one pooled balance across every event it has ever sold.** An
organiser with a gig next week and a festival in six months has both sets of takings in
the same pot. Paying out the available balance after the gig hands over the festival's
advance too. The ledger is what makes "release only what *this* event earned" expressible.

### Amounts are net, read from Stripe — fresh, every sweep

Released amounts come from the charge's **balance transaction** (`bt.net`), not from our
own arithmetic: gross − Stripe processing − our `application_fee_amount`, then minus each
refund's own (negative) balance transaction. Whether a refund returns the processing fee
varies by region, and whether it returns our application fee depends on
`refund_application_fee` — so we read what Stripe actually did rather than predict it.

The ledger's `netAmount` is a **reporting cache only** — the sweep re-resolves from
Stripe on every run while an entry is held, because a refund can land between sweeps
(there is no `charge.refunded` webhook wired) and a trusted cache would pay out the
pre-refund value.

The balance transaction is also where the **settlement currency** comes from: a charge
presented in a currency the account has no bank account for is converted to the
account's default currency (verified against Stripe's payouts doc). Such an entry gets
`settlementCurrency` recorded and regroups under it next sweep, so it releases from the
balance the money actually sits in — instead of polling an empty balance until it
breaches the hold ceiling.

### What the organiser sees (issue #93)

`#/creator/payouts`: held / next release / paid-out-to-date per currency, then
every sale grouped under the event that earned it. Three things it must keep
doing, because each is a promise about real money:

- **Held totals are labelled estimates** while any `netIsFinal` is false. A refund
  can still land before release, so a held figure is never stated as fact.
- **Ceiling-forced releases are visible**, badged "Released early" with the reason.
  §3.1 sales are where attendee protection does not hold; silence there is the
  failure mode.
- **A converted charge shows its settlement currency**, matching how the server
  keys `heldByCurrency` — otherwise the tiles stop equalling the rows.

Amounts are integer minor units end to end, divided once at the formatting edge
(`formatMinor`). The copy says "delayed payouts", never "escrow" (§1).

### Crash safety — the intent journal

"Same selected set ⇒ same idempotency key" is not crash-safe on its own: if a new entry
becomes due between the crash and the next sweep, the re-selected set differs, the key
differs, and the original set is paid a second time. So the sweep **journals a payout
intent** (`.data/stripe-payout-intents.json` — exact set, amount, key) BEFORE calling
Stripe, tags the payout `metadata.woco_intent`, pays, then marks the whole set released
in ONE ledger write and clears the intent.

A pending intent must settle before anything new is paid for that account+currency:

1. **Confirm** — `payouts.list` finds `woco_intent` ⇒ the payout happened; mark the
   ORIGINAL set with its id.
2. **Replay** — provably absent and the intent is <20h old ⇒ re-send verbatim under the
   original key (Stripe prunes keys at 24h; 20h is the safety margin).
3. **Abandon** — provably absent and past the window ⇒ clear the intent; entries are
   still held and re-enter normal selection with freshly resolved nets.
4. **Freeze** — the lookup itself failed ⇒ do nothing for this group this sweep.

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

### 3.2 The manual schedule IS the lock for Express — confirmed 2026-07-29

Earlier revisions of this section treated the platform-controls page's warning
("connected accounts can still make manual payouts…") as applying to us and called the
hold advisory. **Stripe support corrected this in writing (live chat, 2026-07-29):**

> "Express Dashboards has limited capabilities … Even if the payout plan is set to
> manual, it doesn't mean that they will have the ability to process or initiate payout
> from their Express Dashboard. Rather, the platform has to manually process the payout."

The [Express Dashboard doc](https://docs.stripe.com/connect/express-dashboard) squares the
two: schedule editing and self-payout exist for Express **only "if you've enabled it"** —
platform-configurable capabilities, and we have NOT enabled them. The stronger warning on
the platform-controls page concerns dashboards where those capabilities are on.

So for our accounts: on `interval: "manual"`, only the platform can move funds. No support
grant is needed. Defence-in-depth stays regardless: the `account.updated` self-heal
re-applies a manual schedule, and the sweep retries failed heals (#85) — a config drift
must correct itself, not wait to be noticed.

Support also confirmed (same chat): **payout schedules are unaffected by Managed Risk.**

---

## 4. Our Connect configuration — Managed Risk (shipped, issue #90)

Since #90, `POST /api/stripe/connect` creates every account with **controller
properties**, never `type` (`lib/stripe/account-params.ts`, pinned by
`test/account-params.test.ts`):

| | Value | Meaning |
|---|---|---|
| `controller.stripe_dashboard.type` | `express` | Stripe-hosted Express Dashboard |
| `controller.fees.payer` | `account` | organiser pays Stripe processing fees |
| `controller.losses.payments` | `stripe` | **Stripe** absorbs unrecoverable negative balances |
| `controller.requirement_collection` | `stripe` | Stripe-hosted onboarding collects KYC |
| Payout schedule | `manual` at creation | unaffected by Managed Risk (chat, 2026-07-29) |

The £2/monthly-active and 0.25%+10p payout fees fall away (`fees.payer=account`);
`application_fee_amount` (1.5%) continues — confirmed in writing, twice (§6.5).

The loss waterfall for a refund/dispute on an empty balance: the organiser's
connected account is debited first (they are merchant of record on direct
charges); the unrecoverable remainder is **Stripe's**, not WoCo's. The §3.1
finding is why this matters: for long-lead sales the payout hold cannot protect
anyone, so who carries the negative balance is the only real control.

**`type: "express"` is incompatible with Managed Risk** — it bakes in
`controller.losses.payments = "application"` permanently; such an account can
only be retired, never converted. `payout-schedule-audit.ts` flags any
platform-liable account; `retire-legacy-accounts.ts` deletes zero-balance ones
(pre-launch test accounts — the organiser re-onboards via /connect).

Everything in §2 is still required: an organiser paid before their event who
then cancels leaves attendees unrefundable regardless of who absorbs the
accounting loss.

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

## 6. RESOLVED with Stripe (chat + specialist email, 2026-07-29) — built as #90

Both halves of the old ask are answered; the code change shipped as issue #90
(§4 is the configuration record). Remaining ops: verify Radar is enabled for
connected transactions (dashboard), retire the legacy test accounts, and
re-verify onboarding → checkout → release on a fresh account.

1. **Self-payout restriction: not needed.** Express Dashboard cannot initiate payouts and
   we have not enabled schedule editing — §3.2 has the verbatim confirmation.
2. **Schedules survive Managed Risk: confirmed.** "Payout schedule is not affected by
   Managed Risk" (chat, 2026-07-29).
3. **The Managed Risk recipe (specialist email):** `type: "express"` is INCOMPATIBLE with
   Managed Risk (`controller.losses.payments = "application"` is baked in). Accounts must
   be CREATED with controller properties instead:
   `controller[stripe_dashboard][type]=express · controller[fees][payer]=account ·
   controller[losses][payments]=stripe · controller[requirement_collection]=stripe`,
   plus Radar configured on connected transactions. **Never onboard a real organiser on
   `type: "express"`** — such an account is permanently platform-liable.
4. **Disputes** (same email): Stripe debits the connected account's balance first; with
   `losses.payments = "stripe"` the unrecoverable remainder is Stripe's. Express
   Dashboard has no dispute UI — Connect embedded components can provide it in our UI
   later; the platform can also respond via API.
5. **Application fee: confirmed in writing, twice** — continues "regardless of account
   type and if they are under Managed Risk or not" (chat, 2026-07-29; also §17).

**Refund window — RESOLVED (Stripe support, in writing, 2026-07-29):** there is **no
technical time limit** on issuing a refund via the API or dashboard. Reliability, not
permission, is the constraint:

> "We're confident that up to 90 days, any refund you issue will behave as expected.
> Refunds issued a little while after this — say, 100 or 120 days instead of 90 days —
> will very likely work fine. Refunds issued much longer after this — say, 6 months
> later — will have a sharply increased likelihood of experiencing some issue."

The common failure is a closed/changed customer account; banks often recover (some mail
the former cardholder a check), some don't. A refund can never be routed to a different
payment method. Stripe's guidance for old charges: check with the customer that the card
is still active first; if not, the merchant settles up directly (organiser bank transfer).
FAQ: support.stripe.com/questions/refunds-faq.

**What this means for us:** the reliable-refund window (~90 days from charge) aligns
exactly with the §3.1 payout hold — every sale the hold protects is also reliably
refundable. The exposed long-lead tail is exposed twice: those funds release to the
organiser pre-event AND their refunds get less reliable with age (materially so from
~6 months). Reinforces the §3.1 product levers on very long on-sale windows; organiser
out-of-band reimbursement is the documented fallback and is the organiser's obligation
either way (ORGANISER_TERMS §6).

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

✅ **Host hardening done 2026-07-27.** The live store was directory `755` / files `644` —
world-readable to any host account — as were `server.env` (which holds `FEED_PRIVATE_KEY`,
both Stripe webhook secrets, `EMAIL_HASH_SECRET`, `PAYMENT_QUOTE_SECRET` and
`SHOP_SPENDER_SECRET`) and the Cloudflare tunnel token, which sat on cloudflared's
command line and so was readable from `/proc/<pid>/cmdline` by any user.

| | Before | After |
|---|---|---|
| `/opt/woco/woco-data` | `755` dirs / `644` files | `700` / `600` |
| `/opt/woco/server.env` | `644` | `600` |
| `/opt/woco/docker-compose.yml` | `644` | `600` |
| Tunnel token | `ExecStart --token …` (cmdline is world-readable `444`) | `EnvironmentFile=/etc/cloudflared/env` `600`; `environ` is `400` owner-only |

Safe because the server container runs as **uid 0** — it bypasses the mode bits, so
tightening them cannot stop it writing. Verified after the change: container write+read+
delete inside `.data`, the payout audit reading `stripe-accounts.json`, both tunnel
hostnames serving, and `setpriv` as an unprivileged uid denied on both paths. Rollback:
`/root/woco-data.modes.bak.*` (exact prior modes) and `/root/cloudflared.service.bak.*`.

> ⚠️ **If the Dockerfile ever gains a `USER` directive**, root-owned `600` files become
> unreadable to the server and every store breaks at once. The mode tightening is only
> safe while the container is root.

> ⚠️ **Still open:** no encryption at rest beyond the provider's disk, and **no verified
> backup of `woco-data`** — a lost ledger strands organiser funds. That is now the largest
> remaining risk to this store, and it is a data-loss risk rather than an access one.

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

`.data/stripe-payout-intents.json` is in the same class: it is the only record of an
in-flight payout, and losing it between a Stripe call and the ledger write is exactly
the double-pay window the journal exists to close.

**Deploy note:** existing connected accounts were created before this shipped and are on
Stripe's automatic schedule. Run the audit with `--fix` after deploying, or their funds
are not being held at all. `account.updated` self-heals any account that emits an update,
but a dormant onboarded account may never emit one.
