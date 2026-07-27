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
  one bad campaign puts *ticket* email in spam on event day. `RESEND_FROM_MARKETING` is the
  seam; it must point at a separate subdomain before the first imported list is emailed.
- `/u/:token` = public unsubscribe page (one-click POST tolerant of empty body).
  Token `mu1.*` = HMAC(`EMAIL_HASH_SECRET`-derived key) over `{emailHash, org}`; **NO expiry**
  (an expired unsub link = spam complaint). Rotating `EMAIL_HASH_SECRET` invalidates all
  outstanding unsub links AND changes every emailHash.
- Contact list: sealed CLIENT-SIDE to the organiser's X25519 (same as orders), blob on Swarm
  via `uploadToBytes` `RedundancyLevel.STRONG` (first erasure-coding use), pointer feed
  `woco/marketing/list/{addr}`. Server keeps only emailHashes. Plaintext emails transit
  import/check/broadcast bodies transiently (the client can't compute the server-secret HMAC)
  — hashed-and-discarded.
- CSV IMPORT: no source platform (Skiddle/Fatsoma/RA/Eventbrite) publishes an export column
  schema — RA's is promoter-selected per export, so there is no fixed shape at all. Header
  auto-mapping in `csv-import.ts` is therefore a scored GUESS and the wizard always shows the
  mapping dropdowns; decoy headers ("Email Opt In") are scored out so a flag can never be
  imported as an address. Logic is pure + unit-tested (`apps/web/test/csv-import.test.ts`);
  the fixtures are representative, not authoritative — a real export is still worth testing.
  `MARKETING_MAX_LIST_EMAILS` (20k, shared) caps a stored list; `/check` is client-batched.
- Organiser sending domains: Resend Domains API, verify-on-demand (no poller);
  `resolveMarketingFrom`: verified org domain → `RESEND_FROM_MARKETING` → `RESEND_FROM`.
  From-domain never bypasses suppression/headers.
- Resend webhook `/api/resend/webhook`: bounce/complaint → GLOBAL suppression; SDK-bundled
  svix verify UNCONDITIONAL (no `NODE_ENV` gate — a forged bounce = targeted email denial);
  secret unset → acknowledge-and-drop; `svix-id` dedupe.
- **ESP SEAM**: all Resend calls live in `lib/email/` — a future SES migration touches only
  that directory.
- Marketing caps: 2 broadcasts/hr + `MARKETING_DAILY_CAP` (rolling 24h, default 2000) per
  organiser; explicit 429, never a silent trim.
- ABUSE GATE (#59): `/broadcast` + `/domain(create)` require `isVerifiedOrganiser`
  (Stripe `charges_enabled`, same as paid events / free hosting) → 403
  `STRIPE_VERIFICATION_REQUIRED`. Import/read/suppress stay open; **event broadcasts are
  deliberately ungated** (attendee-relationship mail must not depend on Stripe). UI
  pre-checks via `StripeVerifyGate` in `AudienceScreen`.

---

## Key files

```
apps/server/src/lib/email/marketing-send.ts   # THE non-transactional send path
apps/server/src/lib/email/marketing-footer.ts # pure compliance block + text/plain part
apps/server/src/lib/marketing/{suppression-store,unsub-token,list-store,send-cap,
                               sending-domain-store,consumed-webhook-events}.ts
apps/server/src/routes/{marketing,unsubscribe,resend-webhook}.ts
apps/web/src/lib/creator/audience/{AudienceScreen,CsvImportWizard,ContactSearch,
                                   MarketingComposer,SendingDomainPanel}.svelte
apps/web/src/lib/api/marketing.ts             # client wrappers
packages/shared/src/marketing/types.ts        # MarketingContact, list payload, domain types
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
- `.data/marketing-lists.json`
- `.data/marketing-domains.json`
- `.data/marketing-send-log.json`
- `.data/consumed-resend-events.json`
