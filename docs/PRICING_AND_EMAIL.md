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

⚠️ **Not 100% from public docs — verify from our own Stripe invoices.** Third-party sources report the £2 applying to Express accounts generally, while Stripe's own pricing page lists it only under "you handle pricing". Stripe Connect is already live, so **the definitive answer is on our Stripe dashboard billing page in 60 seconds.** Do that before any pricing is published. Earlier drafts of this doc asserted $2/mo and 25p/payout as fact — both were third-party USD figures and at least the payout fixed fee was wrong (10p, not 25p).

Marginal cost per active organiser/year, assuming model 1 confirmed:

| | |
|---|---|
| Email — SES, 5k contacts × 24 sends | ~$12 |
| Hosting / CDN (edge-cached) | ~$2 |
| Stripe Connect | **£0** (verify) |
| **Total** | **~$14/yr** |

If the £2 does apply, add ~$24/yr and the total becomes ~$38/yr — enough to make a $50/yr price break-even rather than a business. **This single dashboard check is the difference between those two worlds.**

Either way, **price on value not cost** — §7's anchors (Mailchimp $900/yr at 10k contacts, Squarespace £144/yr) set the price, not our margin floor.

### Payout timing is a free USP we are not using

| Platform | Organiser gets paid |
|---|---|
| Eventbrite | 3 days **after** the event, **20% of net sales withheld** for refunds/chargebacks until final payout, then 6–10 business days to arrive. Instant payout costs 3% (US only). |
| Skiddle | 3–5 business days after the event |
| Fatsoma | ~3 business days after the event |
| **WoCo** | **Direct charges land in the organiser's own Stripe balance on their normal Stripe payout schedule — money in hand before the event.** |

Being merchant of record is why the incumbents hold funds. Our direct-charge architecture means we never touch organiser money, so we can pay out faster than any of them at zero cost to us. **"Get paid before your event, not three weeks after"** is a stronger line for a cash-strapped promoter than any percentage.

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

**Correct `CLAUDE.md`:** the recorded Stripe figure ("UK/EU cards ~2% + 20p … includes Connect +0.5%") is wrong. Direct charges on connected accounts are **1.5% + 20p** for UK cards, 2.5% + 20p EEA, 3.25% + 20p international. Connect Express costs the **platform** $2/active account/month + 0.25% + 25p per payout — a per-organiser fixed cost, not a rate uplift.

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
