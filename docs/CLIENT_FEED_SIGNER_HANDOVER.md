# Client-Side Feed Signer + Cross-Device Recovery — Build Handover

> SEQUENCING: see `docs/LAUNCH_PLAN.md` for the merged, ordered launch to-do. The
> "Security review gate" 🟡 privacy fix is step 0 (do first). Phase B Task 2 (below) is
> step 2 and MUST run AFTER email-Kernelize (`docs/EMAIL_KERNELIZE_PLAN.md`) — the
> identity flip changes the web3auth parent address, and Phase B must define the
> web3auth user's feed-signer source (recommended: derived from the Web3Auth key).

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

## PHASE B — client-owned content feeds (architecture LOCKED 2026-06-21)

**STATUS — EVENTS step BUILT 2026-06-22** (typecheck-green; NOT deployed/LIVE-tested —
owner runs frontend deploy + browser test). Commits f0e6ed9→90f5028. What shipped:
- Event detail feed (`woco/event/{id}`) is now a CLIENT-signed SOC owned by the user's
  content-feed signer; server stamps only (skips the platform write, returns the feed
  in the create stream `done`). `creatorFeedSigner` stamped into global+creator directory
  entries (carrier). Shared `eventContentTopic(id)`.
- Reads: client reads the SOC **gateway-direct** (`readContentFeed`) via the carrier
  from the listing/cache; server `getEvent(id, signerHint?)` resolves the TRUSTED
  directory carrier for internal/claim reads; legacy platform read = fallback.
- Updates: server NEVER writes the user's feed — the owner re-signs the SOC for
  onChainEventId (PublishButton, once after all paid series) and sub-ENS label.
- Size: content feeds are MULTI-CHUNK (commit 88b6b81) — a feed >4096 bytes pages
  across SOCs (`topic/p1…/pN` + a tiny `{_woco_mc,pages,len}` base manifest); small
  feeds stay a single raw-JSON SOC. No size ceiling, inline-only (Etherna-safe). Built
  into shared writeContentFeed/readContentFeed + server readContentFeedJson → profiles
  + sites inherit it. Page split/reassemble verified by a throwaway round-trip test
  (boundaries 4096/4097, up to 50 KB/13 pages, missing-page⇒null) — all pass.
- TEST (dev, no deploy): `npm run dev:server` (tunnels to Hetzner bee) + `npm run dev:web`,
  log in with a LOCAL browser account or PASSKEY (NOT web3auth=localhost-blocked, NOT
  web3/coinbase=platform-signed fallback), publish a LISTED event. Confirm: Network shows
  POST /api/swarm/soc after create; event read hits the gateway not /api/events/:id;
  `curl /api/events` entry has `creatorFeedSigner`. Dev writes hit PROD feeds — unlist after.
- **Owner guardrails (load-bearing):** server = upload/stamp ONLY; it does NOT sign
  user feeds or on-chain txns (card buyers use a client burner). Claim/payment reads
  use the TRUSTED directory carrier, never a client hint → `skipAutoList` events stay
  platform-signed until the sites step gives them a trusted carrier.
- NEXT: profiles → sites (sites must carry the signer in the server-written
  SiteEventsIndex so site/skipAutoList events get a trusted carrier).

Owner intent: **the user owns every content feed with their own signer**; the
platform only lends postage. Decisions (CTO call):

- **Ownership = WRITE-time.** Content feeds become client-signed fixed-identifier
  SOCs: the CLIENT signs (→ SOC owner = the user's content-feed-signer address), the
  SERVER only stamps+uploads via the platform batch (reuses Phase A `/api/swarm/soc`).
  No added latency (signing is local). The server/gateway *relaying* a user-signed
  chunk does NOT dilute ownership (anyone can verify the sig). Stamp step is a
  swappable transport → per-user batches / browser-Bee drop the server from writes
  later with zero change to signing.
- **Feed-signer key** = derived from the root login secret under its OWN domain
  `CONTENT_FEED_SIGNER_DOMAIN` ("woco/feed-signer/v1"), independent of POD + funds.
  web3auth: from the Web3Auth key; passkey: from PRF; local: from the local key.
  web3/coinbase (external wallet, no raw key) → no client feed signer (platform-signed
  fallback). Recovery = re-derive on re-login, no escrow. The parent (Kernel) can NEVER
  own a SOC (contract address, no secp256k1 key that ecrecovers to it) — and Swarm
  warns against signing feeds with a funds key anyway, so this is correct, not a
  workaround. BUILT (kept): shared `CONTENT_FEED_SIGNER_DOMAIN` + `contentFeedSocIdentifier`;
  client `lib/swarm/content-feed.ts` (`deriveContentFeedSigner` / `writeContentFeed` /
  `readContentFeed`); `auth.getContentFeedSigner()` in auth-store.
- **Discovery = CARRIER-BASED, no global registry (decided — registry REVERTED).**
  Reading SOMEONE ELSE's feed needs their secret-derived signer address. Instead of a
  global `parent→signer` table (more linkable + a privacy leak: it correlates every
  user's on-chain identity ↔ all their content), carry the owner's feed-signer address
  INSIDE the data that references them — **stamp it into the events/directory/site
  entries** at publish time. Reader who sees an event already has the organiser's
  signer. SELF-reads need no lookup (app derives its own signer). Carrier-based leaks
  least (signer revealed only alongside content the user chose to publish).
  - **Residual:** profile-by-raw-address with no carrier (e.g. a follower-list avatar).
    Defer — stamp signer into the follow record when that screen exists, or small
    fallback. NOT a launch blocker.
  - **v1 (later, deliberate):** optional GASLESS on-chain binding (Kernel users have the
    ZeroDev paymaster → no user gas) as a sub-ENS text record / EAS attestation, bolted
    onto the existing identity tx, for public identities only, once GSOC / independent
    discovery makes the permanence worth it. Discovery stays ONE swappable function.
- **Reads** stay server-mediated for now (JSON via `/api/...`, exactly as today) —
  gateway-direct buys ~nothing while we run the gateway; flip later in one function.
- **Stays platform-signed:** global event directory chunk + all claim-path feeds
  (editions/claims/claimers/pending/collection — written server-side for ABSENT
  claimers). `project_event_directory_scaling`. Etherna = sites + event PAGES (GET+POST);
  profile/data stays on our own Bee; SOC-by-computed-address read shape is Etherna-safe.
- **Abuse bound** = `/api/swarm/soc` authz as-is (any authed user, valid sig — can't
  poison another owner's feed; can't write platform feeds) + ⚪ per-account postage
  write cap (launch hardening).

Build order: **events/merchant directory FIRST** (stamp creator's content-feed-signer
address into directory/event entries; organiser signs their own event/profile feed,
server stamps; readers pick up the signer from the carrier) → profiles → sites.

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
