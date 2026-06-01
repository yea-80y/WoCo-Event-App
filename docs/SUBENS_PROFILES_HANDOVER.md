# Sub-ENS + Profiles — Handover (2026-05-30, updated)

## Deployed & live state

| Item | Status | Commit |
|------|--------|--------|
| L2Registry (Durin) | ✅ Arb Sepolia `0x41Fb196…` | contracts `9420998` |
| WoCoRegistrar v2 (EIP-712 permit) | ✅ Arb Sepolia `0x7c0DE55…`, verified | contracts `7c8e628` |
| `GET /api/sub-ens/check/:label` | ✅ Live on Hetzner | `9206215` |
| `POST /api/sub-ens/claim` | ✅ Live — server-sponsored (ZeroDev path not yet built) | `9206215` |
| `POST /api/sub-ens/permit` | ✅ Live — EIP-712 sig for future ZeroDev client path | `ff9784c` |
| `POST /api/sub-ens/set-contenthash` | ✅ Live — auth + on-chain ownership check | `89f26cb` |
| `SubENSPicker.svelte` | ✅ Committed — Stripe gate + claim UI + success state | `d28aeb0` |
| Stripe gate on SubENSPicker | ✅ Shipped — locked card until Stripe onboarding complete | `d28aeb0` |
| ENS picker in EventForm | ✅ Shipped — appears between EventEditor and PublishButton | `d28aeb0` |
| Deploy hook (auto set-contenthash) | ✅ Live — fires on every site deploy if subEnsLabel set | `b01f28b` |
| `Site.subEnsLabel?: string` | ✅ In shared types | `b01f28b` |

**Frontend Swarm deploy (`npm run deploy`) still needed by user** — all frontend commits above are built but not yet on Swarm.

---

## What SubENSPicker does (current)

- **Stripe gate** — self-checks `getStripeAccountStatus()` on mount; shows locked card with lock icon + "Set up Stripe →" CTA until `onboardingComplete`. Accepts `stripeConnected` prop from parent to skip duplicate fetch; calls `onstripesetup` callback if parent manages the modal, otherwise opens `StripeConnectModal` internally.
- **Site builder** — lives in Domain tab of `MultiSiteBuilder.svelte`. Builder fetches Stripe status lazily on first Domain-tab open, passes it down.
- **Event creation flow** — `EventForm.svelte` includes `<SubENSPicker />` between EventEditor and PublishButton; self-checks Stripe (no parent wiring).
- **Claim flow** — debounced availability check (380ms) → green ✓ / red ✗; profile bio field (ENS `description` text record); claims via server-sponsored `POST /api/sub-ens/claim`; success shows `label.woco.eth` + copy/visit buttons.
- **Deploy hook** — every site publish auto-calls `set-contenthash` fire-and-forget if `site.subEnsLabel` is set.

---

## Sub-ENS gating decisions (settled)

| User type | Gate |
|-----------|------|
| Venues / organisers | Stripe Connect onboarding ✅ (built) |
| Attendees | First purchase (ticket or store item) — Phase 2, post-buildathon |
| Bands / artists | "Get in touch" manual whitelist for now; automation path: organiser tags performer on event → EAS `performer` attestation → band claims name without Stripe (ties into EAS #4) |

**Anti-squatting:** reserved name list (already in WoCoRegistrar) + 1-per-wallet limit post-buildathon.

---

## Referral system — designed, not built

Record referral on-chain as EAS attestation `referred(referrer, referee, venueId)`. Gasless via ZeroDev paymaster. Kickback: Stripe webhook fires on referred venue's first sale → distribute reward (post-buildathon). Stylus can count referrals per address just like likes. **Design hook: leave EAS schema slot for `referred` when building #4; leave Stripe webhook hook point for reward dispatch.** See memory `project_referrals.md`.

---

## Profile Architecture — Decided

### Attendee profiles (Phase 2, post-buildathon)

Gate: first purchase unlocks sub-ENS claim + basic profile. Tiered:
- Level 1 (1 purchase): claim sub-ENS + profile (bio, avatar)
- Level 2 (3+ EAS attendance attestations): "verified attendee" badge
- Level 3 (Stripe-verified organiser): organiser badge + featured listing

All verifiable on-chain. Auto-follow on purchase → EAS `follows` attestation (buyer follows organiser). Profile page at `/profile/{address}` grows to show ENS name, bio, EAS badges, like/follow counts — reuses SubENSPicker component.

---

## EAS + Stylus layers

| Layer | Tool | Role |
|-------|------|------|
| Write | EAS | `liked`, `follows`, `attended`, `referred`, `performer` attestations. Gasless via ZeroDev paymaster. |
| Read/Aggregate | Stylus (Rust on Arbitrum) | Reads EAS, computes trending/ranking/counts on-chain. ~$0.0001/query. |

**EAS schemas to register:**
```
follows(address subject, bytes32 subEnsNode)
likes(address subject, bytes32 subEnsNode)
attended(bytes32 eventId, bytes32 subEnsNode)
referred(address referrer, address referee, bytes32 venueId)   // design hook — build with #4
performer(bytes32 eventId, address artist)                     // enables artist ENS gate
```

---

## Remaining Buildathon Items

| # | Item | Effort | Status |
|---|------|--------|--------|
| 1b | ZeroDev passkey wallet | 1.5d | ⬜ **NEXT — start here** |
| 2 | WoCoStore.sol (Arb Sepolia) | 3d | ⬜ Not started |
| 3 | Store section in MultiSiteBuilder | 3d | ⬜ Not started |
| 4 | EAS likes + attendance | 2d | ⬜ Not started |
| 5 | Stylus aggregator contract | 2.5d | ⬜ Not started |
| 7 | Pitch deck + 2-min demo | 2.5d | ⬜ Not started |

Cut valve if tight: Stylus → testnet tx + benchmark slide only; Store → product grid only (no cart). Do NOT cut ZeroDev, Sub-ENS, or pitch.

---

## ZeroDev — RESEARCHED + PLANNED (2026-05-30)

Research done; architecture decided. **Full plan: `docs/ZERODEV_PASSKEY_INTEGRATION_PLAN.md`**
(has a copy-paste START NEXT CHAT block).

**Decision: Option 1 — ECDSA-over-PRF Kernel** (DRY, no passkey server, deterministic POD kept).
NOT native passkey-validator — that's Option 2, deferred as post-buildathon hardening + demo
roadmap slide (needs a passkey server + an independent PRF-only POD seed source).

Key points carried into the build:
1. **Reuse `passkey-account.ts` untouched** — PRF→secp256k1 becomes the Kernel's ECDSA sudo signer.
2. **POD identity stays on the raw PRF key (deterministic), never the Kernel** — hard invariant.
3. Scoped on-chain ZeroDev session keys (`@zerodev/permissions`, `toCallPolicy` → WoCoRegistrar/EAS) + gasless paymaster.
4. `SubENSPicker` permit path: `POST /api/sub-ens/permit` → Kernel session-key userOp calls `registerWithPermit`. Keep sponsor `/claim` for email-only organisers.
5. Server `verify-delegation.ts` already handles ERC-1271/6492 — **no server change for auth**.
6. Pluggable sudo-validator interface so the Option 2 swap is localized.

**Needs from user before coding:** a ZeroDev project (Arb Sepolia) + paymaster gas policy →
`VITE_ZERODEV_RPC` in `apps/web/.env`.

---

## Key env vars (server.env on Hetzner)

```
SUB_ENS_CHAIN_ID=421614
SUB_ENS_REGISTRAR_ADDRESS=0x7c0DE55a1713e6C1a53Db50314C7CB608179aAf1
SUB_ENS_REGISTRY_ADDRESS=0x41Fb196Ae7D65E06880A240c8d1B91245Fb84807
WOCO_SPONSOR_PRIVATE_KEY=<set>
```

## Key file map

```
apps/web/src/lib/creator/builder/SubENSPicker.svelte      # claim UI + Stripe gate
apps/web/src/lib/creator/builder/MultiSiteBuilder.svelte  # Domain tab host + Stripe status
apps/web/src/lib/creator/events/EventForm.svelte          # event creation — has SubENSPicker
apps/web/src/lib/api/sub-ens.ts                           # checkSubEnsLabel, claimSubEnsLabel
apps/server/src/routes/sub-ens.ts                         # check / claim / permit / set-contenthash
apps/server/src/lib/chain/sub-ens-contract.ts             # ABI, isLabelAvailable, signSubEnsPermit
apps/server/src/routes/sites.ts                           # deploy hook (auto set-contenthash)
packages/shared/src/site/types.ts                         # Site.subEnsLabel?: string
```

---

## CURRENT STATE — 2026-06-01 (verified live in dev)

**Sub-ENS for the buildathon is functionally DONE.** Verified end-to-end on Arb Sepolia
via passkey/ZeroDev:
- Gasless passkey claim works: `POST /api/sub-ens/permit` → scoped ZeroDev session-key
  userOp → `registerWithPermit` lands on-chain, no gas, no popup. (ZeroDev Phases 0–4
  shipped; see `ZERODEV_PASSKEY_INTEGRATION_PLAN.md`.)
- Three bugs found + fixed during live test (all committed):
  1. Server signature verifier was pinned to Base only → 403 "Invalid signature" for the
     Kernel (Arb Sepolia). Now multi-chain (`smart-wallet-client.ts`). `da59a83`/`c54a07e`.
  2. Session-key gas policy had `allowed: 0n` → `PolicyFailed(1)`. Fixed to a real budget,
     dropped `enforcePaymaster`. `9f6f4f5`.
  3. POD seed/keypair looked up under `auth.parent` (Kernel) instead of the PRF-EOA
     address → "Could not get signing key" on publish. Added `auth.podAddress`. `6a3c5bb`.
- ZeroDev paymaster: use the MANAGED endpoint (`VITE_ZERODEV_RPC` WITHOUT `?selfFunded=true`)
  + a Gas Policy enabled on the dashboard. `selfFunded` hit AA30 (self-funded paymaster
  never deployed).
- `SubENSPicker` claim card shows `label.woco.eth.limo` with a non-clickable **"Live soon"**
  pill (the `.limo` URL needs the mainnet resolver cutover — parked, see below). `959cda7`.

**Multiple sub-ENS per account: SUPPORTED.** No per-wallet cap is enforced (the 1-per-wallet
limit is post-buildathon). `Site.subEnsLabel` is per-site, so N sites = N names (user verified
two). The registry is plain ERC-721 — one independent token + records per label.

**`.woco.eth.limo` resolution: PARKED post-buildathon (decided).** Needs the one mainnet step
(point `woco.eth`'s resolver at NameStone's L1Resolver + `setL2Registry` → Arb registry).
It's the #1 risk on the demo critical path. Demo via Arbiscan (the on-chain name + records)
+ the `gateway.woco-net.com/bzz/{hash}/` site URL. See `SUB_ENS_ARBITRUM_PLAN.md`.

---

## NEXT CHAT — Event ↔ sub-ENS routing (NOT built; the real gap)

**Problem the user hit:** in `EventForm.svelte` the `<SubENSPicker />` (line 77, no props) only
*claims a new name* and is **not wired to event deployment at all** — there is no event→Swarm
→`set-contenthash` flow (events live in platform feeds, only multi-page SITES deploy as standalone
Swarm collections + set a sub-ENS contenthash). So "set a sub-ENS for an event" does nothing useful
today, and there's no way to pick an EXISTING name.

**Desired model (user, 2026-06-01):** when creating an event, let the organiser choose one of:
1. **Post to an existing site** — event appears on their already-deployed site under its existing
   sub-ENS (already possible via the builder EventsTab; just surface it in the event flow).
2. **Create a NEW sub-ENS for the event** — deploy a standalone event page to Swarm, claim a new
   label, set that label's contenthash to it.
3. **Use an EXISTING sub-ENS they own** — overwrite that label's contenthash with the new event
   page's hash.

**Build sub-tasks for next chat:**
- Standalone single-event page deploy to Swarm (reuse the multisite runtime to render a one-event
  site, or a minimal event template) → returns a content hash. Mirror `sites.ts` deploy.
- Enumerate a user's owned sub-ENS names (registry is ERC-721; options: index Transfer events,
  a creator feed `woco/sub-ens/owner/{addr}`, or NameStone API). Needed for the "select existing"
  option — the app currently does NOT track a user's set of names.
- New `EventDomainPicker` (or extend `SubENSPicker`) with the 3-way choice; wire the chosen label →
  `POST /api/sub-ens/set-contenthash` (already live, ownership-checked) with the event page hash.
- Decide overwrite UX/warning when option 3 replaces a label already pointing at a site.
