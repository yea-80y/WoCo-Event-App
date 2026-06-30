# Handover — client-owned feeds across all auth kinds (+ profiles & sites)

**Created:** 2026-06-30. Branch: `feat/feed-signer-recovery`.
Read this whole file first. Facts below are **verified against the code** (file:line
cited) — do NOT re-derive them; that is what burns tokens. Working style: crypto-expert
posture (verify keys/addresses, preserve raw signed bytes, reuse audited HPKE/XChaCha,
never hand-roll); small revertable commits; comments = WHY only.

Read alongside: `LAUNCH_PLAN.md` (owns ORDER), `CLIENT_FEED_SIGNER_HANDOVER.md` (Phase B locked design),
`EMAIL_KERNELIZE_PLAN.md`. Memory: `project_phase_b_carrier_discovery`,
`project_signing_role_architecture`, `project_passkey_recovery`, `project_auth_provider_decision`.

---

## Where we are (verified 2026-06-30)

Client-owned content feeds work by having the CLIENT sign content as fixed-id SOCs; the
server only stamps/relays (never holds the key). **Everything funnels through ONE function:**
`auth.getContentFeedSigner()` — `apps/web/src/lib/auth/auth-store.svelte.ts:193`.
Events publish (`creator/events/PublishButton.svelte:186`), profiles
(`api/profiles.ts:118,173`), and the site builder (`creator/SiteBuilder.svelte:179`) all
call it. So **profiles & sites are NOT a separate signing problem** — when
`getContentFeedSigner()` returns a valid signer for an auth kind, that kind's events +
profiles + sites all light up together. Remaining profile/site work is mostly an AUDIT
that their publish/deploy paths actually SIGN (not just read `.address`) + carrier discovery.

Per-auth-kind state — `_getContentFeedRootKey` (`auth-store.svelte.ts:179`):

| Auth kind | Feed signer today | Gap |
|---|---|---|
| passkey (PRF) | ✅ derived + escrowed (cross-device done) | — |
| web3auth (email) | ⚠️ derives, but key only in memory AFTER a fresh login; null on cold restore | cold-restore handling (Chat B) |
| local | ✅ works (raw key → derive); NOT tied to agentic/x402 rails (those are Kernel-based) | product may drop local login (separate UI change) |
| web3 wallet | ✅ sign-to-derive (`81dd060`); deterministic-sig key, self-checked, no escrow | live verify (MetaMask, 2 devices) |
| coinbase smart wallet (CSW) | ❌ returns null → platform-signed | hardest — see "Parked" |

**Platform signer is now directory-only for every kind except CSW (parked).** The only
remaining platform-signs-CONTENT paths are (a) CSW and (b) web3auth COLD restore (key absent
until next login) — both tracked below. No kind silently degrades: web3 THROWS on a
non-deterministic wallet rather than orphaning a feed or platform-signing.

`_getContentFeedSigner` (`auth-store.svelte.ts:193-226`): prefers a STORED feed-signer key
(`feed-signer-store.ts`) if present, else seeds it from the legacy derivation and persists.
The stored key is escrowed, so it survives cross-device (see below).

**Escrow IS wired** (shipped `19c7e6d` + `f8a1a18`; audited 2026-06-30). The feed signer rides
the SAME audited envelope as the POD seed — a pure content addition, no new crypto:
- `recovery-escrow.ts` bundle is generic `secrets: Record<string,string>`; the guardian
  ceremony seals `feedSignerPrivKey` alongside `podSeed` and the determinism self-check
  asserts it round-trips (`auth-store.svelte.ts:1099-1101,1116`); recovery restores it under
  the preserved parent (`:1262-1264`).
- `recovery-portability.ts` populates `feedSignerPrivKey` on build (`:108`) and returns it on
  restore (`:178`); the new-device login path stores it under the preserved parent
  (`auth-store.svelte.ts:846-848`), gated by the on-chain owner check (`:352-357`).
- `_getContentFeedSigner` prefers the stored/escrowed key over re-deriving (`:200-208`), so a
  rotated passkey credential cannot orphan the user's feeds.

This (A) "derive-then-escrow" design covers the kinds that hold a raw root key (passkey,
web3auth, local). External wallets (web3, CSW) have no derivable root → Chat B/C must give
them a key SOURCE (web3: sign-to-derive; CSW: random key + escrow). That is the remaining work.

## Decisions taken this session
- **Coinbase Smart Wallet client-feeds = PARKED to post-launch.** Rationale: CSW
  signatures are non-deterministic (ERC-1271/6492) so you can neither derive a feed key
  nor derive the escrow-unlock guardian from a CSW sig — it needs its own random-key +
  non-deterministic-safe escrow-unlock design (significant work). No crypto payments at
  launch, so CSW isn't on the critical path. CSW users get platform-signed feeds until then.
- Reservation timer behaviour (TTL preserved on same-qty reopen; fresh on qty change; no
  stacking — verified `reservation-store.ts:231-282`) is **intentional and correct**; KEEP.
  Matches mainstream (Ticketmaster/Eventbrite hold-with-TTL, not refresh-extendable).
- The ticket-remaining double-subtraction bug is FIXED + committed (`e894961`) + deployed.

## Ordering constraint (do NOT reorder — from LAUNCH_PLAN.md)
Identity flips that change the PARENT address (email-Kernelize: web3auth EOA → Kernel addr)
must land BEFORE any feed-signer migration, because profile/site feed TOPICS embed the
parent address. Flip identity once, then flip signer once, all inside the "no real users
yet" window. email-Kernelize P1-P3 are built + typecheck-green but need a frontend deploy
+ LIVE verify (Web3Auth fails on localhost — hCaptcha). So web3auth feed-signer work
(Chat B) comes AFTER email-Kernelize is live-verified.

## Plan — chat-by-chat (each = one testable/deployable milestone)
- **Chat A — Escrow foundation (DONE — shipped `19c7e6d` + `f8a1a18`, audited 2026-06-30).**
  Decision taken = (A) derive-then-escrow (low blast radius, no existing feed ADDRESS
  changes). `feedSignerPrivKey` is sealed in the guardian bundle, carried in the portability
  envelope, and `_getContentFeedSigner` prefers the escrowed key over re-deriving — so a
  rotated passkey credential cannot orphan feeds. Reuses the existing recovery endpoints (no
  new server crypto). Covers passkey/web3auth/local; external wallets are Chat B/C. Security
  audit + the precise wiring sites are in the "Escrow IS wired" section above. STILL OWED:
  the LIVE cross-device run per `RECOVERY_VERIFICATION_CHECKLIST.md` (throwaway passkey +
  MetaMask backup; only the user can do this in a real browser).
- **Chat B(i) — web3 wallet — DONE (`81dd060`).** sign-to-derive from a deterministic EIP-712
  sig under `FEED_SIGNER_DERIVE_DOMAIN`, determinism self-check (non-det wallet THROWS, no
  degrade/platform-sign), no escrow (re-sign to recover). `_deriveWeb3FeedSigner` +
  `deriveContentFeedSignerFromSig`. OWES: live verify (MetaMask, publish from 2 devices →
  same feed-signer address).
- **Chat B(ii) — web3auth** (AFTER email-Kernelize live-verify — ordering: parent address
  flips first). Fix cold-restore: key absent until next login currently → null → platform.
  Make it re-load the key (re-login) not platform-sign. Opus.
- **Chat C — Coinbase Smart Wallet** (PARKED → post-launch). Random key + non-deterministic-
  safe escrow unlock (CSW sigs are 1271/6492 → can't sign-to-derive).
- **Chat D — Profiles + sites end-to-end audit.** Confirm profile-publish + site-deploy paths
  actually client-SIGN across all wired kinds (not just read `.address`); wire the discovery
  carrier (signer address in profile/site directory entries, mirroring events). Mostly working
  via the shared chokepoint. **Sonnet-suitable** (mechanical verification once contracts set).

## From the security review (Sonnet) — triaged, mostly post-launch
- **keccak256-as-KDF → HKDF-SHA256.** Valid LOW-severity formal-audit flag. Nuance: keccak
  (SHA-3) is NOT length-extension-weak and inputs are uniformly random, so it's a sound
  one-block KDF — but it's used across POD seed + feed signer + portability + guardian seed,
  so switching is a BREAKING migration of every derived key. ⇒ **decide BEFORE launch**:
  migrate once now (free, pre-users; funds-adjacent — handle as its own carefully-verified
  Opus chat) or document the rationale. Lean: migrate now.
- **Feed-signer rotation.** AGREE rotation needs a story; DISAGREE with EAS-checked-on-every-
  read (puts an L2 read on the fast gateway path + a chain dep on reads). Primary mechanism =
  re-stamp the carrier directory/event entry (free, immediate); the `FEED_SIGNER_DERIVE_NONCE`
  v-bump is the re-key lever. Residual (reader holding only the OLD signer): a parent
  (Kernel)-authorized rotation record — a Kernel-signed SOC OR EAS — consulted LAZILY at
  rotation/compromise, not per read. **Post-launch.** Opus design.
- **Content manifest.** AGREE, low-risk + useful: local ledger `{topic,contentHash,label,ts,
  signerAddress}` per publish + an encrypted backup sealed to the POD key (reuses
  `deriveEncryptionKeypairFromPodSeed`). Lets a user re-publish after rotation/compromise.
  **Post-launch.** Opus sets the seal contract; **Sonnet** builds the viewer UI.
- **1-of-1 guardian SPOF.** AGREE — most user-impactful. Cheap now: a **Sonnet** UX warning at
  guardian setup ("this single backup is your only recovery path"). M-of-N envelope (already
  anticipated — DEK indirection makes it a content change) = post-launch Opus.

## Deploy notes
- Feed-signer work is mostly FRONTEND crypto → owner runs `npm run deploy` (Swarm) + dev via
  `npm run dev` (HMR against prod API). NEVER test Web3Auth on localhost.
- Server changes: CLAUDE.md STEP 1 (rsync + `docker compose up -d --build --force-recreate
  server`; `--force-recreate` matters). Verify `curl https://events-api.woco-net.com/api/health`.
- Two FRONTEND bundles bake site pages — both are read-only volume mounts on the VM:
  - `dist-multisite` → multi-page builder sites (`routes/sites.ts`, STEP 1b).
  - `dist-site` → SINGLE-event sites (`routes/site.ts`). Rebuild with `npm run build:site`
    + rsync `apps/web/dist-site/` → `/opt/woco/repo/apps/web/dist-site/`. ⚠️ Easy to forget
    — the 2026-06-30 ticket bug LOOKED unfixed because only dist-multisite was rebuilt.
  Both are baked into each published site AT PUBLISH TIME → organisers must RE-PUBLISH /
  create a new event to pick up a new bundle. Already-deployed gateway URLs stay frozen.

## State of the tree
- `e894961` ticket-remaining fix — committed, server deployed, dist-site + dist-multisite
  rebuilt + synced. Owner still owes `npm run deploy` for the in-app event page.
- Other untracked docs in `docs/` are prior-session handovers (context only).
