# Handover — client-owned feeds across all auth kinds (+ profiles & sites)

**Created:** 2026-06-30. Branch: `feat/feed-signer-recovery`.
Read this whole file first. Facts below are **verified against the code** (file:line
cited) — do NOT re-derive them; that is what burns tokens. Working style: crypto-expert
posture (verify keys/addresses, preserve raw signed bytes, reuse audited HPKE/XChaCha,
never hand-roll); small revertable commits; comments = WHY only.

Read alongside: `LAUNCH_PLAN.md` (owns ORDER), `FEED_SIGNER_ESCROW_HANDOVER.md`
(the escrow decision + surface), `CLIENT_FEED_SIGNER_HANDOVER.md` (Phase B locked design),
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
| passkey (PRF) | ✅ derived, working | cross-device (rotated credential → divergent key) needs escrow |
| web3auth (email) | ⚠️ derives, but key only in memory AFTER a fresh login; null on cold restore | cold-restore handling + escrow |
| local | ✅ works | — |
| web3 wallet | ❌ `_getContentFeedRootKey` returns null → platform-signed fallback | no raw key — needs a key SOURCE |
| coinbase smart wallet (CSW) | ❌ returns null → platform-signed | hardest — see "Parked" |

`_getContentFeedSigner` (`auth-store.svelte.ts:193-226`): prefers a STORED feed-signer key
(`feed-signer-store.ts`) if present, else seeds it from the legacy derivation and persists.
Today there is no escrow → the stored key is device-local only.

**Escrow is the foundation and is NOT wired yet** (`FEED_SIGNER_ESCROW_HANDOVER.md`):
`recovery-escrow.ts` escrows `{ podSeed }` ONLY; the `feedSignerPrivKey` slot is reserved
but empty. `recovery-portability.ts` carries `feedSignerPrivKey?` as a pass-through that
nothing populates on build and the signing path never reads back (lines 97,99,108,136,178).
External wallets (web3, CSW) CANNOT derive a feed key deterministically → they MUST use a
random key + escrow. **That is why escrow comes first.**

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
- **Chat A — Escrow foundation (DO NEXT).** Make the one decision in
  `FEED_SIGNER_ESCROW_HANDOVER.md` §"one decision": (A) keep deriving + escrow the derived
  key (low blast radius, closest to current code) vs (B) independent random key + escrow
  (matches design docs; REQUIRED for external wallets; changes every existing user's feed
  ADDRESS → migration risk, flag loudly). Then wire `feedSignerPrivKey` into the sealed
  bundle (`recovery-escrow.ts`), populate/return it (`recovery-portability.ts`), and make
  `_getContentFeedSigner` prefer the escrowed key. Reuses existing recovery endpoints (no
  new server crypto). Verify cross-device per `RECOVERY_VERIFICATION_CHECKLIST.md`.
  Recommendation: lean (B) for new accounts since external wallets need it anyway, but
  confirm with user — (A) is safer if root keys are reliably portable.
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
