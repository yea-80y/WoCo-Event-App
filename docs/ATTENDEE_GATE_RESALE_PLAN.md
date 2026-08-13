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

### Anonymous purchase → account import → resale (verified 2026-08-12)

The launch model sells to buyers with no account: Stripe only, ticket by email, on-chain
slot owned by a burner the server generates and **destroys** (`stripe.ts:1258-1309`,
"Nothing about the burner is persisted apart from its address"). Resale therefore always
begins with an import. Three facts govern how that works.

**1. The seller never needs the burner key.** §5's listing is signed with the seller's
ed25519 POD key, not the slot key — a signed offer delegating settlement to the platform.
The burner dying at purchase is not an obstacle to resale and must not be "solved" by
retaining it. Retaining burner keys is explicitly rejected: it would make the platform
able to forge a valid QR for any slot it minted, which destroying the key is what prevents.

**2. Import binds in OUR records; the chain still names the dead burner.** After a §3
Route A/B import, `slotOwner[eventId][slot]` is unchanged — it is still the discarded
burner address. The account↔edition binding exists only server-side, so the contract
cannot act on it and §5's settlement step 1 has nothing to authorise against. Any design
that assumes an imported ticket is on-chain-owned by the importer is wrong.

**3. `WoCoEventV2` has no transfer function.** `slots[eventId][slot]` is written at
`:315`, `:360`, `:422`, `:460` — all inside claim functions — and never again;
`slotOwner` (`:687`) is a view. The contract is immutable (no proxy, no initialize). So
step 1 of §5 settlement cannot execute today, and the old-QR invalidation it depends on
(`slotOwner` rotation) does not happen either. Tracked as #266.

Two routes out, to decide before launch:

- **V3 with `transferSlot`.** Keeps the chain as the ticket ledger and keeps invalidation
  automatic. Authorisation is the design question: the current owner cannot sign (key
  destroyed), so either the sponsor may transfer slots it minted, or import performs a
  one-time sponsor-authorised move onto a key the holder controls and every later transfer
  is owner-authorised. Note that 3 of 4 login kinds give a smart-account parent
  (`auth-store.svelte.ts` — web3auth `:1298`, passkey `:1486`, coinbase `:1423` vs EOA
  `:1183`), and a smart-account address can never be recovered from an ECDSA signature, so
  the holder-controlled key must be a derived EOA, not the parent address itself.
- **Off-chain reassignment in the CheckinPack.** `scanner/verify.ts` compares the recovered
  signer against `series.slotOwners[edition - 1]`, which is server-built and pre-downloaded
  — reassign there and the old QR dies identically, with no contract change and no key
  anyone needs to hold. Cost: ticket ownership becomes platform-asserted rather than chain
  truth, reversing the position taken when the v1 rail was deleted.

**Resale timing edge.** The seller's old QR stops working only once the organiser's
CheckinPack is rebuilt. Between settlement and that refresh both QRs verify, and a seller
who arrives first gets in while the buyer is bounced. Same class of problem as the
double-sell sequencer above and wants the same answer — treat pack freshness as part of
settlement, not as a background job.

**Forwarded-email import is first-click-wins by design** (§3 Route A: "buyer forwarding
email = implicit consent — supports group buys"). That is a deliberate group-buy
affordance, but it carries different weight once an imported ticket can be sold for money:
whoever clicks first acquires a sellable asset. Revisit the tradeoff when resale ships.

### Why holder-signed tickets are worth more than the resale case alone (2026-08-13)

#265 was assessed on resale and judged close to vanity. That undersold it. Three properties come
from the same change, and only one is resale:

**1. A per-user unique QR that cannot be shared.** Today the QR carries a signature made once at
purchase that never changes — static and bearer, so a photograph is as good as the original. If
the holder signs a **fresh challenge** at the door instead, a copy is worthless without the key.
That is the difference between a claim about the past and a live demonstration.

**2. The ticket becomes an authentication credential.** A credential bound to a key, whose
possession is provable on demand, gates things — venue access, member content, a returning-customer
discount. A bearer token cannot do this, because possession proves nothing about identity.

**3. Owner-authorised resale**, the original case.

**The supply question, and why "one POD claimed by many" does not work for tickets.** Credits are
unbounded and tickets are not — 600 people must not claim into a 500-capacity event. The on-chain
slot is the supply ledger; removing it means reintroducing a counter with a single point of truth.

But the pre-signing IS removable, and should be. Today the organiser pre-signs N ticket bodies at
creation, which is the linear cost in #263 and commits metadata for editions nobody has bought.
Better shape:

| concern | today | proposed |
|---|---|---|
| Metadata | organiser pre-signs N bodies | organiser signs ONE template + supply |
| Scarcity | on-chain slot | unchanged — on-chain slot |
| Ownership | server burner, key discarded | **holder signs their own edition** |
| QR | static, bearer | fresh challenge, unforgeable |

**Two tiers, deliberately.** An anonymous card buyer has no persistent key, and platform-signs-
bound-to-email does not fix it — that is an attestation, not possession proof, so the photocopy
still works. So:

- **Anonymous buyer** → bearer ticket in an email, scanned at the door, checked against chain
  records. Identical to Skiddle and every incumbent. Completely fine, and it is the launch path.
- **Account holder** → holder-signed, unique QR, possession-proven, resaleable, reusable as a
  credential.

The account path being genuinely *better* is the reason to create one — not tidiness. And §3's
import flow is where the transition happens: buy anonymously, import later, and ownership moves
from "bearer in an inbox" to "a key you control".

That makes this architecture better than the incumbents rather than a reimplementation of them:
the basic path matches what people already expect, and the account path offers what no incumbent
can — a ticket that cannot be copied, resells without the platform brokering it, and later works
as a key.

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
