# Web3Auth client feed-signer — handover (next phase)

**Opened 2026-07-01 (Opus).** Continues the client-owned content-feeds headline
(`project_client_feeds_per_kind_settled`). The recovery-escrow de-platforming
(PLAN §13, commit `77e1666`) is a completed side-branch — this is the return to
the actual goal.

## Goal
Client-side content-feed signers for **web3auth (email) users**, robust across
cold devices. Web3 wallet users are DONE (sign-to-derive, `81dd060`); web3auth is
the last login kind on the critical path for launch.

## What's already true (read the code, don't assume)
- `apps/web/src/lib/auth/auth-store.svelte.ts` `_getContentFeedSigner()`:
  1. **stored key wins** — `restoreContentFeedSigner(parent)` (device-local
     AES-GCM blob, `feed-signer-store.ts`).
  2. **web3** — sign-to-derive + persist (`_deriveWeb3FeedSigner`). web3auth is
     NOT web3, so it skips this.
  3. **fallback** — `deriveContentFeedSigner(root)` = `keccak256(DOMAIN‖rootKey)`,
     then persist. For web3auth `root = _web3authPrivateKey` (loaded at session
     restore, line ~637).
- So web3auth's feed signer is **re-derived from the Web3Auth raw key**. That key
  is the SAME across devices by Web3Auth's design (PnP reconstructs one secp256k1
  key: `eth_private_key`) → the derivation is cross-device reproducible IN THEORY.

## The gap to close (confirm against code first — like we did for §13)
1. **Cold-restore not browser-verified.** The "same Web3Auth login → same key →
   same derived feed signer on a fresh device" chain is true BY DESIGN but never
   confirmed live (same open item that blocked the Web3Auth go-live; hCaptcha
   blocks localhost → must test on a real https host). Until verified, a cold
   web3auth device could silently derive a DIVERGENT signer and orphan feeds.
2. **No escrow/restore path for web3auth.** Only passkey has escrow (guardian
   recovery) + PRF-portability. web3auth relies purely on re-derivation, so it
   **cannot** move to the stated end-state (random INDEPENDENT feed key) without a
   restore channel, and it diverges if Web3Auth ever repoints (network/clientId —
   a `FEED_PRIVATE_KEY`-class config, see §2026-06-20c warning in PLAN).

## The decision for the fresh Opus chat (DESIGN = expert call, don't hand to Sonnet)
Re-confirm the two gaps against the code, then choose + justify the fix shape:
- **(A)** Bless re-derivation as sufficient for launch (determinism proven live) —
  cheapest; leaves web3auth on a derived (not independent) key.
- **(B)** Give web3auth the same escrow/restore channel as passkey so the feed key
  is a stored+recovered secret (enables the independent-key end-state, survives
  Web3Auth repoint). Bigger, but aligns web3auth with the per-kind invariant.
Recommend one; the honest tie-break is whether launch needs the independent-key
end-state now or can ship on derivation + a verified-determinism gate.

## Invariants — DO NOT reopen (settled)
- Content is ALWAYS client-signed; platform = directory-only. Escrow the minimum.
  Fail-loud, never silently degrade to a platform signer.
- Per-kind mechanism is FORCED by "can the credential reproduce the key itself":
  web3=sign-to-derive, passkey=escrow, web3auth=re-derive, local=derive, CSW=parked.
- Web3Auth = **PnP not MPC Core Kit** (raw key → viem owns RFC6979 determinism).
- Postage is a separate axis: client-SIGNED ≠ client-UPLOADED (per-user batch =
  `project_etherna_batch_registry`, out of scope here).

## Verification gate (funds/identity-adjacent)
Live https browser test: web3auth login on device A → write a content feed →
COLD device B (clear IndexedDB) → same login → confirm the SAME feed-signer
address resolves and B reads/writes the same feeds. This is the linchpin, same
class as the recovery browser test.

## Opus → Sonnet split
Opus locks the design + the crypto seam (derivation vs escrow, determinism proof)
and gets it typecheck-green. Once the mechanism is settled, the UI/plumbing
rollout across surfaces is Sonnet-able — the fresh chat will flag that point.

## Pointers
- Code: `auth-store.svelte.ts` (`_getContentFeedSigner`, `_getContentFeedRootKey`,
  web3auth restore branch), `swarm/content-feed.ts`, `auth/feed-signer-store.ts`.
- Context: `docs/CLIENT_FEEDS_AUTH_KINDS_HANDOVER.md`, `docs/EMAIL_WEB3AUTH_LOGIN.md`,
  memories `project_client_feeds_per_kind_settled`, `project_auth_provider_decision`,
  `project_web3auth_v10_gotchas`, `project_phase_b_carrier_discovery`.
