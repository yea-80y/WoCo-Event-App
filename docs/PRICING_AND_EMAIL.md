# Pricing + Email Architecture

Decision record. Verified figures, 2026-07-27. Companion to `docs/SEO_PLAN.md`.

---

## 1. Resend billing — verified

Resend runs **two independent product lines**. You subscribe to one or both.

| | Billed on | Tiers |
|---|---|---|
| **Transactional** (`emails.send`) | **emails sent** | Free 3k/mo (**100/day cap**) · Pro $20/50k · $35/100k · Scale $90/100k → $1,150/2.5M · overage $0.90/1k falling to $0.46/1k · **no daily limit on paid** |
| **Marketing** (Broadcasts/Segments) | **contacts stored** | Free 1k contacts · $40 (5k) → $650 (150k) · **unlimited sends** |

Other limits: API rate limit **10 req/s per team** (raisable). Domains: 10 on Free/Pro, 1,000 on Scale. Dedicated IP $30/mo, Scale only. Monthly billing only — no annual discount.

## 2. We are on the transactional product, and that is correct

`marketing-send.ts` calls `resend.emails.send()` per recipient. Contacts never reach Resend — they are sealed client-side to the organiser's X25519 key and stored on Swarm; the server holds only `emailHash` values.

**Switching broadcasts to Resend Broadcasts was considered and rejected.** `POST /broadcasts` requires a `segment_id` — there is no ad-hoc recipient list. Using it means uploading plaintext contacts to Resend, which:

1. **Breaks the sealing model** — plaintext attendee/marketing emails become resident at a third-party processor. Changes the GDPR posture in `docs/legal/DATA_INVENTORY.md`.
2. **Bypasses the suppression guarantee** — server-side suppression is enforced *inside* `sendMarketingBatch`. Resend-side sending consults our list never. Suppression is the legal control; it cannot be delegated.
3. **Bypasses RFC 8058 headers + provenance footer** — also unconditional inside `sendMarketingBatch`.
4. **Costs ~40× more.** 5,000 contacts × 24 sends/yr = 120,000 emails:

| Path | Annual cost |
|---|---|
| Resend Marketing, 5k contacts | **$480** |
| Resend transactional (@ $0.35/1k) | $42 |
| SES à la carte (@ $0.10/1k) | **$12** |

**Blacklisting risk is not about which endpoint you call.** Resend documents no restriction on bulk via `emails.send`, and Gmail/Yahoo/Resend all suspend on the same signals: complaint rate (>0.3%), hard-bounce rate, and missing one-click unsubscribe. Our existing machinery — server-side suppression, RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post`, unconditional footer, `MARKETING_DAILY_CAP`, Resend webhook → global suppression on bounce/complaint — is precisely the right defence and is already built. **Keep the architecture; the risk is managed by reputation hygiene, not by endpoint choice.**

Open item: confirm with Resend support that broadcast volume on the transactional plan is acceptable. Cheap to ask now, expensive to discover at scale.

## 3. Ticket email ownership

**We send it, not Stripe.** `sendTicketEmail` (`routes/tickets.ts:218`) is called from the public `/send-email` route (`:292`) and from the Stripe webhook (`routes/stripe.ts:1173`). It renders the 800×1100 composite PNG and attaches it `cid:`-inline.

Stripe *may* additionally send its own payment receipt: we pass `customer_email` at `routes/stripe.ts:626`, so if the organiser has receipts enabled on their connected account the buyer gets two emails. Not a bug — worth documenting for organisers.

## 4. Organiser sending domains — current state

**Marketing: built and automated.** `routes/marketing.ts` → Resend Domains API → `sending-domain-store.ts` caches `id/status/records`, verify-on-demand. `resolveMarketingFrom()`: verified organiser domain → `RESEND_FROM_MARKETING` → `RESEND_FROM`. Organiser adds domain → we return DNS records → they paste into their DNS → they click verify. Gated on `isVerifiedOrganiser` (#59).

**Transactional: not built.** Every ticket email ships from `getFromAddress()` unconditionally — `"Event Title" <events@woco-net.com>`. Same for `attendee-gate.ts:172`, `shop-receipt.ts:79`, `sites.ts:609`, `domains/poller.ts:41`.

**Reputation constraint (load-bearing).** `lib/email/client.ts:19` splits marketing from transactional so "a bad campaign can never tank ticket-delivery reputation." Putting ticket emails on the organiser's domain makes ticket delivery depend on *their* domain reputation — a complaint-flagged campaign then stops attendees receiving tickets on event day. So organiser-branded ticket email must use a **separate subdomain**:

- `tickets.venue.com` → transactional
- `mail.venue.com` → marketing

Two Resend domains per organiser. Fits the 10-domain Pro cap for ~5 organisers only → **Scale plan (1,000 domains) becomes the constraint that forces the SES migration**, not volume.

`Reply-To` is currently set only on the site contact form (`sites.ts:611`). Ticket emails have none, so attendee replies go nowhere. Fix: `replyTo` = `SiteContact.email` when `siteId` is present (`packages/shared/src/site/types.ts:263`), else the verified sending domain, else omit. Independent of any tier work.

## 5. SES migration

À la carte **$0.10/1k**, no base fee (Essentials $0.16/1k, also no fee). Attachment data $0.12/GB — every ticket carries an ~100KB PNG, so 100k ticket emails ≈ 10GB ≈ $1.20. Negligible.

| Monthly volume | Resend | SES à la carte |
|---|---|---|
| 50k | $20 | ~$5 |
| 100k | $35 | ~$10 |
| 500k | $350 | ~$50 |

**Migrate when either trigger fires:** Resend bill > ~$100/mo, **or** organiser sending domains > ~5 (the Pro 10-domain cap; Scale is $90/mo).

Cost beyond the send path — do not underestimate these:
- **Per-organiser domain verification.** Resend's Domains API is our DNS authority today. On SES this becomes per-organiser verified identities + DKIM record generation + a verification poller. ~2–3 days.
- **Sandbox.** New SES accounts are capped at 200 emails/day to verified addresses only. Production access is a support request — **file it weeks early**, not the week you need it.
- **Reputation ownership.** Warmup, complaint monitoring, and suppression-list management move in-house. SNS → our existing bounce/complaint webhook shape.

**Send path: seam closed (2026-07-27).** `lib/email/send.ts` is now the single chokepoint — `OutboundEmail` + `EmailProvider`, provider chosen by `EMAIL_PROVIDER` (default `resend`, unknown value throws at startup rather than silently dropping ticket email). All five leaking call sites refactored; no `emails.send()` outside `lib/email/`. SES becomes one new provider file plus one `switch` branch.

**Deliberately not abstracted yet** — the remaining Resend surface, which is the real migration work:

| Surface | Where | SES equivalent |
|---|---|---|
| Domains API (`create`/`verify`/`get`/`remove`) | `routes/marketing.ts:348–415` | Verified identities + DKIM records + own verification poll |
| Webhook signature verify | `routes/resend-webhook.ts:50` | SNS subscription + signature verify |
| Config-presence check | `routes/broadcast.ts:26`, `routes/marketing.ts:203` | trivial |

These are left concrete on purpose: Resend Domains and SES identities have genuinely different shapes, and inventing the abstraction before there is an SES implementation to design against would produce the wrong one.

## 6. Competitive landscape

**Website builders** — what a venue compares hosting to:

| | Entry | Mid | Top |
|---|---|---|---|
| Squarespace UK (annual) | Basic £12/mo · £144/yr | Core £17 · Plus £29 | Advanced £79/mo |
| Wix (annual) | Light $17/mo | Core $29 · Business $39 | Elite $159/mo |

**Email marketing** — what a venue compares the Audience feature to:

| Mailchimp | 5,000 contacts | 10,000 contacts |
|---|---|---|
| Essentials | **$75/mo** ($900/yr) | $110/mo |
| Standard | $100/mo | $135/mo |

Mailchimp bills archived-but-unsubscribed contacts too. **Our cost for the same 5,000-contact list is ~$12/yr on SES.** This is the highest-margin thing WoCo ships.

**Ticketing** — on a £25 ticket:

| Platform | Fee | Platform take | + payment processing | All-in |
|---|---|---|---|---|
| Skiddle | 10% + 25p | £2.75 | included | £2.75 |
| Eventbrite | 6.95% + 59p | £2.33 | included | £2.33 |
| Fatsoma | 5% + 49p | £1.74 | included | £1.74 |
| Ticket Tailor (pay-as-you-sell) | ~$0.85 flat | £0.65 | own Stripe 1.5%+20p = £0.58 | £1.23 |
| Ticket Tailor (prepaid credits) | ~$0.30 flat | £0.23 | own Stripe = £0.58 | **£0.81** |
| **WoCo** | 1.5% | £0.375 | Stripe Connect ~2%+20p = £0.70 | **£1.08** |

### The Ticket Tailor problem is real

Flat fee vs percentage crosses over. WoCo's 1.5% beats $0.30 prepaid below **~£15.30/ticket** and loses above it — badly at the top:

| Ticket price | WoCo 1.5% | TT prepaid | Winner |
|---|---|---|---|
| £10 | £0.15 | £0.23 | WoCo |
| £15 | £0.225 | £0.23 | level |
| £25 | £0.375 | £0.23 | TT |
| £60 | £0.90 | £0.23 | TT |
| £100 | £1.50 | £0.23 | TT (6×) |

**Decision: keep the percentage, add a per-ticket cap.** `1.5%, never more than £1.00 per ticket`. Costs nothing on the £10–£30 gig ticket that is the bulk of the market, keeps WoCo cheapest against TT pay-as-you-sell at *every* price point, and stops high-value events (festivals, dinners, conferences) being structurally lost to TT. Also a clean marketing line.

Percentage remains right as the headline because the market is anchored on Skiddle's 10%. And the reason TT has not taken the market despite being cheap is instructive: **prepaid credits are a cashflow ask and a commitment**, and TT brings no audience. Skiddle and Fatsoma win on *discovery*, not price. WoCo's fight is audience + organiser-owned website + owned contact list — not being 0.1% cheaper.

## 7. Pricing — proposed

Tier on the things that cost money: **contacts, sending domains, sites**. Do **not** tier on page views — post-edge-caching they are near-free, so it is a lever that costs nothing and penalises success.

| Tier | Price | Sites | Storage | Sending domain | Contacts | Marketing/day |
|---|---|---|---|---|---|---|
| **Launch promo** (few weeks only) | £0 | 1 | 100MB | platform | 500 | 200 |
| **Starter** | £8/mo annual (£96/yr) · £12 monthly | 1 | 1GB | platform | 2,000 | 500 |
| **Venue** | £24/mo annual (£288/yr) · £34 monthly | 3 | 5GB | **own domain, marketing + tickets** | 10,000 | 2,000 |
| **Brand** | £60/mo annual (£720/yr) · £80 monthly | 10 | 25GB | own domain | 50,000 | 10,000 |

Rationale:
- **Contacts are the pricing mechanism** (per the owner's call, and correct): Mailchimp charges $900/yr for 10k contacts; Venue at £288/yr undercuts them ~3× *and* includes the website *and* the ticketing rail. Our cost at 10k contacts ≈ $24/yr on SES.
- Free tier is a **time-boxed launch promo**, not a permanent policy. Organisers actively selling tickets through WoCo may keep hosting free by policy (the 1.5% covers it many times over — £50k of tickets = £750 of platform fee) but that is a retention lever, not a published tier.
- **Annual billing preferred** — saves 11 × 20p of Stripe fixed fee per customer per year.
- **`MARKETING_DAILY_CAP` must become per-tier.** Today it is one env var defaulting to 2,000/day (`lib/marketing/send-cap.ts:27`). A single organiser at that cap sends 730,000 emails/yr = **$256–657/yr on Resend**, underwater against any tier here. On SES it is ~$73/yr. Untiered, the cap is an unpriced liability.

## 8. Plan of action

| # | Item | Blocked on |
|---|---|---|
| 1 | ~~**Close the `lib/email/` seam**~~ ✅ done 2026-07-27 — `lib/email/send.ts`, 5 call sites refactored, dead `poller.ts` send removed (recipient was a wallet address — the call always failed Resend validation). `build:server` clean, server tests 41/41. | — |
| 2 | **`Reply-To` on ticket emails** — `TicketEmailOpts.replyTo` plumbed ✅; still needs a *source*: `SiteContact.email` when `siteId` present → verified sending domain → omit. Wire at the two `sendTicketEmail` callers (`tickets.ts:292`, `stripe.ts:1173`). | nothing |
| 3 | **Ask Resend** whether broadcast volume on the transactional plan is acceptable | nothing |
| 4 | **File SES production-access request** (sandbox is 200/day) | AWS account |
| 5 | **Entitlements store** — `.data/entitlements.json`, per-organiser tier; make `MARKETING_DAILY_CAP`, contacts, storage and site count read from it | tier model signed off (§7) |
| 6 | **Stripe subscription rail** for the tiers (Billing, not Connect — WoCo is merchant here) | §7 |
| 7 | **Per-ticket fee cap** (1.5% capped at £1.00) — `application_fee_amount` in `routes/stripe.ts`, keep in sync with the 150bp escrow contract | §6 decision |
| 8 | **Transactional sending domain** — `resolveTransactionalFrom()`, separate subdomain, Venue tier+ | 5 |
| 9 | **SES provider implementation** behind the §1 seam | 1, 4, and a trigger from §5 |
