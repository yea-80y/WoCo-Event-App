# Handover — Wire in the Feed-Signer Escrow

**Created:** 2026-06-27. **Goal of next session:** make the client content-feed signer
an **escrowed** secret (recoverable across devices), not a slot that is merely reserved.

Read this whole file first. The facts below are **verified against the code in this repo**
(file:line cited) — do NOT re-derive them; that is what burned tokens last session.

---

## The one decision to make with the user BEFORE coding

The shipped code and the design docs DISAGREE. Resolve this first:

- **Shipped code:** the feed signer is **deterministically derived** from the login root key.
  `deriveContentFeedSigner(rootKey) = new Wallet(keccak256(CONTENT_FEED_SIGNER_DOMAIN ‖ rootKey))`
  — `packages/.../content-feed.ts:41`, called by `_getContentFeedSigner` at
  `apps/web/src/lib/auth/auth-store.svelte.ts:193-201`. No randomness, no stored-key read.
- **Design docs:** the feed signer should be an **INDEPENDENT secret, escrowed** in the
  `RecoveryBundle` — NOT derived. See `docs/CLIENT_FEED_SIGNER_HANDOVER.md:79-81`,
  `docs/PASSKEY_RECOVERY_PLAN.md §11.6 step 3`, `docs/CROSS_DEVICE_RECOVERY.md §4`.

Two viable implementations — ask the user which:
- **(A) Keep deriving + escrow the derived key.** Lower blast radius. Cross-device restore
  works as long as the root login key is restored (the portability bundle already carries
  `passkeyPrivKey`), so escrow is belt-and-suspenders. Closest to current code.
- **(B) Switch to an independent random feed signer, escrow it.** Matches the doc's
  "independent secret". Required if the root key is NOT reliably portable across devices
  (different passkey credential ⇒ different PRF ⇒ different derived key). Bigger change:
  every existing user's feed signer ADDRESS changes ⇒ they'd lose ownership of feeds already
  written under the derived address unless migrated. **Migration risk — flag loudly.**

The user believes the independent-escrow design was already built. It is NOT (see below).
The memory note `project_passkey_recovery` says the cross-device fix is *DESIGNED, not shipped*.

---

## Verified current state (escrow is NOT wired)

- `recovery-escrow.ts` (the escrow module) **v1 ships `{ podSeed }` ONLY**. The feed-signer
  slot is explicitly *"reserved at zero cost… added later"* — see the module doc-comment
  lines ~29-31 and ~55. Construction is HPKE (RFC 9180, `@hpke/core`) + XChaCha20-Poly1305
  (`@noble/ciphers`); guardian key is derived from a fixed EIP-712 sig (no key at rest).
- `recovery-portability.ts` has `feedSignerPrivKey?: string` as a **reserved pass-through**
  (lines ~97, 99, 108, 136, 178). Nothing POPULATES it on bundle build, and the signing path
  NEVER reads it back.
- `_getContentFeedSigner` (`auth-store.svelte.ts:193`) ALWAYS derives; there is no
  "use escrowed key if present" branch. `_getContentFeedRootKey` (same file, ~179) returns the
  raw login key for kind `passkey` (PRF), `web3auth`, `local`; returns `null` for web3/coinbase
  (external wallets have no feed signer at all — separate gap).

## Implementation surface (where the work lands — mostly client-side crypto)

- `apps/web/src/lib/auth/recovery-escrow.ts` — add `feedSignerPrivKey` to the sealed bundle.
- `apps/web/src/lib/auth/recovery-portability.ts` — populate it on build, return it on restore.
- `apps/web/src/lib/auth/auth-store.svelte.ts` — `_getContentFeedSigner` must prefer a
  restored/escrowed key over deriving (decision A vs B changes this). Find where recovery
  bundles are built + applied (grep `buildPortabilityBundle`, `applyRecovered`, `sealRecoveryBundle`).
- Server: the escrow envelope is stored server-side as ciphertext only (`RecoveryEnvelope`).
  Check the existing recovery write/read endpoints — escrow already works for `podSeed`, so the
  feed-signer addition should ride the SAME endpoints (no new server crypto).
- Relevant shared consts: `CONTENT_FEED_SIGNER_DOMAIN = "woco/feed-signer/v1"`
  (`packages/shared/src/swarm/soc.ts:164`), `StorageKeys.CONTENT_FEED_SIGNER_ADDRESS`
  (`packages/shared/src/auth/constants.ts:49`).

## Verification

- Same-device: log in, publish, confirm `POST /api/swarm/soc` 200 (event client-signed) — works today.
- Cross-device (the actual point): recover on a 2nd device/credential, confirm the SAME feed-signer
  ADDRESS is restored (not a fresh derived one) and the user can re-sign/own their existing feeds.
- `docs/RECOVERY_VERIFICATION_CHECKLIST.md` exists — reuse it.

## Deploy notes

- This is **frontend** crypto → the **user runs `npm run deploy`** (Swarm) themselves; for dev
  they test via `npm run dev` (HMR against prod API). Claude owns server deploys only.
- If anything server-side changes, deploy per `CLAUDE.md` STEP 1 (rsync + `docker compose up -d
  --build --force-recreate server`; `--force-recreate` matters — a plain `up` did NOT recreate the
  container last session). Verify `curl https://events-api.woco-net.com/api/health`.

---

## Context: what was JUST done this session (do not undo)

Three fixes shipped (server deployed + healthy; frontend Fix A live via the user's dev, NOT yet
`npm run deploy`d to Swarm):

1. **Fix A** — event feeds are now ALWAYS client-signed. `PublishButton.svelte:~186`:
   `feedSigner = await auth.getContentFeedSigner()` (dropped the `apiUrl ? null` platform fallback).
   Platform signer is now ONLY for the WoCo directory.
2. **Fix B** — `register-on-chain` reads the client SOC directly via the creator-supplied signer,
   skipping the ~32s whole-directory `resolveCreatorFeedSigner`/`listEvents` read.
   `apps/server/src/routes/events.ts` (register handler) + exported `readEventFeedSoc`
   (`service.ts`, now `export`).
3. **Confirm-step fix** — `confirmSeriesOnChain(eventId, seriesId, onChainEventId, signerHint?)`
   takes the hint too (same reason); the route passes it. This fixed a 500
   ("Tx confirmed but feed update failed") AND the leftover 32s in the confirm step.

All temp instrumentation was removed. `npm run build:server` is green.

## Other OPEN gaps found this session (not this task — note for later)

- **Etherna routing at create:** the gateway dropdown (`gatewayUrl`, default `gateway.etherna.io`,
  `SiteBuilder.svelte`) is used ONLY at **deploy (step 3)**. Create (steps 1-2) ignores it —
  `/api/events`→`createEventV2`→`uploadToBytes` always writes the WoCo bee + WoCo batch
  (`bytes.ts:46`); the client SOC also goes to the WoCo bee via `/api/swarm/soc`. The user wants
  the WoCo bee used ONLY for the directory, everything else on the Etherna batch when selected.
  Separate work: thread batch selection through `/api/events`, `uploadToBytes`, `/api/swarm/soc`.
- **Client SOC upload latency:** Fix A added a `POST /api/swarm/soc` step at publish (the "stuck
  at 20%" the user sees). `soc-upload.ts` already sends `Swarm-Deferred-Upload: true` and awaits a
  `whitelistHashes` round-trip — candidate to make fire-and-forget.
- **registerEvent gasless via ZeroDev:** currently the WoCo sponsor EOA (own-gas). Moving to
  ZeroDev paymaster is possible but a separate phase and does NOT reduce latency.

## Working style (from this project's memory / user feedback)

- Crypto-expert posture: verify addresses/keys against authoritative sources; preserve raw signed
  bytes; never hand-roll ECIES (use the existing HPKE/XChaCha20 primitives in `recovery-escrow.ts`).
- Be 100% certain before claiming architecture — read the code, cite file:line, do NOT guess. The
  user will (rightly) push hard on any unverified claim.
- Small, revertable commits at logical milestones. Comments = WHY only, production-strict.
