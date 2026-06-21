# Client-Side Feed Signer + Cross-Device Recovery — Build Handover

**Status:** PHASE A ✅ CROSS-DEVICE VERIFIED (2026-06-21) — typecheck-green, every
off-chain + on-chain primitive verified (below), AND the owner's live cross-device
test PASSED: recovered passkey on laptop → same passkey on mobile → SAME crypto
address. Security-reviewed (2026-06-21): no HIGH/MED findings (see "Security review
gate" below). PHASE B (migrate content feeds off the platform key) NOT started — see
the handover at the bottom of this doc. Read `CROSS_DEVICE_RECOVERY.md`,
`EMAIL_WEB3AUTH_LOGIN.md`, `CLAUDE.md` (AUTH + SWARM) first.

## Phase A — BUILT (2026-06-21)

Files:
- `packages/shared/src/swarm/soc.ts` — BMT/SOC address calc (cross-checked
  byte-identical vs installed bee-js `chunk/bmt.js`), `PortabilityEnvelope` type,
  fixed identifier + the two PRF key-derivation domains.
- `apps/server/src/lib/swarm/soc-upload.ts` + `routes/swarm.ts` —
  `POST /api/swarm/soc` (auth; re-derives the CAC address, verifies the sig
  recovers to the claimed owner via bee-js `Signature` BEFORE stamping, raw
  `/soc/{owner}/{id}?sig=` upload mirroring `etherna/upload.ts`, then whitelists
  the SOC address on the proxy) and unauth `GET /api/swarm/soc/:owner/:identifier`
  (read by computed chunk address — availability fallback).
- `apps/web/src/lib/swarm/client-soc.ts` — `signAndUploadSoc` (bee-js
  `makeSingleOwnerChunk`, same digest as the proven feed path) + `readSoc`
  (GATEWAY-FIRST via `makeSOCReader`, server fallback).
- `apps/web/src/lib/auth/recovery-portability.ts` (+ `recovery-escrow.ts`
  `deriveEncryptionKeypairFromSeed`) — domain-separated SOC-owner + X25519 keys
  from the passkey PRF key; seal/write/read the envelope reusing the audited
  HPKE/XChaCha (one extra recipient).
- `apps/web/src/lib/auth/kernel-account.ts` `readKernelEcdsaOwner` — gasless
  `eth_call` on the v3.1 ECDSA validator singleton
  `0x845ADb2C711129d4f3966735eD98a9F09fC4cE57`, getter
  `ecdsaValidatorStorage(address)` (selector `0x20709efc`).
- `apps/web/src/lib/auth/auth-store.svelte.ts` — `loginPasskey` new-device
  read→on-chain-verify→apply (override + `storePodSeed` AFTER
  `_clearStaleAuthForSwitch`); `ensureSession` fires `_maybeBackfillPortabilityEnvelope`
  (writes the envelope on the first authenticated action — recovery does NOT force
  a session, preserving deferred-signing).

Verified (assume-nothing): BMT/SOC addr == bee-js; SOC sign→server-validate
round-trips with a bee-js-built chunk; HPKE multi-recipient seal opens with BOTH a
guardian key and the PRF-derived key (and the reserved `feedSignerPrivKey` slot
round-trips); whitelisting flips the gateway `403→404` on `/chunks` with CORS `*`;
`ecdsaValidatorStorage(kernel)` returns the exact owner from the `OwnerRegistered`
event for a live Arb Sepolia Kernel.

READ trust model (why gateway-first + server fallback is sound): a SOC read is
self-authenticating (`makeSOCReader` rejects unless the recovered signer == the
requested owner), the payload is HPKE-sealed, and the final authority is the
on-chain owner check — so the read SOURCE is untrusted and extra sources add only
availability, zero trust. The server GET is availability-only and retireable once
all reads prove out on the gateway.

## Goal (Phase A only)

Make a **recovered passkey account work on a second device**. Today the Kernel-
address override (`RECOVERED_KERNEL_BINDING`) and the escrow-restored POD seed are
written to the *recovery device's* IndexedDB only, so a new device shows the wrong
address and a divergent POD identity. See `CROSS_DEVICE_RECOVERY.md` §1–2 for the
full root cause.

**Phase A delivers:** a *client-owned Single-Owner-Chunk (SOC) write* capability
(client signs, server stamps), and a **PRF-sealed portability envelope** built on
it that carries `{ preservedKernelAddress, podSeed[, feedSignerPrivKey] }` to any
device holding the passkey, trusted via an **on-chain owner check**.

**NOT in scope (Phase B, separate later project):** migrating existing content
feeds (events/profile/sites) off the platform key. Do not touch `writeFeedPage`
callers. The `TODO(swarm-id)` seam in `feeds.ts` is for Phase B.

## Settled decisions (do not re-litigate)

- **Feed signer key = INDEPENDENT secret**, escrowed in the `RecoveryBundle`
  (`recovery-escrow.ts` already reserves the slot, lines 8–9, 56). NOT derived from
  the POD seed — that was a rejected deviation (see `CROSS_DEVICE_RECOVERY.md` §4).
  For Phase A the feed signer key need not even be exercised yet; just make sure the
  envelope payload format reserves room for `feedSignerPrivKey` so Phase B adds it
  as a content change, no crypto change.
- **Reuse existing audited crypto** (`recovery-escrow.ts`: HPKE/RFC-9180 + XChaCha20).
  Do NOT hand-roll an AEAD. The portability copy is the same `RecoveryBundle` with
  one extra HPKE recipient — a PRF-derived X25519 key.
- **Trust = on-chain, storage = Swarm.** The override is applied only if
  `Kernel(preservedKernelAddress)` currently has the live PRF-EOA as its ECDSA sudo
  owner. No new on-chain writes; verification is a gasless `eth_call`.

## bee-js v11 mechanism (verified this session)

```
CLIENT (no postage stamp needed to SIGN):
  soc = bee.makeSingleOwnerChunk(address, span, payload, identifier, clientFeedSigner)
        // builds + signs the SOC locally. Serialize its bytes to POST to server.
SERVER (holds the postage batch):
  bee.uploadChunk(POSTAGE_BATCH_ID, soc)   // stamps + uploads the pre-signed SOC
READ (any device, no stamp):
  reader = bee.makeSOCReader(ownerAddress); reader.download(identifier)
```

Use a **fixed identifier** for the envelope (e.g. `keccak256("woco/recovery/portability/v1")`)
so the SOC is overwrite-in-place (same owner+identifier) and discoverable without
feed-index logic. Owner = a PRF-derived secp256k1 address; payload = the sealed
`RecoveryBundle` (well under 4096 bytes). **Confirm the exact `makeSingleOwnerChunk`
arg shapes + how to serialize a `SingleOwnerChunk` to bytes for transport against
the installed bee-js** before wiring — the API surface is in
`node_modules/@ethersphere/bee-js/dist/types/*.d.ts`.

## Etherna compatibility (READ BEFORE BUILDING)

Current routing (verified in `apps/server/src/config/swarm.ts`): **main-app feeds —
events/profile/claims AND the existing recovery escrow — use OUR own Bee** via
`getBee()` / `requirePostageBatch()`. **Etherna** (`getEthernaBee()` in
`lib/etherna/upload.ts` + the Etherna postage batch) is used **only for per-deploy
site content.** So the recovery envelope rides our own Bee → **no immediate Etherna
blocker for Phase A.** Do NOT route the envelope through Etherna in Phase A.

But design it **Etherna-safe** so the eventual "everything on Etherna" end-state
doesn't require a rewrite. Etherna's Beehive fork has two traps (see
`project_etherna_legacy_soc`, `project_etherna_integration` memories; the old
`ETHERNA_INTEGRATION.md` was deleted — facts live in memory):

- **WRITE — inline SOC payload ONLY.** Beehive removed the legacy-SOC-resolve path:
  a SOC whose payload is a *reference* to another chunk (`uploadReference`) won't
  resolve; a SOC whose payload **is the data inline** works. So
  `makeSingleOwnerChunk(...)` MUST carry the sealed bundle bytes **directly** as
  payload (≤4096 — ours is). **Never** use the ref-style SOC for the envelope.
- **READ — never via `/feeds/{owner}/{topic}`.** That endpoint is **always 401 on
  Etherna** (no anonymous path). Resolve the envelope by **computing the SOC chunk
  address** (`calculateSingleOwnerChunkAddress(identifier, ownerAddress)`) and
  fetching the chunk (`/chunks` / `/bytes`), not via a feed reader. This also works
  on our own Bee, so use this read shape on BOTH targets. On Etherna the chunk must
  be **"offered"** for anonymous reads to succeed.
- **onRequest header bug:** bee-js@11 `BeeOptions.onRequest` shallow-copies headers
  (`swarm.ts` pattern is broken); if the envelope ever needs Etherna auth headers,
  use the nested-axios interceptor workaround (`project_etherna_integration` #1).

**GATE before EVER routing the envelope to Etherna (not needed for Phase A):**
extend `apps/server/scripts/etherna-soc-legacy-probe.ts` to (1) write an INLINE SOC
to Etherna with the Etherna batch, (2) read it back **anonymously by computed chunk
address**. Both must pass. Only then make the envelope target-aware.

## Build steps

1. **Server: generic client-SOC upload endpoint.** New route, authenticated (same
   session-delegation middleware as other writes), e.g.
   `POST /api/swarm/soc` accepting `{ owner, identifier, signature, payload, span }`
   (or the serialized signed chunk), reconstructing the `SingleOwnerChunk` and
   calling `uploadChunk(requirePostageBatch(), soc)`. Server validates the SOC's
   signature/owner before stamping (don't stamp arbitrary bytes for arbitrary
   owners — bind the allowed owner to the authenticated identity OR accept that any
   authed user may stamp their own SOC; document the chosen rule). Reuse
   `beeUploadSem` / `withTimeout` from `upload-queue.ts`.
2. **Client: SOC write helper.** `apps/web/src/lib/swarm/client-soc.ts` —
   `signAndUploadSoc({ signer, identifier, payload })`: `makeSingleOwnerChunk(...)`
   → POST to the endpoint above via `authPost`. Plus `readSoc(ownerAddress, identifier)`
   for reads (can hit Bee/gateway directly, no auth).
3. **Client: PRF-derived keys.** In a new `apps/web/src/lib/auth/recovery-portability.ts`:
   derive, from the PRF output (domain-separated, per the
   `deriveGuardianEncryptionKeypair` / `pod-identity.ts` fixed-nonce pattern):
   (a) SOC-owner secp256k1 key, (b) an X25519 HPKE recipient keypair. Distinct
   domains so neither reveals the other.
4. **Client: seal + write envelope.** Extend `recovery-escrow.ts` (or a thin
   wrapper) to seal the `RecoveryBundle` to BOTH the guardian recipients AND the
   PRF-derived X25519 recipient (multi-recipient — `sealRecoveryBundle` already
   loops `guardianPublicKeysHex`; just pass the extra pubkey). Write the sealed
   bundle as the fixed-identifier SOC via step 2. Carry `preservedKernelAddress`
   alongside (or inside the bundle).
5. **Wire into recovery + login** (`auth-store.svelte.ts`):
   - In `recoverAndRekey` (after `:955`): also write the portability envelope.
   - Add a **back-fill**: on `loginPasskey`, if a local `RECOVERED_KERNEL_BINDING`
     exists but no envelope, write one (covers Account #2, already recovered before
     this shipped).
   - In `loginPasskey` / `_ensureKernel` when there is NO local binding: read the
     envelope by PRF-derived owner → HPKE-open with the PRF-derived key →
     **on-chain verify** `Kernel(addr).owner == PRF-EOA` → if OK, `storePodSeed` +
     write `RECOVERED_KERNEL_BINDING` + apply the address override; if not, leave
     normal login (non-recovered accounts have no envelope — that's fine).
6. **On-chain owner read helper** (`kernel-account.ts`): read the deployed Kernel's
   current ECDSA sudo owner (the ECDSA validator singleton stores owner per account;
   `getValidatorAddress` gives the validator — confirm the view/storage read against
   `@zerodev/ecdsa-validator`). Gasless `eth_call`. Returns lowercased address or null
   (undeployed).

## Test plan

- Unit: PRF→keys determinism; multi-recipient seal opens with BOTH guardian and
  PRF-derived keys; on-chain owner read returns expected/null.
- Manual (the real proof, mirrors `RECOVERY_VERIFICATION_CHECKLIST.md`): recover a
  throwaway passkey on device A → log in with the SAME passkey on device B →
  **same address shown, tickets/dashboard decrypt**. Then non-recovered passkey on
  two devices still works; web3/web3auth unaffected.
- Typecheck: `npx svelte-check --workspace apps/web --threshold error` (ignore the
  2 pre-existing `esrap`/`@typescript-eslint/types` node_modules errors) +
  `npm run build:server`.

## Security review gate
Funds-adjacent (passkey accounts hold funds). Before advertising cross-device
recovery: confirm (1) no hand-rolled AEAD, (2) the on-chain owner check truly gates
the override, (3) the SOC endpoint can't be used to stamp SOCs for owners other than
the caller's own derived keys (or that doing so is harmless), (4) envelope rollback
(serving an old SOC) can't downgrade to a wrong address — the on-chain check should
catch it; add a version/counter if a multi-recovery rollback is a concern.

**Review result (2026-06-21, Opus): no HIGH/MED findings.** All four gate items hold.
Two follow-ups, both for the Phase B chat (neither blocks the verified Phase A):

🟡 **PRIVACY TODO — do FIRST in Phase B (small, ~2 files, no algorithm change).**
`preservedKernelAddress` is **cleartext** in the portability SOC payload, so anyone
who reads the chunk can link the PRF-derived `socOwnerAddress` pseudonym to the user's
real Kernel account. Fix WITHOUT touching the audited HPKE/XChaCha algorithm:
  - Pass `socOwnerAddress` (not the real Kernel) as the envelope's AAD context — the
    PRF-derived HPKE recipient key already binds the account, so anti-transplant holds.
  - Move `preservedKernelAddress` INSIDE the sealed bundle (`secrets.preservedKernelAddress`);
    read it back post-decrypt. `PortabilityEnvelope` cleartext → `{ v, envelope }`.
  - Touches `packages/shared/src/swarm/soc.ts` (type) + `recovery-portability.ts`
    (seal/read). Version-bump the envelope; the back-fill rewrites the old one on next
    login (no real users → no migration). Costs ONE cross-device re-test.
  Why before Phase B: Phase B reuses this SOC+envelope machinery for PUBLIC content
  feeds — fix the link-leak pattern before it propagates into the content layer.
  (zk is NOT the right tool here — a symmetric seal + the already-unlinkable
  `socOwnerAddress` close it. Reserve zk for prove-without-reveal: PoH anti-abuse,
  selective POD disclosure, a future private per-account SOC-write gate.)

⚪ **HARDENING — per-account postage write cap on `POST /api/swarm/soc`.** Any authed
user can have arbitrary self-signed SOCs stamped (bounded only by postage cost +
auth). Not a vuln (no owner-spoofing, no feed poisoning — platform feeds need
FEED_PRIVATE_KEY), but add a per-session/per-account write cap before public launch.

---

## COPY-PASTE KICKOFF PROMPT FOR THE FRESH CHAT

> Build Phase A from `docs/CLIENT_FEED_SIGNER_HANDOVER.md` in the woco_app repo: a
> client-owned SOC write capability (client signs via bee-js
> `makeSingleOwnerChunk`, server stamps+uploads via `uploadChunk`) and a PRF-sealed
> recovery portability envelope on top of it, so a recovered passkey works on a
> second device. Read that handover doc plus `docs/CROSS_DEVICE_RECOVERY.md`,
> `docs/EMAIL_WEB3AUTH_LOGIN.md`, and the AUTH+SWARM sections of `CLAUDE.md` first.
> Honour the settled decisions (independent feed-signer key in the escrow bundle —
> NOT POD-derived; reuse the existing HPKE/XChaCha crypto in `recovery-escrow.ts`,
> no hand-rolled AEAD; trust via on-chain Kernel-owner check). Do NOT migrate
> existing content feeds (that's Phase B). Confirm the exact bee-js v11
> `makeSingleOwnerChunk` / `SingleOwnerChunk` serialization against the installed
> package before wiring. Heed the "Etherna compatibility" section: Phase A stays on
> our own Bee (`getBee`), but build the envelope Etherna-safe — inline SOC payload
> only, read by computed chunk address (never `/feeds/{owner}/{topic}`). Start by
> proposing a short plan, then build incrementally with typecheck after each step;
> I (the owner) run the manual cross-device browser test and push.
