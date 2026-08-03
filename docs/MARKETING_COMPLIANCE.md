# Marketing Audience / Email Compliance

Moved out of `CLAUDE.md` (2026-07-27) to keep the always-loaded context small.
Established 2026-07-18. Organiser marketing lists (CSV import from Skiddle/Fatsoma/RA)
+ broadcasts.

**GDPR posture: organiser = data controller, WoCo = processor.**

Fee/pricing arithmetic lives in `docs/PRICING_AND_EMAIL.md`. Legal surface lives in
`docs/legal/DATA_INVENTORY.md` and `docs/legal/PRIVACY_POLICY.md`.

---

## Load-bearing facts

- **SUPPRESSION IS THE GUARANTEE**: server-side list keyed by `hashEmail()` HMAC, checked
  inside `sendMarketingBatch` on EVERY non-transactional send — survives CSV re-uploads.
  Per-organiser scope (default) + global (opt-all / bounce / complaint). Swarm deletion is
  hygiene, never the enforcement layer.
- `sendMarketingBatch` (`lib/email/marketing-send.ts`) is the ONLY allowed non-transactional
  send path: suppression + RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` headers +
  footer (provenance + unsub link + postal address) + a `text/plain` alternative part are
  unconditional. **Ticket emails are transactional — NO unsubscribe on them, ever.**
  `/api/marketing/broadcast` also hash-checks every recipient against the stored list (the
  import wizard's consent warranty is the only path to a sendable address); footer insertion
  only honours a document-final `</body>` (a mid-doc `</body>` can't hide it).
- **FAILS CLOSED on misconfiguration**: refuses to send if `PUBLIC_API_BASE` (unsub links) or
  `MARKETING_POSTAL_ADDRESS` (CAN-SPAM §7704(a)(5)) is unset. Sending non-compliant mail is
  worse than not sending — both are legal breaches that also burn reputation permanently.
- The footer builder (`lib/email/marketing-footer.ts`) is pure and unit-tested
  (`test/marketing-footer.test.ts`). It **HTML-escapes the organiser display name**: unescaped,
  a 60-char name fits `<div style=display:none>` (24 chars, no quotes needed) and would hide
  the unsubscribe link itself, defeating the whole control.
- **REPUTATION SPLIT**: marketing must not share a sending domain with ticket email. Mailbox
  providers score reputation per domain and Gmail/Yahoo cap complaints at 0.3% per domain, so
  one bad campaign puts *ticket* email in spam on event day. `EMAIL_FROM_MARKETING` is the
  seam (`RESEND_FROM_MARKETING` is the legacy alias); it must point at a separate subdomain.
  **It fails closed (#96)**: unset, empty or whitespace refuses platform marketing sends with
  503 rather than falling back to the transactional address, and `/api/health` →
  `email.marketingSender.ok` reports it. The old fallback silently put imported cold lists on
  the ticket domain, which is the exact outcome this rule exists to prevent.
- `/u/:token` = public unsubscribe page (one-click POST tolerant of empty body).
  Token `mu1.*` = HMAC(`EMAIL_HASH_SECRET`-derived key) over `{emailHash, org}`; **NO expiry**
  (an expired unsub link = spam complaint). Rotating `EMAIL_HASH_SECRET` invalidates all
  outstanding unsub links AND changes every emailHash.
- Contact list: sealed CLIENT-SIDE to the organiser's X25519 (same as orders), blob on Swarm
  via `uploadToBytes` `RedundancyLevel.STRONG` (first erasure-coding use), pointer feed
  `woco/marketing/list/{addr}`. Server keeps only emailHashes. Plaintext emails transit
  import/check/broadcast bodies transiently (the client can't compute the server-secret HMAC)
  — hashed-and-discarded.
- **THE SEALED LIST IS GZIPPED BEFORE SEALING** (`sealJsonCompressed` / `openJsonAuto`,
  measured 2026-07-27). Uncompressed, a 20k-contact list is ~4MB of JSON → ~8MB of hex
  ciphertext, which **exceeds `MAX_SEALED_JSON` (6MB) — i.e. a max-size list was
  unstorable**. Gzip puts it near 1MB even with every optional field set. `openJsonAuto`
  sniffs the gzip magic number rather than a version field (framing must be decided before
  the payload parses; JSON can never start with `0x1f8b`), so pre-compression blobs still
  open — do not replace that sniff with a version check. Columnar encoding was measured and
  rejected: it buys ~6% once gzip has already collapsed the repeated keys.
- The whole list is re-sealed and re-uploaded on EVERY change (`commitList`). That is fine
  at the 20k cap — one ~1MB atomic write, single writer, single reader — and is deliberately
  NOT the paged/append-only shape the public events directory needs. Different problem:
  one private blob rewritten by its owner vs. a many-writer public index.
- CSV IMPORT: no source platform (Skiddle/Fatsoma/RA/Eventbrite) publishes an export column
  schema — RA's is promoter-selected per export, so there is no fixed shape at all. Header
  auto-mapping in `csv-import.ts` is therefore a scored GUESS and the wizard always lets a
  human correct it; decoy headers ("Email Opt In") are scored out so a flag can never be
  imported as an address. Logic is pure + unit-tested (`apps/web/test/csv-import.test.ts`);
  the fixtures are representative, not authoritative — a real export is still worth testing.
  `MARKETING_MAX_LIST_EMAILS` (20k, shared) caps a stored list; `/check` is client-batched.
- Mapping step is COLUMN-FIRST (`ColumnMapper.svelte`): the organiser's own columns are the
  objects, each showing real sample values, and a tap assigns a role. Tap, not drag —
  drag targets are unreliable on touch and a `<button>` + listbox gets a11y for free.
  Sample values are the point: a column named "Contact" holding phone numbers is obvious
  from the data and invisible from the header.
- `fullName` is a MAPPING-ONLY pseudo-field — it splits into firstName/lastName at build
  time and never reaches `MarketingContact`. `splitFullName` is deliberately conservative
  (particle-aware surnames, comma form inverted, titles/suffixes stripped); an unreadable
  shape goes wholly to firstName, because a mail addressed to a full name reads fine and an
  invented surname does not.
- **CONSENT COLUMN GATES THE IMPORT**: a row whose mapped consent column reads an explicit
  negative is EXCLUDED and counted in its own manifest bucket, ahead of the dupe checks.
  Blank/unrecognised is `unknown`, NOT refusal — most exports omit the column and treating
  silence as refusal would reject whole legitimate files. The consent warranty on the review
  step remains the legal basis. `consent` is the one field exempt from the shared decoy
  regex (a consent column is supposed to look like a flag) and carries its own guard so a
  consent DATE is not mistaken for the flag.
- Organiser sending domains: Resend Domains API, verify-on-demand (no poller);
  `resolveMarketingFrom`: verified org domain → `EMAIL_FROM_MARKETING` → **null** (refuse).
  Only the event-broadcast lane falls back to `EMAIL_FROM`, spelled out at its call site in
  `routes/broadcast-jobs.ts`: those recipients consented by buying a ticket, and "the event
  is cancelled" must be sendable whatever state the platform's email config is in.
  From-domain never bypasses suppression/headers.
- Resend webhook `/api/resend/webhook`: bounce/complaint → GLOBAL suppression; SDK-bundled
  svix verify UNCONDITIONAL (no `NODE_ENV` gate — a forged bounce = targeted email denial);
  secret unset → acknowledge-and-drop; `svix-id` dedupe.
- **ESP SEAM**: all Resend calls live in `lib/email/` — a future SES migration touches only
  that directory.
- **RESEND APPROVED THE MODEL IN WRITING** (email, 2026-07-29): *"As long as you're
  properly adding Unsubscribe headers, and sending emails that are opted into via the
  email API, this is okay on the transactional plan."* Marketing over `POST /emails` with
  our own compliance layer is sanctioned — the residual policy risk from
  `docs/PRICING_AND_EMAIL.md` §2/§9 is closed. Their two conditions are exactly what
  `sendMarketingBatch` enforces unconditionally (RFC 8058 headers; suppression + consent).
  Note their tiers: Free = **1 sending domain** (verified 2026-07-29 — the "10 on Free"
  figure previously in PRICING_AND_EMAIL §2 was wrong; 10 is Pro), so the marketing
  subdomain split requires the $20/mo Pro plan when an imported list makes it mandatory.
- Marketing caps: 2 broadcasts/hr + `MARKETING_DAILY_CAP` (rolling 24h, default 2000) per
  organiser; explicit 429, never a silent trim.
- ABUSE GATE (#59): `/broadcast` + `/domain(create)` require `isVerifiedOrganiser`
  (Stripe `charges_enabled`, same as paid events / free hosting) → 403
  `STRIPE_VERIFICATION_REQUIRED`. Import/read/suppress stay open; **event broadcasts are
  deliberately ungated** (attendee-relationship mail must not depend on Stripe). UI
  pre-checks via `StripeVerifyGate` in `AudienceScreen`.
- **EVENT BROADCASTS ARE ATTENDEE-ONLY** (2026-07-27): `/api/events/:id/broadcast` HMAC-hashes
  every recipient and requires it in the event's claimers feeds (`email:{hash}` handle or
  `secondaryEmailHash`) — `lib/event/attendee-emails.ts`. This is what makes the two exemptions
  above defensible; without it the endpoint reached arbitrary addresses outside the consent
  warranty. Rejections report a COUNT, never the addresses (otherwise the error is an oracle for
  "does this person hold a ticket"). v2 on-chain series keep the claimer identity inside the
  sealed blob only, so membership is unprovable server-side — those fall back to
  `isVerifiedOrganiser`.
- **CONSENT AT CHECKOUT IS BUILT AND WIRED ON EVERY PATH.** The field is `marketingConsent`, NOT
  `marketingOptIn` — grepping the latter finds nothing and has already produced one wrong "this
  does not exist" write-up. Wording + version live in `packages/shared/src/legal/consent.ts`
  (`MARKETING_CONSENT_NOTICE`, `MARKETING_CONSENT_VERSION`); client and server read the SAME
  constant so the stored evidence matches what was shown. Unticked by default (Planet49, C-673/17).
  Tri-state: grant → `recordConsent` (`.data/marketing-consent.json`); refusal → `suppressOrg`,
  so "no" needs no new enforcement path; ABSENT means the order form was never shown, i.e. never
  asked, and records nothing. Free/wallet claims record in `routes/claims.ts`; Stripe rides in
  session metadata (`"1"`/`"0"`) and records in the WEBHOOK, after the claim lands — an abandoned
  checkout must not leave a permission behind.
- THREE CONSENT STATES, not two: `contactConsentState` in `packages/shared/src/marketing/types.ts`
  (`opted-in` | `imported` | `unsubscribed`), suppression outranking any earlier grant.
  `imported` is the one that matters — mailable only on the strength of the import warranty, with
  no per-person evidence. `/check` returns `consented` so the UI can draw the distinction; own
  organiser scope only, so it cannot probe consent given to anyone else.

---

## Key files

```
apps/server/src/lib/email/marketing-send.ts   # THE non-transactional send path
apps/server/src/lib/email/marketing-footer.ts # pure compliance block + text/plain part
apps/server/src/lib/marketing/{suppression-store,consent-store,unsub-token,list-store,send-cap,
                               sending-domain-store,consumed-webhook-events}.ts
apps/server/src/lib/event/attendee-emails.ts  # who may receive an EVENT broadcast
apps/server/src/routes/{marketing,broadcast,unsubscribe,resend-webhook}.ts
apps/web/src/lib/creator/audience/{AudienceScreen,CsvImportWizard,ColumnMapper,ConsentLedger,
                                   ContactSearch,ContactDetail,MarketingComposer,
                                   SendingDomainPanel}.svelte
packages/shared/src/legal/consent.ts          # the wording, versioned — single source of truth
apps/web/src/lib/creator/audience/csv-import.ts # PURE: header scoring, name split, consent,
                                                # manifest. All import logic lives here.
apps/web/src/lib/api/marketing.ts             # client wrappers
packages/shared/src/marketing/types.ts        # MarketingContact, list payload, domain types
packages/shared/src/crypto/compress.ts        # gzip over CompressionStream (no deps)
```

## Gotchas

**The production `RESEND_API_KEY` is send-only** (`restricted_api_key`, verified against the
live API 2026-07-27). `/api/marketing/domain` create/verify calls `domains.create` and will
401 → the route returns 502 and `SendingDomainPanel` is dead in production. Either issue a
full-access key or keep organiser sending domains switched off until SES (which
`docs/PRICING_AND_EMAIL.md` §6 says is the plan anyway — do not onboard organiser domains on
Resend, the DNS re-do is migration debt).

These `.data` stores MUST survive server restarts:

- `.data/marketing-suppression.json` — **losing it = emailing people who unsubscribed, a
  legal breach**
- `.data/marketing-consent.json` — **losing it = no Art. 7(1) evidence for any checkout opt-in.
  The contacts survive in the organiser's sealed list; the proof they agreed does not**
- `.data/marketing-lists.json`
- `.data/marketing-domains.json`
- `.data/marketing-send-log.json`
- `.data/consumed-resend-events.json`

---

## Verification gate: fail-open on a Stripe outage

`isVerifiedOrganiser` (`lib/stripe/verification.ts`) falls back to the cached
`onboardingComplete` flag when the Stripe API is unreachable, rather than refusing the send.
That is a deliberate availability choice, documented in the file itself but previously not
here — an organiser mid-event should not lose the ability to mail their own attendees because
Stripe is having a bad afternoon.

The exposure is bounded: the fallback can only re-affirm an account that already completed
onboarding at some point. It cannot admit an organiser who was never verified, and it cannot
bypass suppression, which is re-checked per recipient inside `sendMarketingBatch` regardless.

## Data-subject requests

Art. 15 / Art. 17 servicing is `apps/server/scripts/data-subject-request.ts`
(policy + tests in `lib/marketing/subject-request.ts`). Procedure and the three things
outside its reach: `docs/legal/DATA_INVENTORY.md` §6.

**Suppression marks are never erased** — Art. 17(3)(b): the record of an objection is what
lets the controller keep honouring it. Erasing it would re-expose the person to the
organiser's next contact upload.

## Store durability

`marketing-suppression.json`, `marketing-consent.json` and `marketing-lists.json` are written
through `lib/marketing/persist.ts` — temp-file + fsync + atomic rename, so a crash or full disk
cannot leave a truncated file that the loaders would silently read as "no data". A store that
stops persisting is reported on `GET /api/health` as `compliancePersistence`; alarm on it the
same way as on `payoutSweep.stale`.
