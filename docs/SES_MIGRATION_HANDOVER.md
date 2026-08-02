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

0. **Set `SES_MAX_SEND_RATE=8` NOW, before the next deploy.** ✅ done 2026-07-30.
   The limiter shipped in #98 applies to whichever provider is active, and until cutover
   that is **Resend, which caps at 10 req/s per team** — while the code default is 12.
   (This is still an improvement: the old path ran ~25 req/s into that same limit.) Raise
   it to 12 **at** cutover, not before.
1. **Confirm the account is on the AWS *Paid* plan.** A Free-plan account self-closes at
   6 months or when credits run out — a total ticket-delivery outage. See
   `PRICING_AND_EMAIL.md` §6.
   **Seeing the $100 credit does NOT settle this** (checked 2026-07-30): both plan types
   receive up to $200, so the Credits page is consistent with either. Check **Billing and
   Cost Management → Payment preferences** for an attached payment method instead. Strong
   circumstantial evidence we are already on Paid: a direct-debit mandate was set up, and
   AWS granted production SES access at 50k/day, which Free-plan service restrictions
   would not allow.
2. **Check the SES plan** (SES console → **Pricing plan** page — per-region, not the
   Account dashboard). We were defaulted to Essentials; **Cancel plan** returns the
   account to à la carte (verified against the SES dev guide 2026-07-30: for a
   defaulted account the *first* cancellation takes effect immediately, later changes
   at the next billing cycle). ~37% cheaper per §6. Before cancelling, confirm on that
   page that no feature we actually use is plan-gated — we use none of the bundled
   ones today. Never Pro. (Do not confuse the two: "do NOT switch" applies to **Pro**;
   à la carte is available and cheaper.)
3. **Create an IAM user** with *only* `ses:SendEmail`, and put the key in
   `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. Do not reuse an admin key. The
   `Resource` list MUST name **both** the identity ARN and the configuration-set ARN
   (`identity/woco-net.com` + `configuration-set/woco-events`): SESv2 authorises
   `SendEmail` against the configuration set too once `ConfigurationSetName` is set —
   which we stamp on every send — and an identity-only policy is denied at that point
   (verified 2026-07-31: the AccessDenied names the configuration-set resource).
4. **Create a configuration set** named to match `SES_CONFIGURATION_SET` (e.g.
   `woco-events`). **Without it no bounce or complaint events are emitted at all**, so
   nothing feeds suppression — this is the step that is easy to skip and expensive to miss.
5. **Add an SNS event destination** on that configuration set for `Bounce` and `Complaint`
   (add `Reject`, `DeliveryDelay` if useful — the route ignores them safely). Create the SNS
   topic (**Standard** — SES does not support FIFO), then **edit the topic's access policy
   to allow SES to publish — the console does NOT add this automatically** (SES dev guide,
   "Set up an Amazon SNS event destination", verified 2026-07-31): a statement with
   `Principal: {Service: ses.amazonaws.com}`, `Action: sns:Publish`, `Resource: <topic ARN>`,
   `Condition: StringEquals {AWS:SourceAccount: <account id>, AWS:SourceArn:
   arn:aws:ses:eu-west-2:<account id>:configuration-set/woco-events}`. Skipping this is the
   second silent killer: the event destination exists, SNS denies every publish, no events
   arrive, and nothing on our side errors. Then subscribe
   `https://events-api.woco-net.com/api/ses/webhook` as an **HTTPS** endpoint. Put the topic ARN in `SES_SNS_TOPIC_ARN` **and restart the server before
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

**Conclusion: `EMAIL_FALLBACK_PROVIDER` was deleted with #100**, as this section
said it should be. The drain worker is live: an abandoned transient send is
queued in memory and retried at 1m/5m/15m/30m/60m, updating the existing ledger
entry rather than writing a new one per attempt, and resolving it on success. A
restart loses the pending retries and leaves the entry unresolved for
`/api/ops/email-failures` — worse than an automatic retry, far better than the
`console.error` all of this replaced.

Resend remains ONLY as the `EMAIL_PROVIDER=resend` rollback lever. The
`SendDeps.secondary` seam stays under test so the failover *rules* (transactional
only, never on a permanent error) survive if a second funded provider is ever
added — but production passes null.

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

## 4a. Review findings — status board

Fable reviewed the branch on 2026-07-30 and found four defects. This table is the
record; do not close a row without a commit reference.

| # | Finding | Status |
|---|---|---|
| **1** | **ASYNC BOUNCES NEVER REACH THE LEDGER** — see below | 🔴 **OPEN — #99, blocks LAUNCH (not cutover)** |
| 2 | `QueueOverflowError` bypassed the ledger: `acquire()` sat outside the `try`, so a full queue threw past `recordFailure` into the Stripe webhook's `console.error` — the original bug, re-created | ✅ `757d57e` |
| 3 | A marketing flood evicted unresolved transactional evidence *and* cleared the health alarm: `prune()` sliced newest-1000 regardless of kind | ✅ `757d57e` |
| 4 | `eraseSubject` did not cover `email-failures.json` — Art. 17 gap on the only plaintext store | ✅ `757d57e` |
| 5 | `DATA_INVENTORY.md` §3.1/§3.2 asserted no plaintext email store — false on merge | ✅ `757d57e` |
| 6 | SNS canonical string ambiguity | ✅ Settled: trailing newline. `757d57e` |
| 7 | `SEND_CHUNK = 5` meant the limiter only bound under 417ms latency, so `maxInlineRecipients()` oversized broadcasts | ✅ `757d57e` (→ 10, threshold 833ms) |
| 8 | Empty header value / trailing-backslash display name / `.env.example` selecting SES with empty creds | ✅ `757d57e` |
| 9 | Ledger records only `msg.to[0]`; a future multi-recipient transactional send would lose recipients 2..n | ✅ `fa6a0b2` — `recipients: [{hash, address?}]`, legacy shape migrated on read |
| 10 | `attempts` in the ledger is approximate (`retryable ? maxAttempts : 1`), ignores failover attempts | ✅ `fa6a0b2` — real provider-call count, 0 on a queue overflow |
| 11 | No ops surface: `listFailures`/`resolveFailure` have no route, so remediation means editing `.data/` over SSH | ✅ `5b9f5b0`+`04a097e` — `/api/ops/email-failures`, `OPS_TOKEN`, list always redacted |
| 12 | Forged-message fetch amplification: any POST with a novel valid-host `SigningCertURL` triggers an outbound fetch from an unauthenticated endpoint | 🟡 Open — pin path to `/SimpleNotificationService-*.pem` and/or rate-limit |
| 13 | Webhook consumes the `MessageId` **before** processing, so a crash between the two loses the bounce permanently | ✅ `fa6a0b2` — commented. The ordering is what #99 needs once the handler also ledgers |
| 14 | **#100's record sweep evicted a died-unresumed job** — the per-org 20-record cap ranked purely by recency, so 20 later terminal records (or expired drafts, which nothing rate-limits) deleted the death record: `/api/health` went green with the broadcast half-sent, and the resume 404'd because its `sentHashes` went too. Row 3's lesson (unresolved evidence is exempt from size caps), not carried into the new store. Retention was also keyed on `createdAt`, so a boot after a week-long outage would delete the record it had just written 60s later | ✅ fix/broadcast-died-record-eviction — died-unresumed records exempt from the cap, retention keyed on `finishedAt`; confirmed by repro before the fix |
| 15 | `POST /api/broadcasts/jobs` is not rate-limited — the hourly window burns at `start` only, so an organiser (or their retrying client) can mint unbounded drafts, each holding an encrypted chunk file for up to 15 min and a dedupe Set in memory. Gated to verified organisers / event owners, and the TTL bounds each draft, so resource growth is slow — but it is unbounded in job count | 🟡 Open — low; consider a per-org draft ceiling |

**Re-verified 2026-07-30** (`760a015..HEAD`): all seven actioned items confirmed fixed, no new
problems introduced, and nothing in them obstructs finding 1. Two residuals from that pass were
closed in the same sweep — the Art. 15 report and the operator script did not surface the ledger
at all (so an access report omitted the one store holding the subject's plaintext address), and
the `DATA_INVENTORY` cap wording predated the eviction exemption.

Tracked on GitHub: **#99** (finding 1, cutover blocker) · **#100** (queue + drain worker — SHIPPED,
and rows 9, 10, 11, 13 closed with it) · **#101** (list cap). Rows 9–13 stayed **here**, not on GitHub — they are a comment, an assertion and a cosmetic field, and six issues for that is noise while one bucket issue is unclosable. Rows 11 and the batched-persist note are natural pickups for #100's drain worker. The one exception is the SNS cert-fetch hardening, which is standalone security work: **#104**. Phase 2 sending domains: **#103**.

### Finding 1 — the half of the bug that is still open

**Blocks LAUNCH, not the cutover — corrected 2026-07-30.** `routes/resend-webhook.ts` has the
identical gap: it suppresses the hash and never ledgers. So this is **pre-existing on both
providers**, not introduced by the migration, and cutting over to SES is neutral with respect to
it. Holding the cutover would burn the low-volume warm-up window that was the whole reason for
migrating early. Ship the cutover; land this before real buyers are paying.

The scenario the whole branch exists
to fix — buyer paid, turned away at the door — most often starts with a **typo'd email
at checkout**. SES *accepts* that send: `sesProvider.send()` resolves, no retry, no
failover, **no ledger entry**. It hard-bounces minutes later, `ses-webhook.ts` suppresses
the hash and logs a count, and nothing records that a *paid ticket* went undelivered.
`failureHealth()` stays green. Same for an address already on the SES account-level
suppression list: accepted, silently dropped by AWS, surfaced only as
`Permanent/OnAccountSuppressionList`.

So the silent-failure fix currently covers **synchronous API failures only — roughly half
the failure surface.**

Fix shape: tag transactional sends with configuration-set message tags (or match the
bounced hash against recently-sent transactional messages), then write a ledger entry
from the bounce handler carrying the Stripe/event context. Pairs naturally with the
queue work, since both need per-message identity.

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

Interim guard: `maxInlineRecipients()` = `90s × effective rate` rejects an oversized
broadcast up front with a clear message, instead of letting the organiser hit a generic 524
with no idea how many people were mailed. Delete it with the inline path.

| `SES_MAX_SEND_RATE` | Guard allows | vs `MAX_BROADCAST_RECIPIENTS` (1,000) |
|---|---|---|
| 5/s (cautious warm-up) | **450** | binds — this is the case the guard exists for |
| **12/s (default)** | **1,080** | **no effect: the full 1,000 cap stays usable** |
| 14/s (full grant) | 1,260 | no effect |

At the default rate the guard changes nothing an organiser can do today — a 1,000-contact
list still sends in one go, in ~83s. It is derived from the rate rather than hardcoded
because the dangerous case is not someone raising the recipient cap, it is someone
**lowering** the send rate for warm-up, which §2 step 9 explicitly recommends. At 5/s a
1,000-recipient broadcast takes 200s and would 524.

*(The commit message for `14f181a` says "900 today" — that was arithmetic done in prose
rather than in code. The value is 1,080; `email-delivery-guarantees.test.ts` asserts it.)*

- ~~**No background job queue for broadcasts.**~~ **CLOSED — #100, 2026-08-02.** Both
  broadcast paths now go through `/api/broadcasts/jobs` and drain on a background worker;
  the inline endpoints return 410 and `maxInlineRecipients()` is deleted. §7 below records
  what was settled.
- **No batch API use — re-checked 2026-08-02, and the earlier reason was wrong.**
  `SendBulkEmail` does require a template, but an INLINE template needs no stored resource,
  and `BulkEmailEntry.ReplacementHeaders` (max 15) carries a per-destination
  `List-Unsubscribe`, which is not on SES's disallowed-custom-header list. So our
  per-recipient unsubscribe footer is *not* the blocker it was recorded as.
  **It is still not worth doing**, for a better reason: SES quotas are counted in
  RECIPIENTS, not calls — "an email that has 10 recipients counts as 10 against your quota"
  — so batching 50 at a time saves round-trips and sockets, not throughput, and our ceiling
  is the account send rate either way. It also turns every send into partial-failure
  bookkeeping (`BulkEmailEntryResults` is per-entry) and makes subscribing to Rendering
  Failure events mandatory. Revisit only if HTTP round-trips ever become the constraint.
  Sources: SESv2 `BulkEmailEntry` / `MessageHeader` API reference, "Managing sending limits",
  "Using templates to send personalized email".

---

## 6. Queue design note — the sealing model, not the send rate, is the constraint

Written down because it was nearly lost as a passing remark, and because the first version
of it was **wrong** in a way worth recording.

**The wrong version.** "With a queue, change the API from a client-supplied recipient array
to *send to list N*, and let the server enumerate." That cannot be built. Contact lists are
ECIES-sealed **client-side** to the organiser's X25519 key
(`packages/shared/src/marketing/types.ts`). The server holds an opaque sealed blob plus a
set of `emailHash`es — it cannot decrypt, so it cannot enumerate. The client posting
plaintext recipients is not an accident of the current design; it is the only party that
*can*.

**What that forces.** A background job has to take the recipients up front from the client
and hold them until it drains. Today those addresses exist server-side only for the life of
one HTTP request — "hashed-and-discarded", the posture `PRICING_AND_EMAIL.md` §2 defends at
length when rejecting Resend Broadcasts for "converting transient exposure into a durable
third-party copy". A job that runs for 28 minutes converts it into a durable **first-party**
copy. That is defensible where the Resend one was not — we are the processor the organiser
already trusts with the list — but it is a real change and it belongs in
`docs/legal/DATA_INVENTORY.md`, decided rather than assumed.

Mitigations to design in, not bolt on: encrypt the job payload at rest with a key held only
in process memory; delete each chunk as it drains rather than on job completion; hard TTL
that destroys the payload whether or not the job finished.

**The 20,000 cap IS arbitrary — corrected.** An earlier draft of this section claimed the
6MB sealed-blob cap binds at 20k. It does not, and
`docs/CONTACT_MANAGEMENT_DESIGN.md` already said so in an open question nobody closed:

> "Does raising `MARKETING_MAX_LIST_EMAILS` above 20k make sense now that gzip put the
> storage ceiling near **175k**? Browser memory, not storage, is the new limit."

`MARKETING_MAX_LIST_EMAILS = 20_000` was set **before** payload compression existed
(`types.ts` still explains that uncompressed, a 20k list overflowed the blob cap). Gzip moved
the real ceiling by roughly 9×; the constant was never revisited. So:

| Ceiling | Value | Status |
|---|---|---|
| `MARKETING_MAX_LIST_EMAILS` | 20,000 | **Stale conservatism.** No technical basis at this level |
| `MAX_SEALED_JSON = 6_000_000` | ~175,000 contacts gzipped | The real storage ceiling |
| Whole-blob rewrite per edit | O(n) | Real, but an *editing* cost, not a sending one |
| Browser memory on unseal | unquantified | The genuine unknown — **measure before raising** |
| Broadcast upload size | 1,000/request today | **What actually blocks big organisers**, and what the queue fixes |

**So the honest sequencing is better than "build paging for the future":**

1. **Queue with a chunked job API** — removes the per-request broadcast ceiling. This is the
   real blocker for a 20k organiser today, and it is the work already planned.
2. **Then raise `MARKETING_MAX_LIST_EMAILS`** — up to ~175k this is close to a constant
   change, gated on measuring client-side unseal memory on a mid-range phone, not on new
   architecture.
3. **Paged sealed blobs** — only needed above ~175k, and only worth building when a real
   organiser is near it.

Do not build step 3 now. Do build step 1 so it does not foreclose steps 2 and 3 — which is
exactly what the chunked job API buys.

**Recommended split.** Do not build paging now; do not let the queue foreclose it. Concretely:
the job API should accept recipients in **chunks against a job id** (`POST /jobs` →
`POST /jobs/:id/chunk` → `POST /jobs/:id/start`) rather than one array in one request. That
shape works unchanged when a sealed list later arrives in pages, and it removes the
per-request cap without anyone having to decide the list ceiling first. The
plaintext-at-rest question, by contrast, **must** be settled before the job store is
written, because it determines what that store holds.

---

## 7. What #100 settled — the queue as built (2026-08-02)

§6 argued for the shape. This is what the shape became, and the decisions inside
it that are not obvious from the code.

**API.** `POST /api/broadcasts/jobs` → `.../chunk` → `.../start`, one surface for
both `kind: "marketing"` and `kind: "event"`. `start` carries `chunkCount` and
`totalRecipients` and **refuses on mismatch** — a lost chunk POST would otherwise
produce a job that drains, completes and reports success while a chunk of people
were never mailed, which is the failure class this whole branch exists to end.
The two inline endpoints return **410**, not 404: Hono's default 404 is plain
text and the frontend would surface it as a JSON parse error.

**Ceilings — there is exactly one, and it is not the queue's.**
`MAX_JOB_RECIPIENTS` derives from `MARKETING_MAX_LIST_EMAILS`, and the chunk
bound derives from that with 4× headroom. A fixed chunk cap (the first draft had
200 × 500 = 100,000) would have sat *below* the ~175k the sealed blob can
actually take, leaving #101 a hidden lower ceiling to rediscover.

**Restart semantics, stated plainly.** The payload key is generated per process
and never written down, so a restart makes every chunk permanently unreadable and
kills in-flight jobs. That is the cost of the property, and the property is worth
it for BACKUPS rather than for the running VM — anyone who can read `.data/` can
also read `server.env`, but a snapshot that catches a chunk catches ciphertext
nobody holds a key for. The cost is paid down by making death loud: boot marks
jobs `died` with an unsent count, `/api/health` reports `broadcasts.ok: false`
while one is unresumed, and `resumeOf` re-uploads the same list and skips
everyone already delivered to. **Check for running jobs before a deploy.**

**Ordering that is load-bearing.** `sentHashes` is fsynced BEFORE the chunk is
unlinked. The other order loses the record of who was mailed while the chunk is
already gone, and a resume — which skips on `sentHashes` — would re-deliver up to
a full chunk. The reverse crash window leaves an orphan ciphertext file that boot
wipes, and costs nothing.

**Scheduling** rotates at CHUNK granularity, event-kind first. Strict FIFO would
park a 200-attendee "the doors have moved" behind a stranger's 20,000-contact
blast for half an hour. The drain **never** takes `withOrgLock` — that is a
promise chain, and holding it across a 28-minute send would hang the organiser's
own list, check and suppress calls until Cloudflare killed them. The lock covers
gate-check, cap reservation and the state flip only.

**The daily cap is reserved at start and reconciled at the end**, rewriting the
same log entry rather than appending a negative one (a refund written an hour
later would also age out an hour later, briefly granting phantom allowance).
Without the reconcile, a job killed at 5% leaves the full reservation standing,
`capRemaining` reads 0, and the organiser cannot resume for 24 hours — the
accounting for a failure blocking its own remedy.

**Event membership is snapshotted ONCE** at job creation, and job creation
**503s** if any claimers feed was unreadable. Re-deriving per chunk would be a
Swarm read per series per chunk, and a blip midway would make real attendees look
like strangers — `getAttendeeEmailHashes` now distinguishes `unreadableSeries`
from `unverifiableSeries` so that is expressible at all. "An unreadable page is
not an empty page" (`4fedca9`), applied to membership.

**Cancellation stops what has not been sent and says so.** Every ESP that
publishes its semantics says the same thing — Resend: "Canceling a broadcast only
stops emails that haven't been sent yet." The UI never implies recall.

**A separate defect fixed on the way** (`ce1da11`): the SESv2 client was on
`retryMode: "adaptive"`, whose rate limiter is per-CLIENT and can delay the
INITIAL request. One client serves ticket email and broadcasts, so a
broadcast-induced throttle was stalling transactional mail *underneath* the
priority queue. AWS: "Adaptive mode is not recommended as a general default." The
SDK's own `maxAttempts` also composed with our retry loop — up to 9 provider
calls recorded as 3, and a token bucket that could not see the calls the SDK
absorbed. Retrying now happens in exactly one place.

**Legal.** `docs/legal/DATA_INVENTORY.md` §3.1 gained rows for
`broadcast-jobs/*.json` (hash-only, 7-day retention, Art. 15 reachable via
`broadcastsContaining`, deliberately NOT Art. 17 erasable — removing a hash would
make a resumed job mail the person who asked to be forgotten; suppression is the
mechanism instead) and `broadcast-chunks/*.bin`. §3.2's "hashed-and-discarded"
claim was amended: broadcast recipients are no longer transient, and saying so is
not optional.

**Still open:** #99 (async bounces → ledger) and #101 (the list cap). Board row
12 (SNS cert-fetch hardening) is #104.
