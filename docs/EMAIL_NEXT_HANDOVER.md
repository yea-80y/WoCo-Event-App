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
  `/api/health`, not a per-message health flip.
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
  be delivered at all. If `email.bounceLedger.untagged` is nonzero after the
  first real bounce, that is the wiring, not the code.

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

### 2. #96 — marketing must fail closed when the marketing from-address is unset

`resolveMarketingFrom` falls back to the **transactional** address, which puts
imported-list marketing on the domain that carries ticket delivery. Small
change. **Check the env name first** — the issue predates SES and names
`RESEND_FROM_MARKETING`; post-cutover the marketing from-address may need an
SES-side equivalent. It is unset in production today.

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
- **New `.data` stores need their modes checked.** `broadcast-jobs/` and
  `broadcast-chunks/` are created 0700 with 0600 files, but the sweep in the ops
  runbook is still the backstop.
