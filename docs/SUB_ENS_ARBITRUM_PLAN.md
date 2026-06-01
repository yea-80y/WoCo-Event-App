# Sub-ENS on Arbitrum — Plan & Handover

**Status:** IN PROGRESS. Contracts done (2026-05-29). Next: Arb Sepolia deploy + ZeroDev + server routes.
**Primary owner:** nabil + Claude (tech-lead).
**Target ship date:** before Friday 2026-06-13 (buildathon submission).

> **Skip to current state:** "Wallet/AA architecture", "Architecture decisions", and "Build progress"
> sections near the bottom are authoritative. The original architecture sections below are kept for
> context but are **superseded** — gateway is NameStone-hosted (not self-hosted), contracts use
> the canonical factory (not a bespoke deploy), and ZeroDev replaces CSW as the wallet layer.

---

## Why we're doing this

The biggest competitive gap between WoCo and Skiddle / Ticketmaster / Luma for
non-technical organisers is **the URL**. They don't have a domain. They don't want
to buy one. Today we ask them to either bring `mybar.com` (see `CUSTOM_DOMAINS_PLAN.md`)
or live under a long Swarm hash on `gateway.woco-net.com`.

Sub-ENS closes that gap: every organiser gets a free `username.woco.eth` at signup,
their published site auto-resolves there via `.limo`, and the address lives on
Arbitrum (where the buildathon judges live).

Three pitch beats from one feature:
1. **Product** — free, permanent URL for every organiser, no domain registrar required.
2. **Arbitrum-native** — every subdomain mint is an Arbitrum tx; registry contract
   lives on Arb (qualifies for the "ecosystem usage" axis of the buildathon).
3. **ENS-native** — CCIP-Read wildcard resolution end-to-end; demonstrates ENS L2
   patterns working in production, not just a slide.

---

## Architecture (the trustless modern way)

**Mainnet (one-time):**
- `woco.eth` resolver → change from current contenthash-only resolver to a
  **wildcard resolver** that:
  - Returns the existing contenthash for apex `woco.eth` (no change to current site).
  - Implements ENSIP-10 wildcard resolution → CCIP-Read → Arbitrum L2 registry
    for `*.woco.eth`.
- Tooling: **NameStone Durin** ships this pair. Resolver is open-source
  (`OffchainResolver.sol`), audited, used by ENS Labs.

**Arbitrum (the live system):**
- Deploy `L2Registry.sol` (Durin's contract).
- Owner = WoCo platform multisig (eventually) / deployer EOA (buildathon).
- Mint: organiser calls (or platform sponsors) `register(label, owner, records)`.
  Each subdomain is a row in the registry. Owner can set text records
  (`avatar`, `description`, `contenthash`, etc.) per-subdomain.
- Cost: ~30k gas per mint on Arbitrum ≈ $0.0005. Free to organisers; platform
  sponsor pays.

**Gateway (CCIP-Read):**
- Mainnet resolver makes an HTTP call to a gateway URL when it sees a subdomain query.
- Gateway reads from the Arbitrum L2 registry and returns the answer + a Merkle
  proof. Resolver verifies the proof on-chain.
- Two options:
  - **NameStone hosted gateway** — free tier; fastest path; lock-in concern.
  - **Self-hosted gateway** — Cloudflare Worker or a small Hono route on
    `apps/server`; pulls from the L2 registry RPC and proves the read.
    Marginal effort (~0.5 day extra); zero ongoing cost; aligns with WoCo's
    "no third-party gatekeepers" posture.

**Recommendation:** self-host the gateway. Same RPC pattern we already use for
the events contract, no new infra concept, no NameStone dependency for live users.

**End-user flow:**
```
Organiser signs up → picks "punkpub" → server sponsors registry tx on Arb
  → registry row written → text record "contenthash" set to deployed site hash
  → user visits punkpub.woco.eth.limo
  → .limo asks mainnet resolver for contenthash of punkpub.woco.eth
  → resolver detects subdomain → CCIP-Read to our gateway
  → gateway returns contenthash from Arb registry + proof
  → resolver verifies proof, returns hash to .limo
  → .limo fetches Swarm content, serves to user
```

---

## Integration points in our codebase

### Contracts (new)
```
contracts/src/SubENSRegistry.sol         (Durin's L2Registry, vendored)
contracts/script/DeploySubENSRegistry.s.sol
contracts/test/SubENSRegistry.t.sol
```

### Server (new)
```
apps/server/src/routes/sub-ens.ts            POST /api/sub-ens/claim     (mint label for caller)
                                             GET  /api/sub-ens/check/:label  (availability)
                                             POST /api/sub-ens/set-contenthash (on site redeploy)
apps/server/src/lib/chain/sub-ens-contract.ts  (ABI + reader + sponsor writer)
apps/server/src/lib/sub-ens/                   (validation, reserved-name list)
apps/server/src/routes/ens-gateway.ts          GET /api/ens-gateway/:sender/:data
                                              (CCIP-Read endpoint; reads registry, proves)
```

### Frontend (new)
```
apps/web/src/lib/components/builder/SubENSPicker.svelte
  — inline in site builder publish flow:
    "Your site will be live at: ___.woco.eth.limo"
    Availability check + claim button
apps/web/src/lib/api/sub-ens.ts
```

### Web hook into existing publish flow
```
apps/server/src/routes/sites.ts (deploy endpoint)
  After Swarm BZZ upload + feed write:
  if (site.subEnsLabel) {
    await setContentHash(site.subEnsLabel, contentHash);
  }
```

So every `npm run deploy`-equivalent automatically updates the on-chain
contenthash. Same automatic-feed-update pattern, just on Arbitrum instead of Swarm.

---

## Tasks + estimates

| # | Task | Effort | Blocker? |
|---|---|---|---|
| 1 | Vendor Durin's `L2Registry` + tests, deploy to Arbitrum Sepolia | 0.5 day | — |
| 2 | Deploy to Arbitrum One (after Sepolia smoke) | 0.25 day | needs #1 |
| 3 | Self-hosted CCIP-Read gateway route + proof generator | 1 day | — |
| 4 | Change `woco.eth` resolver on mainnet (one wallet tx) | 0.25 day | needs #3 deployed |
| 5 | Server `/api/sub-ens/*` routes + sponsor mint flow | 1 day | needs #1 |
| 6 | Frontend `SubENSPicker` in site builder | 0.5 day | needs #5 |
| 7 | Hook into deploy flow to auto-update contenthash | 0.25 day | needs #5 |
| 8 | Reserved-name + abuse list (woco, admin, support, etc.) | 0.25 day | — |
| 9 | E2E test: claim → deploy site → visit `label.woco.eth.limo` | 0.5 day | needs #4 + #7 |

**Total: ~4.5 days.** Achievable in one focused chat across 2 calendar days.

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Mainnet resolver change breaks `woco.eth.limo` for the existing site | Test on a throwaway `wocotest.eth` first; resolver MUST return apex contenthash unchanged before we switch |
| CCIP-Read gateway downtime = subdomain sites go dark | Cache contenthash at the Cloudflare edge with long TTL; on gateway 5xx, edge serves stale (subdomain sites are static) |
| Squatting (someone registers `bigband.woco.eth` before the real band signs up) | First version: gated behind WoCo signup, mints to the caller's account. Reserved-name list blocks common impersonations |
| Durin breaking-changes mid-buildathon | Vendor the contract, don't depend on an npm install pulling latest |
| Sub-ENS doesn't show in MetaMask / .limo for ~24h after first deploy | Test resolver migration on a Friday morning, not a Friday evening |

---

## Out of scope (explicit)

- **Selling sub-ENS as a paid product** — free tier only for the buildathon.
  Paid tier (`myband.woco.shop`, `.live`, etc.) is post-buildathon.
- **Custom TLDs** — `woco.eth` only; no `woco.gigs` or similar.
- **Multi-platform resolver** — only `.woco.eth`; bands using their own ENS keep
  using their own resolver (we don't take over).
- **NFT-wrapping subdomains** — Durin supports it, but we don't need transferable
  ownership in v1.
- **On-chain subdomain marketplace** — no buy/sell/auction.
- **Multi-chain resolution** — Arbitrum only. No Base mirror.

---

## What this UNLOCKS (post-buildathon)

- **Sub-ENS as the identity layer for WoCo Wallet** — `punkpub.woco.eth` is also
  the receive-address alias for USDC. "Pay 50 USDC to punkpub.woco.eth" works
  in any wallet that resolves ENS.
- **Profile records** — set `avatar`, `description`, `twitter`, `email` text
  records → user profiles become portable identities, not WoCo-locked rows.
- **Tier 2 paid namespaces** — `.shop`, `.gigs`, `.live` etc. Each is a new
  L2 registry; reuses 90% of this infra.
- **Per-event subdomain** — `summerfest25.punkpub.woco.eth` for one-off pages
  (Durin supports nested resolution).

---

## Open questions for the new chat

1. **Self-hosted vs NameStone gateway?** Plan recommends self-hosted; user to
   confirm before #3.
2. **Resolver swap window** — pick a low-traffic time. Suggest Sunday morning
   GMT, with rollback path documented.
3. **Should sub-ENS minting be gated** (must have published a site first) or
   open at signup? Plan assumes "at first site publish" to prevent squatters.
4. **Naming convention** — `punkpub.woco.eth` vs `punk-pub.woco.eth`? Decide
   character set + length limits in #8.

---

---

## Tier 1 reshuffle — confirmed 2026-05-28

User-confirmed decisions:
- **EAS (Ethereum Attestation Service)** for likes + ticket attendance. Same schema
  pattern handles `liked(venue/band/event)` and `attended(event)`. Gasless writes
  via paymaster. Reads aggregated by Stylus contract (see below).
- **One Stylus contract** = **EAS aggregator**. Reads attestations for a given
  subject from EAS, computes trending/ranking on-chain in Rust. Demo: "trending
  venues this week, computed on Arbitrum in Stylus for ~$0.0001 per query."
- **WoCoStore promoted ahead of Aave.** Store proves the "any business, any
  vertical" thesis. Stripe-only payment path for buildathon launch (mirrors the
  events contract pattern). Aave moves to Tier 2.
- **Crypto payments stay TESTNET-ONLY for the demo.** Arb Sepolia path enabled
  for buildathon walkthrough; `FEATURES.cryptoPaymentsAllowed=false` stays in
  production. Stripe is the real-money path everywhere.
- **User-bought .eth deferred** to post-buildathon (mainnet flows + registrar
  integration is real work).
- **Local testing is sufficient** for build phase — SSH tunnel (commit `fd918d7`)
  means `npm run dev:server` writes to the prod Hetzner Bee. Only push to prod
  for the actual buildathon submission demo.

### Tier 1 — must ship (target Fri 2026-06-13)

| # | Workstream | Effort | Status | Notes |
|---|---|---|---|---|
| 1 | Sub-ENS on Arbitrum | 4.5d | 🟡 In progress | Contracts done. Next: Arb Sepolia deploy + server routes + SubENSPicker. NameStone-hosted gateway (not self-hosted) |
| 1b | ZeroDev wallet — replace CSW with ZeroDev passkey + session keys | 1.5d | ⬜ Not started | Alongside sub-ENS. User main wallet (Kernel + passkey) + session keys for scoped txns. Platform sponsor wallet too. See "Wallet/AA architecture" |
| 2 | WoCoStore.sol minimal + Arb deploy | 3d | ⬜ Not started | `registerStore` / `addProduct` / `buyFor`. Stripe-only path |
| 3 | Store section types in MultiSiteBuilder + Stripe webhook → store | 3d | ⬜ Not started | Product grid + single product + cart drawer + checkout |
| 4 | EAS likes + attendance integration | 2d | ⬜ Not started | One schema, gasless via ZeroDev paymaster, like-button + dashboard count + door-scanner attestation. Keyed to sub-ENS identity |
| 5 | One Stylus contract — EAS aggregator | 2.5d | ⬜ Not started | Rust contract reads EAS, returns trending subjects. Benchmark slide in pitch. Reads by sub-ENS label |
| 6 | V1 Arbitrum event smoke-test | 0.25d | ✅ Done | V2 verified end-to-end on Arb Sepolia |
| 7 | Pitch deck + 2-min demo video + submission package | 2.5d | ⬜ Not started | The actual deliverable |

**Total: ~19.25 days** (17.75 + 1.5 for ZeroDev) in ~14 calendar days. Cut valve if needed: Stylus → testnet tx + benchmark slide only; EAS → like-button + count only (no door-scanner). Do NOT cut sub-ENS, ZeroDev, Store, or pitch.

### Sub-ENS = the identity layer (decided; ties #1, #4, #5 together)
The sub-ENS name is not just a URL — it is the organiser/user's **profile + social identity**,
all on Arbitrum using ecosystem tooling:
- **Identity / addressing** — `label.woco.eth` resolves the site (contenthash) AND is the
  USDC receive-alias. (Durin L2Registry, item #1.)
- **Profile records** — `avatar`, `description`, `url`, `com.twitter`, etc. stored as **ENS
  text records** on the same L2 registry row. The profile IS the ENS name's records — portable,
  not WoCo-locked. (Extends #1; no new contract.)
- **Likes + attendance** — **EAS attestations** (item #4) keyed to the sub-ENS identity as
  subject: `liked(venue/band/event)`, `attended(event)`. Gasless via paymaster.
- **Aggregation / trending** — **Stylus** contract (item #5) reads EAS attestations for a
  subject and computes ranking on-chain in Rust.
So the data model is: **sub-ENS name (text records) = profile; EAS = the social graph on top
of it; Stylus = the read/aggregation layer.** Three Arbitrum-ecosystem primitives, one identity.

### Wallet / AA architecture (locked 2026-05-29, after research)
- **Replace CSW with ZeroDev as the user passkey login.** ZeroDev passkey = pure WebAuthn
  (biometric only, no Coinbase account required) — cleaner UX for non-crypto users.
  ZeroDev owned by Offchain Labs (Arbitrum creators) = strongest possible ecosystem alignment.
- **Architecture — main account + session keys:**
  - ZeroDev Kernel (ERC-4337) = user's main WoCo wallet, passkey-controlled, holds bulk funds.
  - Session keys = scoped sub-account per WoCo session (only WoCo contracts, capped spend,
    time-limited). User never exposes main wallet to a dapp. Strong pitch feature.
  - Platform sponsor wallet also moves to ZeroDev Kernel + session keys (replaces raw EOA in
    `apps/server/src/lib/chain/sponsor-wallet.ts`).
  - ZeroDev paymaster sponsors gas for both user txs AND platform-sponsored ops
    (sub-ENS mints, EAS attestations).
- **Coinbase Pay (fiat onramp) NOT blocked.** Coinbase Pay is address-agnostic — it funds any
  wallet address. Wire it to the ZeroDev Kernel address when we build the onramp (Tier 3).
  No CSW required for onramp.
- **Durin confirmed best for sub-ENS after full ecosystem check** (2026-05-29):
  Namespace.ninja = no Arbitrum. JustaName = offchain API only. ENSv2 = mainnet-only.
  Build-from-scratch CCIP-Read = ~1.5 extra days, no audit. Durin is the only audited,
  trustless, Arbitrum on-chain ENS-L2 option. Confirmed.
- **Files:** replace `apps/web/src/lib/auth/coinbase-account.ts` (@coinbase/wallet-sdk →
  @zerodev/sdk passkey signer). Keep Para + local-account untouched.
  Server: `verify-delegation.ts` already handles ERC-1271 — minimal changes needed.
- **Estimated: ~1.5 days.** Research @zerodev/sdk passkey + session-key API on Arb Sepolia
  before writing code.
- **DECIDED 2026-05-30 — build Option 1, defer Option 2.** Full plan: `docs/ZERODEV_PASSKEY_INTEGRATION_PLAN.md`.
  - **Option 1 (BUILDATHON):** ZeroDev Kernel whose sudo signer is our existing PRF→secp256k1 key
    (`@zerodev/ecdsa-validator`). Reuses `passkey-account.ts` untouched, **no passkey server**,
    POD identity stays deterministic, server verifier unchanged. Delivers the full story (Kernel +
    scoped on-chain session keys + gasless paymaster + Arbitrum) with zero security regression. ~1d.
  - **Option 2 (POST-BUILDATHON HARDENING / roadmap slide):** native `@zerodev/passkey-validator`
    — P-256 verified on-chain, signing key never in JS. Stronger, but needs a passkey/WebAuthn
    server AND an independent PRF-only POD seed source (smart-account sigs aren't deterministic).
    Option 1 is built with a pluggable sudo-validator interface + wallet-independent POD so this
    swap is localized. **Mention in demo as the security roadmap.**
  - **POD invariant:** ed25519 POD seed is ALWAYS derived from the raw PRF secp256k1 signature
    (deterministic), never from the Kernel — survives the Option 2 swap.

### Architecture decisions (locked 2026-05-29)
- **Modern NameStone Durin**, not the old self-hosted-resolver pattern this doc was first written against:
  - Registry created via the **canonical `L2RegistryFactory`** (same addr all chains: `0xDddddDdDDD8Aa1f237b4fa0669cb46892346d22d`) — we do NOT deploy registry bytecode.
  - Mainnet resolution via NameStone's **`L1Resolver` `0x8A968aB9eb8C084FBC44c531058Fc9ef945c3D61`** + **NameStone-hosted CCIP-Read gateway** (user-confirmed). Self-hosted gateway = post-buildathon roadmap slide.
  - Collapses old tasks #3 (self-host gateway) + #4 (write OffchainResolver) → a single `setL2Registry(registry, 421614)` config tx. ~1.5 days saved, one fewer failure mode.
- **Hybrid Swarm/Arbitrum data model:** L2 registry text records hold only small canonical
  **pointers** (`contenthash` → Swarm bzz ref, `avatar` → Swarm ref); heavy data (profile JSON,
  images, site content) stays on **Swarm**. EAS later: on-chain attestation = minimal claim + Swarm
  ref for any payload. Keeps on-chain footprint tiny (the point of Arbitrum sub-cent gas).
- **Apex preservation (CRITICAL, unverified):** NameStone L1Resolver forwards ALL queries (incl apex)
  to L2, so `woco.eth`'s current site contenthash must be mirrored into the registry root before any
  mainnet resolver swap. Prove on a throwaway name first.

### Build progress
- **2026-05-29 (a):** Durin `src/` vendored verbatim → `contracts/src/durin/` (pin `1ef1ea30`).
  Deps: ens-contracts pinned `a6139f0` (NOT latest v1.7.0 — it moved/removed NameEncoder),
  solidity-stringutils `4b2fcc43`. Remappings in `foundry.toml`. `forge build` green; WoCoEventV2
  unaffected. Commit `331685b` (contracts repo).
- **2026-05-29 (b):** `contracts/src/WoCoRegistrar.sol` — thin custom registrar over the audited
  registry (chosen over server-only minting for stronger on-chain/ecosystem optics; it's Durin's
  intended extension point). Sponsored mint (`onlySponsor`), mints `label.woco.eth` to the organiser
  + sets Swarm `contenthash` + profile text records in one flow, and updates the pointer on redeploy
  without the (email-only) organiser signing — works because the registrar is in the registry's
  `registrars` set (`isAuthorisedForAddress` grants record authority). On-chain label validation +
  reserved names. `DeploySubEnsRegistry.s.sol` (canonical factory create + wire + seed) + 8 tests
  green; full 163-test suite green (no regressions). Commit `a33dff8`.
- **Registration does NOT use Stylus** (decided): one-shot ~30k-gas mint on an audited registry —
  no hot-path/compute benefit. Stylus stays at item #5 (EAS aggregator/trending) where it earns its place.
- **2026-05-29 (c):** Deployed to Arbitrum Sepolia (chain 421614). Commit `9420998` (contracts repo).
  - L2Registry:    `0x41Fb196Ae7D65E06880A240c8d1B91245Fb84807` (Durin clone, factory-deployed)
  - WoCoRegistrar: `0x206e5e2fBF813b5E8A2c2D6ae54106165975BEd3` (verified on Arbiscan)
  - Deployer/admin: `0xff9758533Ec0FE75030820Af9468989B53b19a5c`
  - Sponsor wallet: `0x7b318c46a6FDC544212ebd83335f6b7414A97925` (same as WoCoEventV2 sponsor)
  - Deployment record: `contracts/deployments/421614-subens.json`
- **2026-05-29 (d):** Server routes live. Commits `9206215` + `89f26cb` (IDOR fix).
  - `GET  /api/sub-ens/check/:label` — chain read, no auth; validates + queries WoCoRegistrar.available()
  - `POST /api/sub-ens/claim`         — auth; mints label.woco.eth to organiser via sponsor wallet (INTERIM — will be replaced by permit flow below)
  - `POST /api/sub-ens/set-contenthash` — auth; updates Swarm pointer after site redeploy; IDOR fixed: verifies caller owns the label on-chain via L2Registry.ownerOf() before sponsor tx
  - `POST /api/sub-ens/permit`        — NOT YET BUILT (see next step)
  - ENS contenthash encoding verified against live woco.eth on-chain record (prefix `e40101fa011b20`)
  - Custom errors in ABI for correct ethers v6 revert decoding; `getLabelOwner()` reads ERC-721 ownerOf via computed namehash node
  - `SUB_ENS_CHAIN_ID=421614` + `SUB_ENS_REGISTRAR_ADDRESS` + `SUB_ENS_REGISTRY_ADDRESS` added to server.env
  - Deployed to Hetzner + smoke-tested (check, reserved, validation edge cases all ✓)

### Build progress (continued)
- **2026-05-30:** `registerWithPermit` + EIP-712 shipped. Commits `6dd54c0` (contracts) + `ff9784c` + `7c8e628` (outer repo).
  - Contract: `registerWithPermit(label, owner, contenthash, textKeys, textValues, expiry, sig)` with full EIP-712 domain separation (`DOMAIN_SEPARATOR` immutable in constructor, `PERMIT_TYPEHASH = RegisterPermit(string label,address owner,uint256 expiry)`). Binds to `chainId + address(this)` — prevents testnet→mainnet replay.
  - Security review found cross-chain replay as the only real vuln (no domain sep in original design) — fixed before deploy.
  - `RedeployRegistrar.s.sol` — deploys registrar only against existing L2Registry (upgrade pattern).
  - New WoCoRegistrar: `0x7c0DE55a1713e6C1a53Db50314C7CB608179aAf1` (Arb Sepolia, verified). L2Registry unchanged.
  - `POST /api/sub-ens/permit` — auth, availability check, EIP-712 sign, return `{ sig, expiry, chainId, registrarAddress }`. Server signs with raw `signingKey` (NOT personal_sign — digest is already EIP-712 structured).
  - `signSubEnsPermit()` in `sub-ens-contract.ts` — computes domain separator + struct hash + digest matching the contract. 17 tests green, 172 total.
  - **Deployed to Hetzner ✓** (2026-05-30): rsync + docker build + `scp server.env` + `docker compose up -d` (must use `up -d`, NOT `restart`, to reload env_file). Verified: `/api/health` OK + `/api/sub-ens/check/punkpub` → `{available:true}` against new registrar. `SUB_ENS_REGISTRAR_ADDRESS=0x7c0DE55...` confirmed in container via `printenv`.
  - **NEXT:** `SubENSPicker.svelte` in site builder (new chat, use /frontend-design). Then deploy hook in `sites.ts`.

### IMMEDIATE NEXT: Contract upgrade to registerWithPermit (decided 2026-05-29)

**Why:** Current `onlySponsor` means the server submits the mint tx. Better story for the buildathon = ZeroDev Kernel submits the tx directly (gasless for user via paymaster), server only signs an off-chain permit.

**Signed permit flow:**
1. User authenticates → `POST /api/sub-ens/permit` — server verifies session, checks availability → returns ECDSA sig over `(label, ownerAddress, expiry)`. No tx, just bytes (~50ms).
2. Client's ZeroDev Kernel calls `WoCoRegistrar.registerWithPermit(label, ..., sig)` directly.
3. Contract: `ECDSA.recover(sig) == platformSigner` → mints. Fully trustless, on-chain provenance.
4. ZeroDev paymaster covers gas — user sees nothing.

**Platform signer vs sponsor wallet:**
- `platformSigner` (stored in contract): address whose ECDSA sig authorises a permit. For buildathon, use the same `WOCO_SPONSOR_PRIVATE_KEY` address. Post-buildathon: split into cold key (platform signer, no ETH needed) + hot key (sponsor, holds ETH for other txs).
- For `set-contenthash` (still server-sponsored since email-only organisers can't sign txs), sponsor wallet remains.

**Contract changes needed in `WoCoRegistrar.sol`:**
- Add `address public platformSigner` (set in constructor, changeable by owner)
- Add `mapping(bytes32 => bool) public usedPermits` (replay prevention — hash of `keccak256(label, owner, expiry)`)
- Add `function registerWithPermit(label, owner, contenthash, textKeys, textValues, expiry, sig)` — verifies sig, checks expiry + replay, calls internal `_register()`
- Refactor existing `register()` to call same `_register()` (keeps `onlySponsor` path for server-initiated mints e.g. email-only organisers without a wallet)

**Server route change:** `POST /api/sub-ens/claim` becomes `POST /api/sub-ens/permit` — no tx, just EIP-191 sign and return. `POST /api/sub-ens/claim` (sponsor path) kept for email-only organisers.

**Deployment:** redeploy `WoCoRegistrar` to Arb Sepolia; update `SUB_ENS_REGISTRAR_ADDRESS` in server.env. L2Registry address unchanged.

**To start the next chat:**
> Read docs/SUB_ENS_ARBITRUM_PLAN.md (Build progress + IMMEDIATE NEXT sections). Implement registerWithPermit in WoCoRegistrar.sol, redeploy to Arb Sepolia, update server route to POST /api/sub-ens/permit, then build SubENSPicker.svelte in the site builder.

- **NEXT after contract upgrade:** frontend `SubENSPicker` in site builder publish flow + deploy-hook in `sites.ts`.

### ZeroDev / CSW architecture (corrected 2026-05-29)
- **ZeroDev replaces `passkey-account.ts`** (our custom PRF→secp256k1 EOA), NOT CSW.
- **CSW stays** — kept for existing Coinbase Wallet users + buildathon demo signal. Post-buildathon: reassess based on usage; Coinbase Wallet users can also reach us via WalletConnect.
- **Coinbase Pay (fiat onramp) does NOT require CSW** — Coinbase Pay is address-agnostic; wire it to the ZeroDev Kernel address (Tier 3).
- **Para stays** — email users (MPC). ZeroDev has no native email solution; closest replacement post-buildathon is Privy + ZeroDev.
- Example labels are illustrative (`myband`, `craufurd-arms`); parent `.woco.eth` is fixed, organiser picks the label.

### Tech-lead concerns (flagged 2026-05-29) — UNRESOLVED, decide as we hit them
1. **Time math is red.** ~17.75d of Tier 1 in ~15 calendar days, solo, before pitch buffer.
   Plan for cuts: full Stylus build → testnet-tx + benchmark slide; EAS → like-button + count only.
2. **Mainnet resolver swap = biggest risk AND on the demo critical path.** Changing `woco.eth`'s
   resolver to wildcard/CCIP-Read can break `woco.eth.limo` (the live app). Mitigation: prove on a
   throwaway name; keep a fallback demo showing the Arb registry tx + gateway response WITHOUT
   the mainnet swap, so the demo survives a flaky resolver migration.
3. **Sub-ENS is the headline but NOT the buildathon's core thesis.** Parent pitch = open commerce
   protocol unbundling the platform tax (Store + wallet + agents). Sub-ENS is the strongest
   *supporting* beat (free Arbitrum-native ENS identity for every organiser). Pitch must LEAD with
   the commerce primitive; sub-ENS is "and every organiser gets a free name + portable profile."
4. **EAS (#4) + Stylus (#5) are coupled and late.** Stylus reads EAS, so EAS slipping starves
   Stylus. Both are NEW ecosystems landing days 9–13 with no buffer. This pair is the cut valve.

### Tier 2 — only if Tier 1 ships clean

- Aave yield on idle wallet balance (Sepolia, opt-in toggle) — 2 days
- Agent/MCP surface (OpenAPI + MCP server + demo agent) — 2 days
- V2 register-path wiring + frontend `payAndClaimWithPermit` — 2 days

### Tier 3 — single-slide each, defer to post-buildathon

Coinbase Onramp · Paymaster gasless UX · CCTP cross-chain · Timeboost ·
User-bought .eth · Food order-ahead vertical · Full Stylus hot-path port

