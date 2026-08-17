# Email work — where it stands and what is next

Written 2026-08-02, at the end of #100. Companion to `SES_MIGRATION_HANDOVER.md`
(which holds the SES design record and the §4a review board) and
`PRICING_AND_EMAIL.md` (rates — never restate them elsewhere).

---

## Where the email subsystem is now

SES has been the live provider since 2026-07-31. The bounce/complaint pipeline
is verified in production. As of #100 the whole outbound path looks like this:

```
                       ┌─ transactional (tickets, receipts, nudges)
sendEmail ─ sendVia ───┤     retry ×3 → ledger → in-memory retry queue (1m…60m)
   │                   └─ marketing  → sendMarketingBatch ONLY
   │                          (suppression · RFC 8058 · footer · postal address)
   │
   └─ rate limiter: one account-wide token bucket, transactional overtakes marketing

broadcasts ─ POST /api/broadcasts/jobs → /chunk → /start
   └─ drain worker: one chunk at a time, round-robin, event-kind first
        │    chunks AES-256-GCM under a process-memory key, deleted as they drain
        └─ also drains the failure ledger's retry queue between chunks
```

Health lives at `/api/health` → `.email`: `provider`, `undelivered` (an
unresolved transactional failure means somebody paid and has no ticket),
`broadcasts` (a `died` job nobody resumed), and `bounceLedger` (whether bounces
arriving AFTER the provider accepted the message can still be tied back to the
order — `untagged > 0` means the SES configuration-set wiring is not publishing
message tags).

---

## Next, in order

### 1. #99 — async bounces reach the failure ledger — **DONE**

Shipped on `fix/async-bounce-ledger`. `sendVia` stamps configuration-set message
tags on every send (`lib/email/message-tags.ts`); `ses-webhook.ts` decodes them
on a `Permanent` bounce or a `Reject` and writes a ledger entry carrying the
`stripeSessionId` and `eventId`, so a paid ticket that never arrived is red on
`/api/health` and actionable at `/api/ops/email-failures`.

**Decisions worth not relitigating:**

- **Ledger before suppress.** Consume-before-process means a throw after the
  consume loses the event permanently, and a lost suppression self-heals (the
  address bounces again) while a lost ledger entry does not.
- **Complaints suppress but do not ledger.** The message was delivered. It costs
  the person no future ticket either — the suppression list is consumed only by
  `marketing-send.ts`. Real loss returns later as
  `Permanent/OnAccountSuppressionList`, which IS ledgered.
- **Untagged bounces are recorded hash-only**, never guessed into
  `transactional`. The alarm for that case is `email.bounceLedger.untagged` on
  `/api/health`, not a per-message health flip. It counts UNRESOLVED entries, so
  resolving them is how it is cleared — expect a benign burst on the first
  deploy, because every message in flight at that moment was sent untagged.
- **`woco_ctx_` is a separate namespace from `woco_kind`** because a context key
  called `kind` already exists (`requirement-nudge.ts`).

**Still open, deliberately:**

- **`routes/resend-webhook.ts` is NOT covered.** Resend is the rollback lever and
  is scheduled for deletion; pulling it reopens the async hole, which
  `/api/health` reports as `email.bounceLedger.unsupported` rather than leaving
  it to be discovered.
- **AWS-side wiring is unverifiable from code.** Tags are published only through
  a **configuration-set event destination** — identity-level feedback
  notifications carry none — and `Reject` must be enabled on that destination to
  be delivered at all. If `email.bounceLedger.untagged` keeps climbing after the
  in-flight burst has been resolved, that is the wiring, not the code.
- **Do NOT point identity-level notifications at this endpoint alongside the
  config set.** Both copies carry the same `mail.messageId`; the code keys them
  apart so the tagged one is never lost, but the cost is a duplicate ledger row
  per bounce.
- **AWS documents the `mail.tags` block on Bounce and Complaint records but the
  worked examples for those two show only `ses:*` entries** — the Delivery, Send,
  Reject and Subscription examples show custom tags. The page's prose says a
  config set publishes tags for all event types, so this should be a gap in the
  examples rather than in the behaviour. One send to
  `bounce@simulator.amazonses.com` after deploy settles it; the untagged counter
  is the detector either way.

**Research kept — do not re-derive:**

- `mail.tags` is a map of string → **array** of strings, alongside auto-populated
  `ses:configuration-set`, `ses:source-ip`, `ses:from-domain`,
  `ses:caller-identity`, `ses:operation`.
  ([Event data examples](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-examples.html))
- `EmailTags` on `SendEmail`; names and values allow **only** `[A-Za-z0-9_-]`,
  ≤256 chars, both required — no `:`, no `.`, no base64 padding.
  ([MessageTag](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_MessageTag.html))
- `MessageId` is **not** a safe key: it is assigned at *acceptance*, and AWS
  documents that "on rare occasions, SES may accept an email for delivery even
  though the send request returns an error to the caller… use message tags
  rather than relying solely on the message ID."
  ([How email sending works](https://docs.aws.amazon.com/ses/latest/dg/send-email-concepts-process.html))
- `Permanent/OnAccountSuppressionList` and `OnTenantSuppressionList` do **not**
  count toward the bounce rate; plain `Permanent/Suppressed` does.
- **Gmail complaints never reach SES at all** — Google Postmaster Tools is the
  only visibility. Do not present complaint rate as complete.

### 2. #96 — marketing must fail closed when the marketing from-address is unset — **DONE**

Shipped on `fix/marketing-from-fail-closed`. `getMarketingFromAddress()` and
`resolveMarketingFrom()` answer `string | null` and never degrade to the
transactional address; the marketing lane refuses with 503 before `createJob`,
and the test send refuses with it.

Env name settled: `EMAIL_FROM_MARKETING` is the provider-neutral name and
already existed, so no SES-side equivalent was needed. The check trims because
`KEY=` and `KEY="  "` both mean "not configured" and an env file expresses
either by accident.

**Deployed 2026-08-03. No outage — the var was already set.** An earlier draft
of this section warned that merging would 503 every marketing send until
`EMAIL_FROM_MARKETING` was configured. That was wrong: it is set on both the
laptop master and the VM to `news@mail.woco-net.com`, a subdomain distinct from
the transactional `woco-net.com`, which is exactly the lane split this issue
asks for. `/api/health` → `email.marketingSender.ok` is `true` in production.
The claim came from misreading a `grep -o` that truncated at the `=`; check a
value's LENGTH, never a pattern that stops before it.

**Still worth confirming in the SES console** (not checkable from the repo, and
`marketingSender.ok` only proves the string is non-empty): that
`mail.woco-net.com` is a DKIM-verified identity. Public DNS shows no SPF or
custom MAIL FROM record on that subdomain — with SES's default MAIL FROM,
SPF passes via `amazonses.com` but is not aligned to `woco-net.com`, so DMARC
rests on DKIM alone. If the identity is NOT verified, the drain worker now says
so loudly on the first chunk instead of grinding through the whole list.

**Decisions worth not relitigating:**

- **The event lane keeps the fallback**, now explicit at the call site rather
  than hidden in the resolver. Those recipients consented by buying a ticket and
  the message is "the event is cancelled" — refusing there would turn a platform
  config gap into attendee harm.
- **Consequence of setting the var**, worth expecting: attendee mail moves off
  the ticket domain onto the marketing subdomain the same day, so the
  least-warmed identity starts carrying the mail that most needs to land. Warm
  the subdomain on event broadcasts deliberately before any imported list
  touches it.
- **The test send fails closed too.** It is a rehearsal; one that goes out from
  a sender the real broadcast would be refused from misrepresents what it is
  previewing.
- **No second assert at `/jobs/:id/start` or in the drain worker.** A job created
  under old code cannot drain under new code — chunks are ciphertext under a
  process-lifetime key and `reconcileOnBoot` wipes them — and the check would
  have to be "fromAddress equals the transactional address", which is *correct*
  for the same worker's event jobs. Create is the single policy point.
- **Resume re-resolves the address rather than copying the prior job's.**
  Copying it would resurrect a pre-change record carrying `events@woco-net.com`,
  or a since-unverified domain the provider now rejects. A broadcast split
  across two senders breaks nothing: unsub tokens are minted per recipient
  independent of from, suppression is org-scoped, DKIM alignment is per-message.

**Still open, deliberately:**

- **An unverified from-identity is now an account-level stop** in the drain
  worker, because making the var mandatory made a typo'd or not-yet-verified
  value a fresh way to reject 20,000 messages one at a time. Three alternatives:
  `MailFromDomainNotVerifiedException` (SES's named exception), "Email address
  is not verified" (SES's `MessageRejected` wording for an unverified identity),
  and "domain is not verified" (Resend's wording — the rollback lever, and a
  stop that quietly stops working the moment you pull it is worse than no stop).
  Bare `MessageRejected` is deliberately NOT matched: it also covers genuine
  per-message content rejections. Every alternative contains a space, which is
  what makes them unforgeable — recipient addresses pass `EMAIL_RE` and domains
  `HOSTNAME_RE`, neither of which admits whitespace.
- **Known imprecision:** an SES account back in sandbox emits the identical
  "Email address is not verified" for unverified RECIPIENTS. The stop still
  fires correctly (nothing can send), but the settle message's diagnosis names
  the sending address. Unreachable while the account stays production-enabled.
- **A refusal lasting more than 7 days destroys the resume path.** The
  died-unresumed exemption in `sweep` bypasses the per-org count cap but NOT
  `tooOld` (`RECORD_RETENTION_MS`), so a died job's `sentHashes` skip-list is
  deleted after 7 days and the only remaining remedy re-mails the already-mailed
  half. Pre-existing, but fail-closed adds a way to be pinned there by ops
  alone. The sequencing above makes it unreachable in practice.

### 3. #104 — SNS webhook: pin the signing-cert URL path

Board row 12. Any POST with a novel valid-host `SigningCertURL` triggers an
outbound fetch from an unauthenticated endpoint. Pin the path to
`/SimpleNotificationService-*.pem` and/or rate-limit. Small, standalone.

### 4. #101 — raise `MARKETING_MAX_LIST_EMAILS`

20,000 is stale conservatism: it predates payload compression, and the real
storage ceiling is nearer 175,000 (`SES_MIGRATION_HANDOVER.md` §6). #100 was
built so this is close to a constant change — `MAX_JOB_RECIPIENTS` and the
chunk bound both derive from it, and a test asserts chunk capacity always
exceeds it. **Gated on measuring client-side unseal memory on a mid-range
phone**, which is the genuine unknown, not on architecture.

### 5. #103 — SES phase 2: per-organiser sending domains, then delete Resend

The big one, gated on the paid tier. §4 of the SES handover has the API mapping
and the three things that will bite (1 req/s on non-send actions, 10,000
identities per region, reputation split per organiser). Deleting Resend is
scheduled for **2026-10-01** if phase 2 slips.

### 6. #60, #81 — compliance and launch-ops leftovers

`#60` item 4 (audiences over 1,000) is **closed by #100**. Item 3 (CAN-SPAM
postal address) is satisfied by `MARKETING_POSTAL_ADDRESS`, which the send path
now fails closed without. Still open there: operational-vs-marketing messages to
ticket-holders, a double-opt-in resubscribe path, and the marketing-list blobs
stamped on the dying test batch. `#81` is the launch ops checklist.

### 7. #82 — event-broadcast hardening: verify and close

All three items look closed by #100 — the rate window now runs inside the
organiser mutex, keys are lowercased throughout, and the on-chain-series
fallback applies per-recipient rather than disabling the check event-wide. Read
the issue against `routes/broadcast-jobs.ts` and close it rather than assuming.

---

## Operational notes that are easy to miss

- **`OPS_TOKEN` must be set** or `/api/ops/*` 404s. Nothing else depends on it.
- **A deploy ends in-flight broadcasts.** SIGTERM records each as `died` with an
  accurate unsent count and the organiser gets a one-click resume that mails
  exactly the remainder — but check first:
  `curl -s https://events-api.woco-net.com/api/health | jq .email.broadcasts`
- **Domain warm-up.** No broadcasts until roughly 2026-08-14. Day-over-day ramp
  is well evidenced; spreading a single broadcast across hours is **not** —
  no primary source (AWS, Google, Yahoo, M3AAWG) supports it. Do not build for it.
- **`SendBulkEmail` is not worth adopting** and the previously recorded reason
  was wrong — see §5 of the SES handover for the corrected version.
- **New `.data` stores get their modes for free now (#130).** `broadcast-jobs/`
  and `broadcast-chunks/` set 0700/0600 themselves; every other store goes
  through `writeJsonAtomic`, and `test/data-store-modes.test.ts` fails the build
  if a new one writes files itself. The ops sweep is no longer the backstop.
