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
| local | ✅ works | — |
| web3 wallet | ❌ `_getContentFeedRootKey` returns null → platform-signed fallback | no raw key — needs a key SOURCE (Chat B) |
| coinbase smart wallet (CSW) | ❌ returns null → platform-signed | hardest — see "Parked" |

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
- **Chat B — web3auth + web3 wallet** (AFTER email-Kernelize live-verify). web3auth: derive
  `feedSignerPrivKey` from the Web3Auth key under its OWN domain + fix cold-restore (key
  absent until next login). web3 wallet: `personal_sign` is deterministic → sign-to-derive a
  feed key from one fixed message, then escrow it (reuses Chat A). Grouped — both yield a
  derivable key.
- **Chat C — Coinbase Smart Wallet** (PARKED → post-launch). Random key + non-deterministic-
  safe escrow unlock.
- **Chat D — Profiles + sites end-to-end audit.** Confirm profile-publish + site-deploy
  paths actually client-SIGN across all wired kinds (not just read `.address`); wire the
  discovery carrier (signer address stamped into profile/site directory entries, mirroring
  events). Likely mostly working via the shared chokepoint — closes gaps.

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
