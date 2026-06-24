# Crypto payments — client-verifiable, chain-anchored money fields (Path B)

> Design doc, opened 2026-06-24. Pickup-ready follow-up to the SiteBuilder
> client-signed-events work (Path A). **Not started.** Do this when the crypto
> rail goes live (today Stripe is the only live payment method — memory
> `project_payments_actual_state`). Everything below is verified against source,
> not assumed. Read `CLIENT_FEED_SIGNER_HANDOVER.md` (Phase B) +
> `SITE_EVENTS_CLIENT_SIGNED_HANDOVER.md` + AUTH/SWARM in `CLAUDE.md` first.

## Why this exists

Path A made SiteBuilder event-detail feeds **client-signed** (organiser owns the
SOC) and secured the money path with a **server-trusted carrier**: the money path
threads a `creatorFeedSigner` from a server-written record (global directory or
`SiteEventsIndex`) into `getEvent(eventId, signerHint)` so it reads the authentic
SOC. That keeps the **server in the trust path**. For Stripe that's fine — Stripe
is irreducibly server-settled (secret key, Connect destination, webhook), so a
server trust check adds no new trust.

For **crypto**, the World-Computer goal is **trustless**: anyone (client or
server) should verify an event's price + recipient **without trusting our
server**, so the SOC/feed-signer becomes pure *availability* (zero trust). Path B
delivers that by **anchoring the money fields on-chain**.

## The verified gap (this is the whole point)

The organiser's ed25519 POD key signs `ManifestV1Body`, and the chain commits to
exactly that digest, BUT the body does **not** contain the money fields.

- `ManifestV1Body` (`packages/shared/src/pod/types.ts:54`) commits to:
  `eventId, totalSupply, issuerPubkey, metadataRoot, encoding, treeScheme`.
  **No price, no currency, no recipientAddress, no creatorAddress.**
- Chain anchor IS real and per-series: registration sets
  `manifestRef = manifestDigest(body)` (`apps/server/src/lib/event/service.ts:147-166`),
  and the confirm route REJECTS a mismatch
  (`apps/server/src/routes/events.ts:485` — `onChain.manifestRef !== localDigest`).
  So `manifestDigest(ManifestV1Body)` is already a trustworthy on-chain commitment
  — it just doesn't cover money.
- The money fields live ONLY in the client-signed event SOC, as
  `series[].payment` (`PaymentConfig`: `price, currency, recipientAddress,
  acceptedChains, escrow, cryptoEnabled, stripeEnabled`).

**Consequence:** a POD-signature check alone CANNOT secure payment. An attacker
can keep a valid POD-signed manifest (it only vouches for supply + metadata root)
and swap `payment.recipientAddress` in the SOC. The verifier needs an external
anchor (the chain) that commits to the money fields — and today it doesn't.

### Money-path reads that depend on the (unanchored) SOC payment fields
All read `getEvent(eventId)` and trust `series.payment` / `creatorAddress`:
- `POST /api/payment/quote` — `apps/server/src/index.ts:205` → `series.payment.price`,
  `series.payment.recipientAddress` (or escrow address). Signs the wei amount.
- `claims.ts` claim — `:270` `getEvent`, then `verifyPayment` (on-chain tx checks)
  against the quote/recipient.
- `reservations.ts:103`, Stripe `stripe.ts:386/871` — same `getEvent` reads.
- Stripe recipient is ALSO SOC-derived: `getStripeAccount(event.creatorAddress)`
  (`stripe.ts:494`) — so even card payouts trace to the SOC's `creatorAddress`.
  (Stripe stays server-settled regardless — Path B is about the crypto rail.)

## The plan (Path B)

**Commit the money fields into the POD-signed manifest so the chain `manifestRef`
covers them.** Then price + recipient are verifiable from chain + ed25519, and the
feed-signer/SOC is availability-only.

1. **Schema — version the manifest body.** Add a `woco.manifest.v2` `ManifestV1Body`
   variant carrying a canonical, minimal `paymentCommit` (per series, since
   `manifestRef` is per-series): at least `{ price, currency, recipientAddress,
   acceptedChains, escrow, cryptoEnabled }`. Keep it tight — it's hashed into the
   on-chain commitment. `packages/shared/src/pod/types.ts`.
   - Update `canonicalEncodeManifest` / `manifestDigest`
     (`packages/shared/src/pod/canonical.ts:54/111`) to include the new field
     deterministically. **This changes the digest → changes the on-chain
     manifestRef**, so v2 events register a different commitment. MUST land before
     new paid events register; keep v1 verification for already-registered events.
2. **Populate at build time.** `apps/web/src/lib/pod/event-builder.ts:91` — write
   the `paymentCommit` into `manifestBody` from the series' `PaymentConfig` (the
   builder already has it). Organiser's POD key signs it (no new signing surface).
3. **Verify on read (the trustless check).** A new shared helper:
   given an event + series, recompute `manifestDigest(body)`, verify the ed25519
   sig (`verifySignedManifest`, `merkle.ts`), AND verify
   `chain.events[onChainEventId].manifestRef == that digest` (the
   `events.ts:485` pattern, but as a reusable money-path guard). Then trust
   `body.paymentCommit`. Apply it in:
   - server `POST /api/payment/quote` (sign the wei amount only after the chain
     check passes — replaces "trust SOC `series.payment`"),
   - server `claims.ts` payment verification,
   - client `apps/web/src/lib/payment/pay.ts` + `api/payment.ts` (the buyer
     verifies price/recipient against chain BEFORE paying — this is the part that
     removes the server from the buyer's trust).
4. **Feed-signer → availability only.** Once money is chain-anchored, the
   money-path no longer needs the trusted-carrier signer for *correctness of
   price/recipient* — the carrier becomes a discovery/availability convenience.
   (Keep Path A's carrier for non-paid metadata + discovery.)

## Nuances / gotchas (verified)

- **Per-series, not per-event.** Payment is per series; `manifestRef`/`onChainEventId`
  are per series (`service.ts:147` loops series). Commit payment per-series manifest
  — clean fit, no new on-chain structure.
- **Free events have no chain anchor.** Free series aren't registered on-chain
  (no paid registration). No money to steal → no recipient to anchor. They keep
  Path A discovery (carrier) only. Path B applies to paid series.
- **Escrow vs direct.** `recipientAddress` may be the escrow contract address
  (`series.payment.escrow` → `getEscrowAddress`, `index.ts:32`). The commit should
  capture the escrow flag + intended recipient so the verifier reconstructs the
  same recipient the quote uses.
- **Migration.** Version bump only; verifiers accept v1 (no money trust, legacy)
  and v2 (money-trusted). No live crypto events today, so no data migration — but
  any v1 paid event stays Path-A-trusted until re-registered.
- **Stripe is out of scope for trustlessness.** Card settlement needs the server
  (secret key + Connect). Path B still *helps* Stripe integrity (it could verify
  `creatorAddress`/price against chain before creating the session), but Stripe can
  never be buyer-trustless. Decide per-rail.

## Touch-point file map (verified)
- `packages/shared/src/pod/types.ts:54` — `ManifestV1Body` (+ v2 paymentCommit)
- `packages/shared/src/pod/canonical.ts:54/111` — encode/digest (include new field)
- `packages/shared/src/pod/merkle.ts:105/124` — `signManifest` / `verifySignedManifest`
- `apps/web/src/lib/pod/event-builder.ts:91` — populate `paymentCommit`
- `apps/server/src/lib/event/service.ts:147-166` — manifestRef commit at register
- `apps/server/src/routes/events.ts:469-486` — chain manifestRef match (reuse as guard)
- `apps/server/src/index.ts:190-` — `POST /api/payment/quote` (add chain check)
- `apps/server/src/routes/claims.ts` — payment verify (add chain check)
- `apps/server/src/lib/payment/{quote,verify,constants}.ts` — quote signing + on-chain verify
- `apps/web/src/lib/payment/pay.ts`, `apps/web/src/lib/api/payment.ts` — client-side verify-before-pay

## Status of Path A (context for whoever picks this up)
SiteBuilder events are client-signed (`62a8883`); trusted money-path carrier
`resolveSiteEventSigner` added (`e1ffb11`). Remaining Path A commits: thread the
carrier into Stripe + direct-claim + reservations money paths, and fix
`stampEventSigners` to resolve the signer server-trusted (not the client entry).
See `SITE_EVENTS_CLIENT_SIGNED_HANDOVER.md` + this repo's git log.
