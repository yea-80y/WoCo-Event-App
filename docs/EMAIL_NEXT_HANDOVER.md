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
unresolved transactional failure means somebody paid and has no ticket), and
`broadcasts` (a `died` job nobody resumed).

---

## Next, in order

### 1. #99 — async bounces never reach the failure ledger — **LAUNCH BLOCKER**

The half of the silent-ticket-loss problem #98 did not cover. SES *accepts* a
send to a typo'd address, so nothing retries, nothing fails, nothing is
ledgered — and it hard-bounces minutes later. `ses-webhook.ts` suppresses the
hash, logs a count, and no record says a **paid ticket** went undelivered.
`failureHealth()` stays green.

**What #100 already did for it:**

- The consume-before-process ordering in `ses-webhook.ts` is now commented and
  deliberately kept — it is what stops an SNS redelivery writing a duplicate
  ledger entry once this handler starts writing them.
- `recordFailure` takes `recipients: string[]` + `recipientHashes: string[]`, so
  a bounce naming several recipients records all of them.
- `/api/ops/email-failures` exists, so a bounced ticket is actionable without
  SSH.

**Research already done — do not re-derive:**

- Correlation is by **configuration-set message tags**, which come back on the
  SNS event as `mail.tags`, a map of string → array of strings, alongside
  auto-populated `ses:configuration-set`, `ses:source-ip`, `ses:from-domain`,
  `ses:caller-identity`, `ses:operation`.
  ([Event data examples](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-examples.html))
- Set them with `EmailTags` on `SendEmail`. Tag names and values allow **only**
  `[A-Za-z0-9_-]`, ≤256 chars — no `:`, no base64 padding. So a
  `{eventId}:{hash}` composite must be split across two tags or encoded.
  ([MessageTag](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_MessageTag.html))
- **Identity-level notifications carry NO tags.** Only sends that specify
  `ConfigurationSetName`, on a config set with an SNS destination, are
  correlatable. We do stamp the config set on every send.
- `MessageId` is **not** a safe key: it is assigned at *acceptance*, and AWS
  documents that "on rare occasions, SES may accept an email for delivery even
  though the send request returns an error to the caller… use message tags
  rather than relying solely on the message ID."
  ([How email sending works](https://docs.aws.amazon.com/ses/latest/dg/send-email-concepts-process.html))
- `Permanent/OnAccountSuppressionList` and `OnTenantSuppressionList` do **not**
  count toward the bounce rate; plain `Permanent/Suppressed` does.
- **Gmail complaints never reach SES at all** — Google Postmaster Tools is the
  only visibility. Do not present complaint rate as complete.
- `routes/resend-webhook.ts` has the identical gap. It is pre-existing on both
  providers, so this is a launch blocker, not a cutover blocker.

Acceptance is in the issue. Keep the marketing/transactional plaintext split.

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
