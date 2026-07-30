# SES migration — handover

Built 2026-07-30. Cost/pricing authority stays in `PRICING_AND_EMAIL.md` §6 — do not
restate rates here. Production-access case record: `SES_PRODUCTION_ACCESS.md`.

**Status: code complete and tested, NOT yet cut over.** The switch is `EMAIL_PROVIDER=ses`
in `apps/server/.env`, and it must not be flipped until §2 is done.

---

## 1. What shipped

| File | Job |
|---|---|
| `lib/email/types.ts` | `OutboundEmail`, `EmailProvider`, `EmailSendError`. Split out to break a `send.ts` ⇄ provider import cycle — under ESM that cycle resolves `EmailSendError` as `undefined` and every `instanceof` in the retry path fails open |
| `lib/email/ses-provider.ts` | SESv2 `SendEmailCommand` with **`Content.Simple`**, not `Raw` |
| `lib/email/rate-limiter.ts` | Account-wide token bucket, transactional prioritised over marketing |
| `lib/email/failure-ledger.ts` | `.data/email-failures.json` — durable record of abandoned sends |
| `lib/email/sns-verify.ts` | SNS signature verification, `node:crypto`, no dependency |
| `lib/email/consumed-sns-events.ts` | Bounded exactly-once registry |
| `routes/ses-webhook.ts` | `POST /api/ses/webhook` — bounces/complaints → global suppression |
| `send.ts` | Provider selection, retry, failover, ledger. `sendVia()` is the injectable seam |
| `maxInlineRecipients()` | **Temporary** broadcast-size guard, deleted with the inline send path |

New dependency: `@aws-sdk/client-sesv2` only. Tests: 89 added, 277/277 green.

### Three decisions worth knowing

**Simple content, not Raw MIME.** SESv2's `Simple` content now carries an `Attachments`
list with `ContentId` and `ContentDisposition: INLINE`, which is exactly what
`cid:woco-card-0` in the ticket email needs. Hand-rolling multipart/related to use `Raw`
would have been a correctness liability whose failure mode is "renders in Gmail, not
Outlook". No `nodemailer`, no MIME builder.

**Resend is kept, deliberately scoped, and the failover ships OFF.** It is the operator
rollback lever (`EMAIL_PROVIDER=resend`) and, opt-in only, a failover for **transactional
mail only** (`EMAIL_FALLBACK_PROVIDER=resend`, commented out in `.env.example`). Marketing
never fails over. Read **§3a** before enabling it — the reasoning changed once the DNS was
actually checked. It stays on the **free** tier; we do not pay for two ESPs.

**The failure ledger keeps plaintext for transactional only.** Remediating a failed *ticket*
means contacting the buyer, and nothing else on disk can recover their address (the claimers
feed stores `emailHash` too) — Art. 6(1)(b), performance of the contract they just entered.
Marketing failures store the hash only, because the organiser still holds the list. File is
chmod 0600 on every write, 90-day retention, 1,000-entry cap.

### The silent-failure fix

`stripe.ts:1461` caught a failed **paid** ticket email with `console.error` and moved on.
Now: retries with jittered backoff → transactional failover → durable ledger →
`/api/health` reports `email.undelivered.ok: false` on any unresolved transactional
failure. The webhook still returns 2xx to Stripe (a non-2xx would redeliver and re-run the
whole claim path over an email problem), but the loss is no longer invisible.

---

## 2. What the user must do in AWS — BEFORE flipping the flag

Nothing here is optional. Steps 3–5 are what AWS required when it granted production access.

1. **Confirm the account is on the AWS *Paid* plan** (Billing → Free Tier). A Free-plan
   account self-closes at 6 months or when credits run out — that is a total ticket-delivery
   outage. See `PRICING_AND_EMAIL.md` §6.
2. **Check the SES plan** (SES console → Account dashboard). New accounts default to
   Essentials; switching to à la carte is free and ~37% cheaper.
3. **Create an IAM user** with *only* `ses:SendEmail` on the identity, and put the key in
   `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. Do not reuse an admin key.
4. **Create a configuration set** named to match `SES_CONFIGURATION_SET` (e.g.
   `woco-events`). **Without it no bounce or complaint events are emitted at all**, so
   nothing feeds suppression — this is the step that is easy to skip and expensive to miss.
5. **Add an SNS event destination** on that configuration set for `Bounce` and `Complaint`
   (add `Reject`, `DeliveryDelay` if useful — the route ignores them safely). Create the SNS
   topic, then subscribe `https://events-api.woco-net.com/api/ses/webhook` as an **HTTPS**
   endpoint. Put the topic ARN in `SES_SNS_TOPIC_ARN` **and restart the server before
   subscribing** — the webhook fails closed without it, so the confirmation would be
   rejected. The route auto-confirms the subscription once the ARN is set.
6. **Enable SignatureVersion 2** on the topic, then set `SNS_REQUIRE_SIGNATURE_V2=true`.
7. **MAIL FROM domain** — `bounce.woco-net.com` is already configured per
   `SES_PRODUCTION_ACCESS.md`; confirm it still shows *Verified* in the SES console.
8. Deploy (CLAUDE.local.md STEP 1 + STEP 2), then verify:
   `curl https://events-api.woco-net.com/api/health | jq .email` → `provider: "ses"`.
9. **Warm up.** Do not send a broadcast on day one. Ticket email only for the first couple
   of weeks; the domain reputation is cold.

**Rollback:** set `EMAIL_PROVIDER=resend`, redeploy env. No data migration either way —
suppression, consent and contact blobs are all ours.

---

## 3a. The failover is a launch-window crutch, not an availability strategy

Added after challenge, and after checking the DNS. Two findings change how much
weight it can carry.

**Authentication is fine.** Both providers can send as `woco-net.com` simultaneously
today — verified 2026-07-30:

| Record | Value | Effect |
|---|---|---|
| `bounce.woco-net.com` TXT | `v=spf1 include:amazonses.com ~all` | SES SPF passes, aligned |
| `bounce.woco-net.com` MX | `feedback-smtp.eu-west-2.amazonses.com` | SES bounces route |
| `send.woco-net.com` TXT | `v=spf1 include:amazonses.com ~all` | Resend SPF passes, aligned |
| `resend._domainkey` TXT | 1024-bit public key, published | Resend DKIM passes |
| `_dmarc` TXT | `p=none; rua=…` | Monitoring only |

So failover mail authenticates. No DNS work is needed to enable it — which is what
made it look cheaper than it is.

**But Resend runs on Amazon SES.** `send.woco-net.com` MX points at
`feedback-smtp.eu-west-1.amazonses.com`. Resend is a different SES *account* in a
different *region*, not an independent provider. It therefore protects against:
our account being paused or throttled, our own misconfiguration, an eu-west-2
regional fault. It does **not** protect against a broad SES outage — in that
scenario both legs fail and everything lands in the ledger anyway.

**And it does not scale.** Free tier is 100/day. At real volume the failover
delivers the first 100 and ledgers the remainder, which is worse than a clean
failure because it is harder to reason about.

**Conclusion: `EMAIL_FALLBACK_PROVIDER` ships OFF.** Turn it on for the cutover
window if wanted — the period when SES is new to us and our own config is the
least-trusted component is exactly when it earns its keep, and also when volume is
lowest. Turn it off before real volume.

**The durable answer is a drain worker, not a second ESP.** SES outages are
minutes to hours. A ticket that arrives 20 minutes late is acceptable; a ticket
sent from a thin-reputation second provider risks the spam folder, which is worse
than late. A worker that retries unresolved `email-failures.json` entries with
backoff keeps all reputation on one domain, needs no second provider, and is the
same machinery §5's background broadcast queue needs. **Build that; then delete
the failover.**

---

## 3. For Fable — review points

Ranked by how much a wrong answer costs.

1. **SNS canonical string, `sns-verify.ts:~95`.** The AWS reference contradicts itself on
   the trailing newline: the prose says "Do not add a newline character at the end", its own
   shell example pipes through `echo -e` (which appends one), and every long-standing AWS SDK
   validator signs the trailing-newline form. I verify against **both** exact encodings.
   I believe this is safe — forging either still needs Amazon's private key — but it is the
   one place I resolved an ambiguity by widening rather than by knowing. **Please confirm
   against a real SNS message once the topic is live**, and if the answer is definite, drop
   the other branch.
2. **Certificate chain of trust.** I validate the `SigningCertURL` host against
   `^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$`, require HTTPS, and check the cert's validity
   dates — but I rely on **TLS** to prove the chain, rather than validating it against a CA
   bundle in-process. That is what mainstream validators do. Is it enough here?
3. **`Permanent` vs `Transient` suppression policy** (`ses-webhook.ts`). I suppress every
   `Permanent` subtype and every complaint; I do not suppress `Transient` or `Undetermined`.
   `Permanent/OnAccountSuppressionList` is the debatable one — AWS says it does not count
   toward the bounce rate, and suppressing on it makes SES's list and ours agree. I think
   that is right; worth a second opinion.
4. **Rate limiter priority starvation.** Transactional always drains before marketing. A
   sustained transactional load above `SES_MAX_SEND_RATE` would starve a broadcast
   indefinitely. At our volumes that cannot happen, and the queue is bounded so it fails
   loudly rather than hanging — but it is an unbounded-priority design and I want it named.
5. **Plaintext in the failure ledger.** Reasoning in §1. This is a `docs/legal/DATA_INVENTORY.md`
   change I have **not** made — it needs a decision, not my assumption.

---

## 4. Phase 2 — per-organiser sending domains

Not started. Gated on the paid tier (`PRICING_AND_EMAIL.md` §7), and this is the work that
lets the Resend adapter be deleted.

Replaces Resend's Domains API (`lib/marketing/sending-domain-store.ts`, `routes/marketing.ts`):

| Resend today | SES equivalent |
|---|---|
| `POST /domains` | `CreateEmailIdentity` with `DkimSigningAttributes` (Easy DKIM) |
| returned DNS records | `DkimAttributes.Tokens` → three `<token>._domainkey.<domain>` CNAMEs |
| `GET /domains/:id` poll | `GetEmailIdentity` → `DkimAttributes.Status` |
| — | `PutEmailIdentityMailFromAttributes` for a custom MAIL FROM per organiser |

Three things that will bite:

- **Non-send SES API actions are throttled at 1 request/second** (service quotas). The
  verification poller must be serialised with backoff, not a `Promise.all` over organisers.
- **10,000 verified identities per region.** Fine, but it is a real ceiling — do not design
  as if it were unlimited.
- **Reputation split still applies.** Two subdomains per organiser
  (`tickets.venue.com` transactional / `mail.venue.com` marketing) so a bad campaign cannot
  stop ticket delivery — the constraint that forced SES in the first place
  (`PRICING_AND_EMAIL.md` §5).

**Delete Resend when phase 2 ships**, or by **2026-10-01** if phase 2 slips and SES has run
clean — whichever is first. That removes: `resendProvider` in `send.ts`, `client.ts`'s
`getResend`, `routes/resend-webhook.ts`, `lib/marketing/consumed-webhook-events.ts` (which
is unbounded and grows forever — the SNS one is capped), the `resend` dependency, and the
`RESEND_*` env fallbacks in `client.ts`.

---

## 5. Known gaps — unchanged by this work

Still open from `SES_PRODUCTION_ACCESS.md`, and not addressed here:

**Raising limits does not fix this — checked, not assumed.** Cloudflare's 524 timeout can
only be raised on **Enterprise** (up to 6,000s), and Cloudflare's own advice is to move
long-running work off the request instead. Nor does a bigger SES quota help: our own
`MARKETING_MAX_LIST_EMAILS = 20_000` means that even at **100/s — 7× the current grant —**
a full-list send takes 200s and still dies. There is no rate at which a bulk send fits
inside an HTTP request. The queue is the only shape that works.

| Rate | 1,000 recipients | 20,000 (list cap) |
|---|---|---|
| 12/s (today) | 83s ✓ | 1,667s ✗ |
| 14/s (full grant) | 71s ✓ | 1,429s ✗ |
| 100/s (hypothetical) | 10s ✓ | 200s ✗ |

Interim guard: `maxInlineRecipients()` = `90s × effective rate` (900 today) rejects an
oversized broadcast up front with a clear message, instead of letting the organiser hit a
generic 524 with no idea how many people were mailed. It is derived from the rate rather
than hardcoded because the dangerous case is **lowering** `SES_MAX_SEND_RATE` for warm-up:
at 5/s a 1,000-recipient send takes 200s. Delete the guard with the inline path.

- **No background job queue for broadcasts.** Sends still run inline in the HTTP request.
  The rate limiter makes a large broadcast *slower*, not faster — 1,000 recipients at 12/s
  is ~83s against Cloudflare's 125s origin timeout — ~34% headroom before rendering,
  suppression checks and latency variance. Survivable, not comfortable. **This is
  the next thing to fix**, and it is more urgent than it was before this change.
- **No batch API use.** `SendEmail` is one message per call. SESv2 has `SendBulkEmail`, but
  it requires templates, which our per-recipient unsubscribe footer does not fit without
  restructuring.
