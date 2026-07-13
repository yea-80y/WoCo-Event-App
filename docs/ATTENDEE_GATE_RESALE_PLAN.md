# Attendee Account Gate, Ticket Identity-Binding & Resale — Architecture Plan

Status: DESIGN AGREED 2026-07-11 — not yet built.
Prereq reading: CLAUDE.md (auth architecture), docs/CRYPTO_AUDIT_2026-04-08.md.

## 1. Key inventory (do not conflate)

| Key | Curve | Role |
|---|---|---|
| Organiser POD identity | ed25519 | Signs ticket editions (`SignedTicket.signature`) |
| Attendee POD identity | ed25519 | Future owner-of-record for tickets; signs ownership challenges |
| Feed signer | secp256k1 | Swarm SOC writes ONLY — no role in ticketing |
| Burner slotOwner | secp256k1 | Stripe v2 path: on-chain `slotOwner`, signs per-ticket QR sig, key discarded |

## 2. Security facts this design rests on

- `ClaimedTicket` PODs live on PUBLIC Swarm feeds (`woco/pod/claims/{seriesId}`).
  POD possession proves NOTHING. Never authenticate by POD upload alone.
- The only secrets a buyer uniquely holds today:
  1. The purchase email inbox (`ownerEmailHash` = HMAC-SHA256, matchable without storing plaintext).
  2. The per-ticket QR sig (`ticketSig` — generated in stripe.ts webhook, exists ONLY in the
     email, never persisted; verifiable vs on-chain `slotOwner`).
- v1 (non-Stripe) QRs carry the per-series ed25519 sig which IS reconstructable from public
  feeds — v1-format tickets must not be accepted as possession proof, and the door scanner
  must not accept v1 QRs unless a separate verification path is built. Production = Stripe v2 only.

## 3. Attendee account gate

Gate: attendee profile creation (sub-ENS, like/follow, MyTickets) requires proving rightful
possession of ≥1 ticket. Wallet-claimed tickets need no gate (claimer address IS an account).

### Route A — email CTA (primary funnel)
- Ticket email gains "Create your WoCo profile" button carrying single-use HMAC-signed token
  (same pattern as PaymentQuote): commits to `{eventId, seriesId, edition, emailHash, exp}`.
- Click = proof of inbox access. First click wins (buyer forwarding email = implicit consent —
  supports group buys). One-shot consumption.

### Route B — in-app "I have a ticket"
- User pastes `/t/...` link (or scans QR) AND enters their email.
- Server: verify `ticketSig` vs `slotOwner` (authenticity) → HMAC entered email, compare to
  `ownerEmailHash` (knowledge) → send 6-digit code to that address (control). All three required.
- No plaintext email ever stored.

### Nullifier + binding
- `.data/ticket-gate-nullifiers.json`: `(onChainEventId|eventId, edition)` consumed exactly once
  for account gating. SEPARATE namespace from door check-in nullifiers.
- Binding record: `(eventId, edition) → { parentAddress, podPubKey, paid, boundAt }`.
- On bind: stamp attendee ed25519 pubkey into `ClaimedTicket.owner` (field already exists) and
  republish the claims-feed slot. From then on ownership is client-verifiable: owner signs
  challenges with their POD key. This is the de-platformed end state.
- Binding record doubles as the paid-ticket history for gating gasless EAS sponsorship (open TODO)
  and unique-paid-payer weighting in the Stylus aggregator.

### Go-forward claims (once accounts exist)
- Attendee with account: ed25519 pubkey stamped into claimed POD AT CLAIM TIME.
- `woco.ticket.claimed.v2`: organiser/platform signature covers the owner binding →
  issued-to-identity, no longer bearer. Bearer dance remains only for the legacy email cohort.

### Sybil posture
- 1 edition = 1 profile unlock. `paid` flag kept in binding; restrict sub-ENS / gasless
  sponsorship to paid tickets if free-ticket farming appears.

## 4. Durability

- Nothing sold to date is lost: `/t` sig verifiable against chain indefinitely + emailHash in
  claim record → retroactive binding always possible.
- Add "Download ticket" (POD JSON incl. qrContent + sig chain) to `/t` page next to "Save image".
- Google Wallet (Generic Pass, JWT "Save to Google Wallet" link; needs GCP service account +
  issuer registration) = post-launch convenience. Adds zero security — still bearer.
  Apple Wallet needs $99/yr cert + .pkpass signing — defer.

## 5. Resale (build gate/binding first — resale falls out of it)

### Model: signed offer + platform sequencer + on-chain finality
- LISTING: seller signs with their ed25519 POD key:
  `woco-ticket-listing-v1\n{eventId}\n{seriesId}\n{edition}\n{priceMinor}\n{currency}\n{expiry}\n{nonce}`
  This is a signed OFFER delegating settlement authority to the platform for that edition at
  that price — seller need not be online at sale time.
- SETTLEMENT (Stripe webhook = sequencer, per-series mutex as with claims):
  verify listing sig + seller is current owner + listing not consumed →
  1. on-chain `slotOwner` transfer (v2 tickets) — publicly final
  2. update `ClaimedTicket.owner` → buyer ed25519 pubkey; append transfer record
     `{listingSig, buyerPubKey, paymentRef, platformSig}` — auditable chain of custody
  3. issue NEW per-ticket credential to buyer (fresh burner as new slotOwner, new QR sig)
- OLD-QR INVALIDATION (the resale-specific attack: seller keeps a screenshot):
  slotOwner change makes the old sig fail `verifyMessage(canonical, sig) === slotOwner`
  automatically — existing verifier code, zero new logic. THIS is why resale should be
  restricted to v2 (on-chain) tickets at launch.
- Double-sell: single sequencer + one-shot listing nonce + on-chain finality.
- Organiser resale policy hook: max price (face + x%), royalty bp, resale on/off — enforceable
  at the sequencer since the platform runs settlement.

### Stripe rail for seller payout (from Connect decision matrix)
- Seller = connected account via **Accounts v2** with `configuration.recipient` ONLY
  (request `stripe_transfers` on `stripe_balance`; do NOT request `merchant`/`card_payments` —
  that's what triggers the heavy merchant onboarding).
- `dashboard: "none"` + embedded components (white-label; attendees never see Stripe),
  `fees_collector: "application"`, `losses_collector: "application"`.
- Charge pattern: **separate charges and transfers** (NOT destination) — buyer pays platform,
  transfer to seller released only after ticket transfer commits; enables hold-and-release
  (e.g. hold until event passes to kill sell-then-dispute fraud).
  Fee = transfer math (`application_fee_amount` is INCOMPATIBLE with separate charges).
- KYC reality: zero-KYC payouts don't exist (AML law, not Stripe policy). Recipient config +
  progressive requirements = light initial onboarding (name, DOB, bank) with ID docs deferred
  until volume/risk thresholds. A one-off £30 seller very likely never hits document verification.
  Confirm thresholds with Stripe for the platform profile.
- Alternative for launch simplicity: resale proceeds as platform credit (no seller onboarding
  at all) — rejected as primary (user wants direct payout) but viable fallback.
- Platform is merchant of record on resale — discuss tax/reseller-of-record posture with Stripe.

## 6. Threat table

| Threat | Mitigation |
|---|---|
| Public-feed POD replay | POD never accepted as credential; possession proofs only |
| Forwarded/leaked QR claims gate | Route B triple check; Route A one-shot token; nullifier caps at 1 |
| Retro-binding squat (countersign public POD) | Binding requires possession proof FIRST; countersig records, never establishes |
| One ticket → many profiles | One-shot gate nullifier per edition |
| Free-ticket sybil | `paid` flag; restrict sub-ENS/sponsorship to paid if needed |
| Resale double-sell | Platform sequencer + one-shot listing nonce + on-chain slotOwner finality |
| Seller reuses old QR post-sale | slotOwner rotation auto-invalidates old sig (v2-only resale) |
| Seller sells then disputes card payment | separate charges + hold-and-release; platform loss liability |
| Server data loss | Bindings/transfers rebuildable: chain + feeds + sig records |

## 7. Build order

1. Gate nullifier + binding store; gate check in attendee profile creation.
2. Route B endpoints + onboarding UI ("I have a ticket").
3. Route A: token endpoint + email CTA + landing → account creation → like/follow prompt.
4. `owner` stamping on bind; "Download ticket" POD on `/t` page.
5. `woco.ticket.claimed.v2` (owner-at-claim-time, signed binding).
6. Resale: listing sig + sequencer + slotOwner transfer + credential re-issue (v2 tickets only).
7. Stripe recipient-account rail (talk to Stripe first re: recipient thresholds + MoR posture).
8. Post-launch: Google Wallet pass.
