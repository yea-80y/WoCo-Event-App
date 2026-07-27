# Pricing + Email Architecture

Decision record. Verified figures, 2026-07-27. Companion to `docs/SEO_PLAN.md`.

Nothing here is built except §8 item 1. Treat §3 (the free/paid line) and §7 (tiers) as
the decisions to lock before any billing code is written.

---

## 1. The three "daily limits" — they are different things

These got conflated in discussion. Untangled:

| Limit | Whose | What it actually is |
|---|---|---|
| **100/day** | Resend | Free-tier transactional cap only. **No daily limit on any paid plan.** |
| **200/day** | AWS SES | **Sandbox.** A new SES account can only send 200/day, to *verified addresses only*, until you request production access. One-time onboarding gate, not a ceiling — production accounts start at 50k/day and scale on reputation. |
| **2,000/day** | **Ours** | `MARKETING_DAILY_CAP` in `lib/marketing/send-cap.ts:27`. We wrote it as a cold-list reputation guard. Not imposed by any provider. |

**So: no provider caps our sends once we are paid and out of sandbox.** Every daily number in the tier table below is our own product decision, and the current 2,000 flat default is wrong — see §3.

## 2. Resend billing — verified

Two independent product lines. Subscribe to one or both.

| | Billed on | Tiers |
|---|---|---|
| **Transactional** (`emails.send`) | emails sent | Free 3k/mo (100/day) · Pro $20/50k · $35/100k · Scale $90/100k → $1,150/2.5M · overage $0.90/1k → $0.46/1k |
| **Marketing** (Broadcasts) | **contacts stored** | Free 1k · $40 (5k) → $650 (150k) · **unlimited sends** |

Other: API rate limit 10 req/s per team. Domains 10 on Free/Pro, **1,000 on Scale**. Dedicated IP $30/mo (Scale only). Monthly billing only.

"Unlimited sends" is the *marketing* product's per-contact deal. We are on transactional, where sends are metered but have no daily cap on paid plans.

### Why broadcasts stay on `emails.send`

`POST /broadcasts` requires a `segment_id` — there is no ad-hoc recipient list. Using it means Resend must **durably store plaintext contacts**, which:

1. **Breaks the sealing model at rest.** Contacts are sealed client-side to the organiser's X25519 key on Swarm; the server holds only `emailHash`. Nuance worth stating honestly: even on `emails.send` Resend sees each plaintext address *in flight* — it is the recipient. The protection is over the **stored list**, not the address in transit (`CLAUDE.md` already records this: plaintext "transits import/check/broadcast bodies transiently — hashed-and-discarded"). Broadcasts converts transient exposure into a durable third-party copy, which is the part that changes `docs/legal/DATA_INVENTORY.md`.
2. **Bypasses suppression.** Enforced *inside* `sendMarketingBatch`. Resend-side sending never consults our list. Suppression is the legal control; it cannot be delegated.
3. **Bypasses RFC 8058 headers + provenance footer** — also unconditional in `sendMarketingBatch`.
4. **Costs ~40×.** 5,000 contacts × 24 sends/yr = 120k emails: Resend Marketing **$480/yr** vs transactional $42 vs SES **$12**.

There is no third option. Resend cannot send to an address it does not hold, so "Resend does the sending without storing the list" does not exist.

**Blacklisting risk is not about endpoint choice.** Resend documents no restriction on bulk via `emails.send`; the only stated limit is 10 req/s. Suspension — by Resend, Gmail and Yahoo alike — comes from complaint rate >0.3%, hard bounces, and missing one-click unsubscribe. Our existing controls are the right defence and are already built: server-side suppression, `List-Unsubscribe` + `List-Unsubscribe-Post`, unconditional footer, daily cap, webhook → global suppression.

**Still ask Resend** (§9 has the message). My expectation is they say yes — the Broadcasts product is a convenience layer (WYSIWYG, segments, no code), not a compliance wall, and bulk-over-transactional is common. But the downside of being wrong is a suspended sending domain mid-launch, against a five-minute cost to ask.

## 3. The free/paid line — LOCKED

Skiddle, Fatsoma and Eventbrite give organisers unlimited attendee emailing because they take 5–10% of ticket revenue. WoCo takes 1.5%, so the economics are tighter — but still fine: £50k of tickets = £750 of platform fee, and emailing a 5,000-person list 24×/yr costs **$12 on SES**.

**Decision: never charge an event-page organiser to email their own attendees.**

The paid line is not "email" — it is **imported lists and own-domain sending**:

| | Free, all tiers | Paid tiers |
|---|---|---|
| **Audience** | People who bought/claimed a ticket from you — an earned relationship | CSV imports from Skiddle/Fatsoma/RA — a migrated cold list |
| **Volume** | Unlimited, fair-use throttled | Tiered by **contacts stored** |
| **From** | `events@woco-net.com` | Organiser's own sending domain |
| **Code path** | event broadcasts — **already ungated** | `/api/marketing/broadcast` — **already gated** on `charges_enabled` (#59) |

The codebase already encodes this line exactly: `CLAUDE.md` records that event broadcasts are "deliberately ungated (attendee-relationship mail must not depend on Stripe)" while `/broadcast` requires `isVerifiedOrganiser`. **No re-architecture needed — only entitlement numbers on top.**

### Fair use, not a hard cap

The current flat 2,000/day is broken by design: it blocks an organiser with 2,001 contacts from announcing an event. **A cap must never sit below the list size.**

Replace with:
- **Attendee/event broadcasts:** no contact cap. Throttle *send rate* (concurrency, req/s) for reputation, never total volume. An organiser must always be able to reach everyone who bought from them.
- **Marketing lists:** daily cap = **the tier's contact allowance** (one full-list send per day, always possible), with a soft warning above ~2 sends/week per contact for burnout.

## 4. Ticket email ownership

**We send it, not Stripe.** `sendTicketEmail` (`routes/tickets.ts:218`) runs from the public `/send-email` route (`:292`) and the Stripe webhook (`routes/stripe.ts:1173`). It renders the 800×1100 composite PNG and attaches it `cid:`-inline.

Stripe *may* additionally send its own payment receipt — we pass `customer_email` (`routes/stripe.ts:626`), so if the organiser has receipts enabled on their connected account the buyer gets two emails. Not a bug; document it for organisers.

## 5. Organiser sending domains

**Marketing: built and automated.** `routes/marketing.ts` → Resend Domains API → `sending-domain-store.ts` caches `id/status/records`, verify-on-demand. `resolveMarketingFrom()`: verified organiser domain → `RESEND_FROM_MARKETING` → `RESEND_FROM`. Organiser adds domain → we return DNS records → they paste → click verify.

**Transactional: not built.** All ticket email ships from `getFromAddress()` — `"Event Title" <events@woco-net.com>`. Same for `attendee-gate.ts`, `shop-receipt.ts`, `sites.ts`.

Agreed: an organiser with their own domain will not accept platform-branded ticket email. But the **reputation split must hold** — `lib/email/client.ts:19` exists because "a bad campaign can never tank ticket-delivery reputation," and if tickets ride the organiser's marketing domain, a complaint-flagged campaign stops attendees receiving tickets on event day. Subdomain separation is the industry-standard fix:

- `tickets.venue.com` → transactional
- `mail.venue.com` → marketing

**Two Resend domains per organiser. Pro caps at 10 → ~5 organisers.** Scale (1,000 domains) is $90/mo. This is the constraint that forces SES, well before volume does.

`Reply-To`: currently only on the site contact form (`sites.ts:611`). `TicketEmailOpts.replyTo` is now plumbed but unsourced — wire `SiteContact.email` (`packages/shared/src/site/types.ts:263`) when `siteId` is present, else the verified sending domain, else omit.

## 6. SES migration

### Cost

| Item | Cost |
|---|---|
| Outbound, à la carte | **$0.10/1k** (no base fee) |
| Outbound, Essentials plan | $0.16/1k (no base fee) |
| Attachment data | $0.12/GB — ~100KB PNG per ticket, so 100k tickets ≈ 10GB ≈ **$1.20** |
| Dedicated IP (managed) | $15/mo — not needed initially |
| Virtual Deliverability Manager | $0.07/1k — optional, useful once organiser domains are live |
| Setup / account | **£0** |

| Monthly volume | Resend | SES |
|---|---|---|
| 50k | $20 | ~$5 |
| 100k | $35 | ~$10 |
| 500k | $350 | ~$50 |

### Engineering cost

| Work | Est. |
|---|---|
| SES provider behind the §8.1 seam | ~half day (seam done) |
| Per-organiser domain verification — verified identities + DKIM record generation + verification poll, replacing Resend's Domains API | **2–3 days** |
| SNS → bounce/complaint webhook (reshape existing handler) | ~1 day |
| Warmup + reputation monitoring | ongoing ops |

### Sandbox is not a scaling limit

New SES accounts are capped at **200/day to verified addresses only** until you request production access — a one-time support request. Production accounts start around 50k/day and the quota rises automatically with volume and good reputation. **File this the week we open the AWS account**, not the week we need it.

### Does launching on Resend create migration debt?

Partly, and it is entirely about **DNS records, not data**:

| Asset | Migrates? |
|---|---|
| Suppression list, contact blobs, `emailHash` values | **No migration** — all ours, on our disk and Swarm |
| Platform sending domain (`events@woco-net.com`) | New DKIM records in **our** DNS — we control it, trivial |
| **Organiser custom sending domains** | Each organiser must **re-do DNS** with new SES DKIM records. Support burden + bad look, proportional to how many we onboarded. |
| Domain reputation | Starts cold on SES. Warmup needed. |

**Sequencing decision: launch on Resend for platform-sent email only (tickets, event broadcasts from `events@woco-net.com`) — that carries zero migration debt. Do NOT onboard organiser custom sending domains until SES is live.** Since custom sending domain is a paid-tier feature anyway, this gates cleanly: ship the paid tier when SES ships.

**Migrate when either trigger fires:** Resend bill > ~$100/mo, **or** the first paid-tier organiser wants their own sending domain. The second will almost certainly come first.

## 7. Pricing

### Unit economics

**Stripe Connect has two pricing models, and which one we are on decides whether we pay anything at all** (stripe.com/gb/connect/pricing, UK figures):

| Model | Platform pays |
|---|---|
| **"Stripe handles pricing"** — Stripe sets and collects processing fees from the connected account | **£0.** No per-account fee, no payout fees. |
| **"You handle pricing"** — platform absorbs Stripe's cost and re-prices to sellers | **£2 per monthly active account** + **0.25% + 10p per payout**. "Active" = any month a payout is sent to their bank/debit card. |

**We are almost certainly on the first model.** WoCo uses direct charges, and Stripe's docs confirm the connected account bears processing: *"the charge amount—less the Stripe fees and application fee—is deposited into the connected account."* We never re-price processing; we add `application_fee_amount` on top. So the £2 and the payout fee should not apply to us.

⚠️ **Which model our account is billed under is not publicly determinable, and invoices will not show it while we are in sandbox.** Test mode charges no real Connect fees. The general pricing structure *is* clearly published (the two models above); what is account-specific is which one our platform was configured for at setup — that is a property of our account, not a documented default.

**Resolve it by asking Stripe support** (§10 has the message). Dashboard places to look first, though they will be empty until live charges exist:
- **Settings → Connect → Platform settings** — account types and fee configuration
- **Settings → Your fees / Pricing** — the platform's own Stripe fee schedule
- **Balance → Fees**, or any monthly invoice under **Billing** — once out of sandbox, per-account fees appear here as line items if they apply

Earlier drafts of this doc asserted $2/mo and 0.25% + 25p as fact; both were third-party USD figures and the payout fixed fee was wrong (10p GBP). Do not publish pricing on either number until Stripe confirms.

Marginal cost per active organiser/year, assuming model 1 confirmed:

| | |
|---|---|
| Email — SES, 5k contacts × 24 sends | ~$12 |
| Hosting / CDN (edge-cached) | ~$2 |
| Stripe Connect | **£0** (verify) |
| **Total** | **~$14/yr** |

If the £2 does apply, add ~$24/yr and the total becomes ~$38/yr — enough to make a $50/yr price break-even rather than a business. **This single dashboard check is the difference between those two worlds.**

Either way, **price on value not cost** — §7's anchors (Mailchimp $900/yr at 10k contacts, Squarespace £144/yr) set the price, not our margin floor.

### Payout timing is a RISK CONTROL, not a feature — LAUNCH BLOCKER

An earlier draft of this doc proposed fast payouts as a USP. **That was wrong and it is retracted.** Paying organisers before their event happens transfers refund risk onto WoCo, and Stripe's docs are explicit that we carry it:

> "for connected accounts where your platform is liable for negative balances (**including Custom and Express accounts**), **you're ultimately responsible for any disputes** involving those accounts." — docs.stripe.com/connect/disputes

> "If your platform is responsible for negative connected account balances, Stripe also **holds funds in your platform account in reserve**, and if a connected account's balance remains negative for 180 days, we transfer funds from the platform reserve to cover the negative amount." — docs.stripe.com/connect/risk-management

### Liability is a CONFIGURATION, not a property of the account type

This corrects an earlier claim in this doc that "Express means we own the liability". More precisely:

> "Responsibility for your connected accounts' negative balances can belong to your platform or to Stripe, **depending on your integration**." — docs.stripe.com/connect/risk-management

The determinant is `controller.losses.payments` (Accounts v1) or `defaults.responsibilities.losses_collector` (v2): **`application` = platform liable, `stripe` = Stripe liable.**

**Where we stand today:** `routes/stripe.ts:66` creates accounts with `type: "express"` and no explicit `controller` block. The legacy `type` shorthand implies `losses.payments = "application"`. **So WoCo is liable, by default, because we never chose otherwise.**

#### The recovery chain — the organiser genuinely is first

1. Refund/chargeback debits the **connected account's Stripe balance** — the organiser's own money
2. If insufficient, Stripe **debits their linked bank account**
3. If that fails, the balance stays negative and Stripe **holds funds in our platform account in reserve**, pending collection
4. **After 180 days negative, Stripe transfers from our reserve** to cover it

So we are the backstop of last resort, not the first payer — the onus *is* on the organiser, exactly as it should be. But Stripe freezes our money while chasing them, and we eat whatever is unrecoverable.

#### Managed Risk — the named product that removes the liability

Stripe's support bot supplied the correct term (2026-07-27). Verified against docs.stripe.com/connect/risk-management/managed-risk:

> "an end-to-end business risk management solution for platforms where Stripe provides ongoing monitoring and mitigation for credit and fraud risk. Stripe also assumes risk of loss in the event of unrecoverable negative balances on connected accounts."

> "You aren't liable for unrecoverable negative balances on your connected accounts."

Requirements, quoted from the same page:
- **"You must use direct charges."** — we already do ✅
- **"you must request the `card_payment` capability and the `full` Stripe Service Agreement type"** — we currently request `card_payments` + `transfers` (`routes/stripe.ts:68`), and do not set a service agreement type

Cost, quoted:
> "The fees for Managed Risk depend on the economic model: **Revenue share**: …we include Managed Risk at no additional cost. **Buy rate** — **Listed pricing**: …we include Managed Risk at no additional cost. **Negotiated pricing**: Managed Risk incurs additional fees."

So on listed pricing Managed Risk itself is free. **The docs do NOT say it removes the £2/monthly-active-account or payout fees** — the bot asserted that, unverified.

#### Three ways to reduce it

| | Control | Effect | Cost |
|---|---|---|---|
| **A** | Create accounts with `controller.losses.payments = "stripe"` | **Stripe bears the loss, not us** | Must integrate **embedded components** for onboarding, account management and the notification banner, replacing our current hosted Account Links flow. Stripe may underwrite more strictly or price it in. |
| **B** | **Delay payouts until after the event** (item 0) | Keeps funds in the organiser's balance so step 1 actually covers refunds | Payout-schedule config + a release job |
| **C** | Own percentage reserve held past the event date | Covers the late-refund tail | Ledger work |

**A and B are complementary, and B is required either way.** Even if Stripe bears the accounting loss, an organiser who has already spent the money means attendees struggle to get refunded — that is consumer harm and reputational damage to WoCo regardless of who absorbs the debit.

⚠️ **Decide A now, not later. "Dashboard type is immutable — to change a connected account's dashboard, you must create a new `Account` object."** Existing organiser accounts cannot be reconfigured. Every organiser onboarded under the current `type: "express"` call is permanently on platform-liable terms. The cost of this decision grows with every signup.

**The failure mode, concretely:** organiser sells 500 × £25 = £12,500. Stripe pays it into their balance on the default daily schedule. They spend it. Event is cancelled. 500 chargebacks hit their account, balance goes to −£12,500, they don't top it up. Stripe recovers from **our** platform reserve. One cancelled mid-size event wipes out the platform fee from ~£830k of ticket sales.

Note the onus *is* legally on the organiser — they are merchant of record, disputes are theirs to answer, and Stripe tries their external account first. But "legally liable" and "actually recoverable" are different things, and Stripe puts us last in line for the gap.

**This is why the incumbents hold funds.** Eventbrite's 3-days-after-event + 20% reserve is not incumbent sluggishness, it is the correct control for exactly this scenario, and the earlier draft mischaracterised it as a weakness.

#### How Eventbrite's 20% works

They withhold 20% of net sales from payouts as a **rolling reserve**. If refunds, chargebacks or a cancellation arrive, they draw from the withheld amount instead of chasing the organiser or absorbing it. The remainder is released in the final payout once the event has happened and the refund window has largely closed. Standard payments-industry practice — acquirers impose the same on higher-risk merchants, and event ticketing is a "future delivery" category precisely because the service is delivered long after the money is taken.

#### The controls Stripe gives us

| Control | Detail |
|---|---|
| **`delay_days_override`** | Balance Settings API, `payments.settlement_timing.delay_days_override`, **max 31 days**. Available to platforms that own fraud and dispute liability — **we qualify**, because Express means we already do. |
| **`interval: "manual"`** | Blocks automatic payouts entirely; platform releases funds via the Payouts API when it chooses. **The only control that covers events sold more than 31 days ahead** (festivals, early-bird). |
| **Platform reserve** | Stripe already holds one against our platform account for this liability. |

**Decision: default connected accounts to delayed payout, released after the event.** `delay_days_override` for short-lead events; `interval: "manual"` plus a post-event release job for anything beyond 31 days. Neither is built — this is a launch blocker for paid ticketing, ahead of every pricing item in §8.

Open design questions for that work: whether to hold 100% until after the event or release a portion earlier for organisers with a track record; whether to add our own percentage reserve on top; and how a multi-date/recurring event defines "after the event".

### Can we charge Connect fees back?

Only relevant if the dashboard check shows we are on model 2. Then yes, mechanically — raise `application_fee_amount`. £2/month ≈ 8 tickets at £25. But **do not itemise it**: Skiddle doesn't show organisers a line-item platform cost, and a visible surcharge invites resentment out of proportion to £2. Bake it into the headline percentage or absorb it.

### Competitive landscape

Website builders — what a venue compares hosting to:

| | Entry | Mid | Top |
|---|---|---|---|
| Squarespace UK (annual) | Basic £12/mo · £144/yr | Core £17 · Plus £29 | Advanced £79/mo |
| Wix (annual) | Light $17/mo | Core $29 · Business $39 | Elite $159/mo |

Email marketing — what a venue compares the Audience feature to:

| Mailchimp | 5,000 contacts | 10,000 contacts |
|---|---|---|
| Essentials | **$75/mo** ($900/yr) | $110/mo |
| Standard | $100/mo | $135/mo |

Mailchimp bills unsubscribed-but-unarchived contacts too. Our cost for a 10k list ≈ **$24/yr on SES**. This is the highest-margin thing WoCo ships.

Ticketing, on a £25 ticket — **corrected for the real Stripe rate**:

| Platform | Platform take | Processing | All-in |
|---|---|---|---|
| Skiddle | 10% + 25p | included | **£2.75** |
| Eventbrite | 6.95% + 59p | included | £2.33 |
| Fatsoma | 5% + 49p | included | £1.74 |
| Ticket Tailor (pay-as-you-sell) | ~$0.85 flat = £0.65 | own Stripe £0.575 | £1.23 |
| Ticket Tailor (prepaid) | ~$0.30 flat = £0.23 | own Stripe £0.575 | **£0.81** |
| **WoCo** | 1.5% = £0.375 | Stripe 1.5% + 20p = £0.575 | **£0.95** |

**Presentation matters more than the number.** Skiddle et al. are merchant of record and quote one all-in percentage; WoCo quotes 1.5% with Stripe visible on top, so organisers must do arithmetic to see we are cheaper. **Quote all-in: "~3.8% all-in vs Skiddle's 11%."**

### The Ticket Tailor problem

Flat fee vs percentage crosses over at **~£15.30/ticket**:

| Ticket | WoCo 1.5% | TT prepaid | Winner |
|---|---|---|---|
| £10 | £0.15 | £0.23 | WoCo |
| £15 | £0.225 | £0.23 | level |
| £25 | £0.375 | £0.23 | TT |
| £100 | £1.50 | £0.23 | TT, 6× |

**Decision: keep the percentage, add a per-ticket cap — "1.5%, never more than £1.00 per ticket."** Costs nothing on the £10–30 ticket that is most of the market, keeps WoCo cheapest against TT pay-as-you-sell at every price, and stops festivals and £80 dinners being structurally lost to TT.

Percentage stays the headline because the market is anchored on Skiddle's 10%. And TT has not won despite being cheap because prepaid credits are a cashflow ask and **TT brings no audience** — Skiddle and Fatsoma win on discovery, not price. WoCo's fight is audience + organiser-owned website + owned contact list.

### Tiers

Tier on what costs money: **contacts, sending domains, sites**. Do **not** tier on page views — post-edge-caching they are near-free, so it penalises success for no margin.

| Tier | Price | Sites | Storage | Ticket email from | Marketing contacts |
|---|---|---|---|---|---|
| **Event pages** | £0 forever | event pages only | — | `events@woco-net.com` | **n/a — unlimited to own attendees** |
| **Launch promo** (weeks only) | £0 | 1 | 100MB | platform | 500 |
| **Starter** | £8/mo annual (£96/yr) · £12 monthly | 1 | 1GB | platform | 2,000 |
| **Venue** | £24/mo annual (£288/yr) · £34 monthly | 3 | 5GB | **own subdomain** | 10,000 |
| **Brand** | £60/mo annual (£720/yr) · £80 monthly | 10 | 25GB | own subdomain | 50,000 |

- **Event-page organisers are free forever** and email their attendees without limit (§3). They are not a tier — they are the base platform, monetised by the 1.5%.
- Free *hosting* tier is a **time-boxed launch promo**, not permanent. Organisers actively selling tickets may keep hosting free by policy as a retention lever, unpublished.
- Marketing daily cap = the tier's contact allowance. Never below list size.
- Annual billing preferred — saves 11 × 20p of Stripe fixed fee per customer per year.
- Venue at £288/yr undercuts Mailchimp-alone (~$900/yr at 10k contacts) by ~3× **and** includes the website **and** the ticketing rail. That is the pitch.

## 8. Build order

| # | Item | Blocked on |
|---|---|---|
| **0** | 🚨 **DELAYED PAYOUTS — launch blocker, ahead of everything else.** Default connected accounts to hold funds until after the event: `delay_days_override` (≤31 days) for short-lead events, `interval: "manual"` + a post-event release job beyond that. Without this, one cancelled mid-size event lands ~£12.5k on WoCo's platform reserve (§7). | design sign-off on hold policy |
| 1 | ~~**Close the `lib/email/` seam**~~ ✅ 2026-07-27 `2eda035` — `lib/email/send.ts` single chokepoint, 5 call sites refactored, dead `poller.ts` send removed (recipient was a wallet address — always failed Resend validation). `build:server` clean, tests 41/41. | — |
| 2 | **Ask Resend** about broadcast volume on the transactional plan (§9) | user |
| 3 | **Open AWS account + file SES production-access request** — sandbox is 200/day | user |
| 4 | **`Reply-To` source** — `SiteContact.email` when `siteId` present → sending domain → omit. Wire at both `sendTicketEmail` callers. | nothing |
| 5 | **Fix `MARKETING_DAILY_CAP`** — per-tier, and never below the contact allowance (§3). Split attendee-broadcast throttling (rate) from marketing caps (volume). | §7 sign-off |
| 6 | **Entitlements store** — `.data/entitlements.json`, per-organiser tier; contacts / storage / sites / caps all read from it | §7 sign-off |
| 7 | **Per-ticket fee cap** — 1.5% capped at £1.00 in `application_fee_amount` (`routes/stripe.ts`); keep in sync with the 150bp escrow contract | §7 sign-off |
| 8 | **SES provider** behind the §8.1 seam | 3 |
| 9 | **SES domain verification** — verified identities + DKIM + poll, replacing Resend Domains API | 8 |
| 10 | **SNS bounce/complaint webhook** — reshape existing handler | 8 |
| 11 | **Transactional sending domain** — `resolveTransactionalFrom()`, separate subdomain, Venue+ | 6, 9 |
| 12 | **Stripe Billing subscription rail** for tiers (Billing, not Connect — WoCo is merchant here) | §7 sign-off |

**`CLAUDE.md` corrected 2026-07-27:** the old figure ("UK/EU cards ~2% + 20p … includes Connect +0.5%") was wrong. Direct charges on connected accounts are **1.5% + 20p** UK cards, 1.9% + 20p UK premium, 2.5% + 20p EEA, 3.25% + 20p international (+2% on currency conversion). **No Connect uplift on the processing rate.** Platform-side Connect fees are a separate question still open with Stripe — see §11 and §13; do not build against a number until they answer.

### Two independent tracks

Items 0 and 7 and 12 are **payments**; items 1–6 and 8–11 are **email**. Only 5, 6 and 7 share a dependency (§7 tier sign-off). The email track is not blocked by the Stripe questions — see the split in §14.

## 9. Message to Resend support

> Hi — we run an event ticketing platform. We send two kinds of email through your API:
>
> 1. **Transactional** — ticket confirmations, verification codes, receipts. Currently ~low thousands/month.
> 2. **Marketing** — organiser newsletters and event announcements to their own opted-in contact lists.
>
> For privacy reasons we cannot store contact lists with you: our organisers' lists are encrypted client-side and held on decentralised storage, and our server only ever holds HMAC hashes of the email addresses. That means Broadcasts/Segments is not usable for us, since it requires contacts to be stored in an Audience.
>
> So we send marketing via `POST /emails` one recipient at a time, with our own compliance layer: server-side suppression checked on every send, RFC 8058 `List-Unsubscribe` and `List-Unsubscribe-Post` headers, a visible unsubscribe link and provenance footer on every message, per-organiser volume caps, and your bounce/complaint webhooks feeding a global suppression list.
>
> Two questions:
>
> 1. Is sending marketing/newsletter volume through the transactional `/emails` endpoint acceptable on a Pro or Scale plan, or do you require Broadcasts for that traffic?
> 2. We plan to let organisers send from their own verified domains via the Domains API — two subdomains each (one transactional, one marketing) to keep reputations separate. Any guidance on volume or domain count at that shape?
>
> Thanks.

## 10. Message to Stripe support

> Hi — we run an event ticketing platform on Connect. Express connected accounts, **direct charges** on the connected account with `application_fee_amount` for our platform fee (no `transfer_data`). We're UK-based, currently in sandbox, preparing to go live.
>
> Three questions:
>
> 1. **Connect fees to us.** Your Connect pricing page lists £2 per monthly active account and 0.25% + 10p per payout under the "you handle pricing" model, and no platform fees under "Stripe handles pricing". With direct charges where Stripe fees are netted from the connected account's balance, which model is our platform billed under? Please confirm the exact fee schedule on our account so we can price correctly — sandbox invoices don't show this.
>
> 2. **Payout timing controls.** As an event platform we need to hold organiser funds until after the event has happened, because we're liable for unrecoverable negative balances on Express accounts and a cancelled event would otherwise leave us carrying the refunds. Can we set `payments.settlement_timing.delay_days_override` on our Express accounts, and is `interval: "manual"` available to us for events sold more than 31 days ahead? Any recommended pattern for this in ticketing.
>
> 3. **Platform reserve.** What reserve, if any, will Stripe hold against our platform account for connected-account negative balance liability, and how is it sized?
>
> 4. **Loss liability.** We create accounts with `type: "express"` and no explicit `controller` block, so we believe `controller.losses.payments` is `application` — please confirm. Can we instead create accounts with `controller.losses.payments = "stripe"` so Stripe carries negative balances? If so: what else must change (we understand embedded components are required for onboarding and account management), does it affect our pricing or underwriting, and can existing Express accounts be migrated or must new `Account` objects be created?
>
> Thanks.

## 11. Stripe support — bot reply assessment (2026-07-27)

Stripe's automated chat answered §10. Sorted by whether it holds up.

### Verified — accept

| Claim | Status |
|---|---|
| Managed Risk exists and removes platform liability for unrecoverable negative balances | ✅ quoted in §7 |
| Managed Risk requires direct charges | ✅ "You must use direct charges" — we already do |
| Managed Risk is compatible with direct charges + application fees | ✅ direct charges required; application fees not contradicted |
| `controller.losses.payments = "application"` on our accounts today | ✅ matches `routes/stripe.ts:66` (`type: "express"`, no controller block) |
| Existing Express accounts cannot be migrated — new `Account` objects required | ✅ consistent with "Dashboard type is immutable" |
| `delay_days` max 31 | ✅ "up to 31" |
| Reserve sized 1:1 against connected-account negative balances, releases as they fall, visible on **Balance → Reserved funds** | plausible, consistent with the risk-management page's "pending the collection of the funds"; accept provisionally |

### Contradicts our source — unresolved

**Payout fee: bot says 0.25% + 25p "globally"; stripe.com/gb/connect/pricing says 0.25% + 10p.** The bot appears to be generalising the USD $0.25 figure. The GB page is country-specific and should win, but this needs a human to confirm. Do not price on either number yet.

### Asserted but NOT in the documentation — treat as unknown

1. **"90-day holding period for UK accounts — after 90 days you must pay out."** Nowhere in docs.stripe.com/connect/manage-payout-schedule. **If true this is an architectural constraint**: manual payouts could not hold funds for an event sold more than 90 days ahead — festivals, early-bird tiers. Must be confirmed before designing the hold policy.
2. **"With Managed Risk you pay no Connect fees — no £2/account, no payout fees."** The Managed Risk page says only that Managed Risk *itself* is at no additional cost on listed pricing. It does not say the per-account or payout fees disappear.

### Not answered

**Q1, our fee model.** The bot said "you're under the 'you handle pricing' model" but then: "check your platform agreement or contact your account manager — some platforms negotiate custom pricing." It did not read our account. Still open, and still blocks publishing pricing.

### The bot's recommendation is rejected

It recommended keeping platform liability plus manual payouts, and budgeting for the Connect fees — having just stated that the alternative carries neither liability nor extra cost. Its stated reason is that Managed Risk "reduces your control over risk decisions" and Stripe "may pause payouts before an event completes."

That concern is worth probing, but it does not outweigh the exposure. WoCo is pre-launch with no balance sheet to absorb a cancelled festival. Accepting an uncapped tail liability to preserve discretion over payout timing is the wrong trade at this stage. **Position: pursue Managed Risk for new accounts, and build delayed payouts regardless** — delayed payouts protect attendees' ability to actually get refunded, which matters whoever absorbs the accounting loss.

## 12. Negotiated pricing — real, but coupled

Stripe formally documents three economic models for platforms (docs.stripe.com/connect/risk-management/managed-risk, quoted):

> "The fees for Managed Risk depend on the economic model:
> - **Revenue share**: …we include Managed Risk at no additional cost.
> - **Buy rate** — **Listed pricing**: …we include Managed Risk at no additional cost.
> - **Buy rate** — **Negotiated pricing**: Managed Risk incurs additional fees. For more information, contact Stripe Sales."

So negotiation is a documented track, not a favour. **But note the coupling: negotiating your rate down is what makes Managed Risk cost extra.** On listed pricing or revenue share it is free. Do not assume "negotiate everything down" is strictly better — a lower processing rate could cost more than it saves once Managed Risk is priced in.

Also: Stripe's support bot noted "some platforms negotiate custom pricing that differs from the published rates" and pointed at an account manager. Negotiating leverage is volume-based, and WoCo is pre-launch with none. Realistic position: ask what monthly processing volume unlocks a negotiated rate, and stay on listed pricing until then so Managed Risk stays free.

## 13. Stripe follow-up — ask for a human

The bot left four things open. Reply on the same thread asking for a human, referencing the terms it gave us.

> Thanks — that helps, but four points are still open and I'd like a human to confirm them, as we're about to build against these answers.
>
> 1. **Payout fee — 25p or 10p?** You said 0.25% + 25p "globally", but stripe.com/gb/connect/pricing states **0.25% + 10p per payout sent** for the UK. We're a UK platform. Which applies to us?
>
> 2. **Maximum hold period.** You said UK accounts can only hold funds for 90 days with `interval: "manual"`, and must pay out after that. I can't find that documented anywhere — docs.stripe.com/connect/manage-payout-schedule doesn't mention it. Can you confirm whether a maximum holding period exists for UK connected accounts, and what it is? This is critical for us: festival and early-bird tickets sell more than 90 days before the event, and if we can't hold funds that long we need a different design.
>
> 3. **Managed Risk and Connect fees.** You said that with Managed Risk we'd pay no £2/monthly-active-account fee and no payout fees. The Managed Risk documentation only says Managed Risk *itself* is included at no additional cost on listed pricing or revenue share. Please confirm explicitly: under Managed Risk, are we still charged the per-active-account fee and per-payout fees, or not?
>
> 4. **Our actual fee schedule.** You said to check our platform agreement or speak to an account manager. We don't have an account manager. Can you tell us, or route us to someone who can, exactly which pricing model our platform is on and what Connect fees we will be charged in live mode?
>
> Also, two things for whoever picks this up:
>
> - We want **Managed Risk** for new connected accounts. We currently create them with `type: "express"` and no controller block. What exactly changes in our `accounts.create` call — we've seen we need the `card_payment` capability and the `full` Stripe Service Agreement type. Is Managed Risk something we need approving for, given we're an event ticketing platform, and is there an application process?
> - What monthly processing volume would make us eligible for negotiated pricing, and would moving to negotiated pricing mean Managed Risk stops being free?
>
> Thanks.

## 14. Email track — standalone to-do

The Stripe questions block nothing here. This track can run to completion while Stripe support replies.

### Ready now — no blockers

| | Item | Detail |
|---|---|---|
| ✅ | **ESP seam** | Done `2eda035`. `lib/email/send.ts` is the single chokepoint. |
| **E1** | **`Reply-To` source** | `TicketEmailOpts.replyTo` is plumbed but nothing populates it. Wire `SiteContact.email` (`packages/shared/src/site/types.ts:263`) when `siteId` is present → verified sending domain → omit. Both callers: `routes/tickets.ts:292`, `routes/stripe.ts:1173`. Attendee replies currently go nowhere. |
| **E2** | **Fix the daily cap** | `MARKETING_DAILY_CAP` is a flat 2,000/day (`lib/marketing/send-cap.ts:27`). Blocks an organiser with 2,001 contacts from announcing an event. Split: attendee/event broadcasts get *rate* throttling only (no volume ceiling); marketing lists get a cap that is never below the contact allowance. Make the number a per-organiser lookup, defaulted, so E5 can drive it. |
| **E3** | **Stripe receipt collision** | We pass `customer_email` (`routes/stripe.ts:626`) so buyers may get Stripe's receipt *and* our ticket email. Decide: suppress Stripe receipts on connected accounts, or document it. |

### Blocked on the user

| | Item | Why |
|---|---|---|
| **E4** | Message Resend (§9) | Confirms broadcast-over-transactional is acceptable |
| **E6** | Open AWS + file SES production access | Sandbox is 200/day to verified addresses only. **File early — it gates E7–E9.** |

### Blocked on tier sign-off (§7)

| | Item |
|---|---|
| **E5** | **Entitlements store** — `.data/entitlements.json`, per-organiser tier. Contacts, storage, sites and the E2 cap all read from it. This is the keystone: nothing tiered can ship before it. |

### Blocked on SES

| | Item | Blocked on |
|---|---|---|
| **E7** | SES provider behind the seam (~half day) | E6 |
| **E8** | SES domain verification — identities + DKIM + poll, replacing Resend's Domains API (**2–3 days, the real cost**) | E7 |
| **E9** | SNS bounce/complaint webhook — reshape the existing handler | E7 |
| **E10** | Transactional sending domain — `resolveTransactionalFrom()`, separate subdomain, Venue tier+ | E5, E8 |

### Ordering note

**Do not onboard a single organiser custom sending domain on Resend** (§6). Each needs two Resend domains, Pro caps at 10, and migrating them to SES means every organiser re-does their DNS. Own-domain sending ships with E10, after SES — not before.
