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
  footer (provenance + unsub link) are unconditional. Refuses to send if `PUBLIC_API_BASE`
  unset. **Ticket emails are transactional — NO unsubscribe on them, ever.**
  `/api/marketing/broadcast` also hash-checks every recipient against the stored list (the
  import wizard's consent warranty is the only path to a sendable address); footer insertion
  only honours a document-final `</body>` (a mid-doc `</body>` can't hide it).
- `/u/:token` = public unsubscribe page (one-click POST tolerant of empty body).
  Token `mu1.*` = HMAC(`EMAIL_HASH_SECRET`-derived key) over `{emailHash, org}`; **NO expiry**
  (an expired unsub link = spam complaint). Rotating `EMAIL_HASH_SECRET` invalidates all
  outstanding unsub links AND changes every emailHash.
- Contact list: sealed CLIENT-SIDE to the organiser's X25519 (same as orders), blob on Swarm
  via `uploadToBytes` `RedundancyLevel.STRONG` (first erasure-coding use), pointer feed
  `woco/marketing/list/{addr}`. Server keeps only emailHashes. Plaintext emails transit
  import/check/broadcast bodies transiently (the client can't compute the server-secret HMAC)
  — hashed-and-discarded.
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
apps/server/src/lib/marketing/{suppression-store,unsub-token,list-store,send-cap,
                               sending-domain-store,consumed-webhook-events}.ts
apps/server/src/routes/{marketing,unsubscribe,resend-webhook}.ts
apps/web/src/lib/creator/audience/{AudienceScreen,CsvImportWizard,ContactSearch,
                                   MarketingComposer,SendingDomainPanel}.svelte
apps/web/src/lib/api/marketing.ts             # client wrappers
packages/shared/src/marketing/types.ts        # MarketingContact, list payload, domain types
```

## Gotchas

These `.data` stores MUST survive server restarts:

- `.data/marketing-suppression.json` — **losing it = emailing people who unsubscribed, a
  legal breach**
- `.data/marketing-lists.json`
- `.data/marketing-domains.json`
- `.data/marketing-send-log.json`
- `.data/consumed-resend-events.json`
