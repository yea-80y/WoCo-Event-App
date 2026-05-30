# Sub-ENS + Profiles — Handover (2026-05-30)

## State as of this handover

### What's deployed and live (Hetzner)

| Item | Status | Contract / Commit |
|------|--------|-------------------|
| L2Registry (Durin) | ✅ Arb Sepolia | `0x41Fb196Ae7D65E06880A240c8d1B91245Fb84807` |
| WoCoRegistrar v2 (EIP-712 permit) | ✅ Arb Sepolia, verified | `0x7c0DE55a1713e6C1a53Db50314C7CB608179aAf1` |
| `GET /api/sub-ens/check/:label` | ✅ Live | — |
| `POST /api/sub-ens/claim` | ✅ Live | Server-sponsored (sponsor wallet) |
| `POST /api/sub-ens/permit` | ✅ Live | Returns EIP-712 sig for ZeroDev path |
| `POST /api/sub-ens/set-contenthash` | ✅ Live | Auth + on-chain ownership check |
| `SubENSPicker.svelte` | ✅ Committed `b01f28b` | In site builder Domain tab |
| Deploy hook (auto set-contenthash) | ✅ Committed `b01f28b` | In `apps/server/src/routes/sites.ts` |
| `Site.subEnsLabel?: string` | ✅ In shared types | — |

**NOT deployed yet (committed but needs `npm run deploy`):**
- `SubENSPicker.svelte` and the domain-tab integration are frontend changes.
  The frontend Swarm deploy is manual (`npm run deploy`) — user runs this.

### What the SubENSPicker currently does

- Lives in the **Domain tab** of `MultiSiteBuilder.svelte` (the site/website builder)
- Debounced availability check (380ms) → green ✓ / red ✗ with reason
- Profile bio field (stored as ENS `description` text record)
- Claims via `POST /api/sub-ens/claim` (server-sponsored for all users — ZeroDev path not built yet)
- On success: shows `label.woco.eth` + copy/visit buttons
- On every site deploy (publish): server calls `setContenthash` fire-and-forget if `site.subEnsLabel` is set

### What's NOT done yet (priority order)

1. **Stripe verification gate on SubENSPicker** (immediate next)
2. **ENS picker in the event creation flow** (`EventEditor.svelte`)
3. **Attendee/user profile claiming** (post-purchase gate)
4. **ZeroDev passkey wallet** (replaces server-sponsored claim path)
5. **WoCoStore.sol + store section builder** (buildathon item #2/#3)
6. **EAS likes + Stylus aggregator** (buildathon items #4/#5)
7. **Pitch deck + demo video** (buildathon item #7)

---

## IMMEDIATE NEXT: Stripe gating on SubENSPicker

### Requirement

The ENS picker should only be shown/enabled to organisers who have completed **Stripe Connect verification**.

- **Site builder (MultiSiteBuilder.svelte → Domain tab):** SubENSPicker is hidden/locked until Stripe is connected. Show a "Verify with Stripe first" prompt with a button to open `StripeConnectModal`.
- **Event creation flow (EventEditor.svelte):** Same gate — ENS claiming step only appears if Stripe is verified. If not, skip or show locked state.

**Why:** Prevents squatting. Only verified organisers (real business intent) can claim `label.woco.eth`.

### How to implement

1. **Check Stripe status:** `getStripeAccountStatus()` in `apps/web/src/lib/api/stripe.ts` — calls `GET /api/stripe/account-status`, returns `{ connected: boolean, stripeAccountId?: string }`.

2. **In SubENSPicker.svelte:** Add a new top-level state. On mount (after auth check), call `getStripeAccountStatus()`. If `!connected`, show a locked card:
   ```
   ┌─ LOCKED ────────────────────────────────────────────┐
   │  🔒  Verify your business to claim yourname.woco.eth │
   │  Complete Stripe setup to unlock your free .eth      │
   │  [ Set up Stripe → ]                                 │
   └──────────────────────────────────────────────────────┘
   ```
   The "Set up Stripe →" button should open `StripeConnectModal` (already exists at `apps/web/src/lib/creator/dashboard/StripeConnectModal.svelte`). After the modal reports `onconnected`, re-check and show the full picker.

3. **SubENSPicker.svelte props to add:**
   - `stripeConnected?: boolean` — optional override so the parent can pass in a cached value (avoids duplicate API calls if the parent already knows the Stripe status)
   - `onstripesetup?: () => void` — callback to open the Stripe modal from the parent (so the modal lifecycle stays in the parent)

4. **In MultiSiteBuilder.svelte:** Pass Stripe status down. The builder already calls `getStripeAccountStatus` in Dashboard context — reuse or refetch.

5. **In EventEditor.svelte:** Find the publish step / payment configuration step (where Stripe Connect prompt appears). Add the ENS picker below it, locked until `connected === true`.

### Relevant existing files

```
apps/web/src/lib/api/stripe.ts                      # getStripeAccountStatus()
apps/web/src/lib/creator/dashboard/StripeConnect.svelte     # Stripe connect button/panel
apps/web/src/lib/creator/dashboard/StripeConnectModal.svelte # Modal (onconnected callback)
apps/web/src/lib/creator/builder/SubENSPicker.svelte        # The picker (add stripe gate)
apps/web/src/lib/creator/builder/MultiSiteBuilder.svelte    # Domain tab host
apps/web/src/lib/creator/events/EventEditor.svelte          # Event creation — add ENS step
```

---

## Profile Architecture — Decided

### Attendee/user profiles

**Gate:** Profiles are unlocked by making a purchase (ticket or store item). When someone buys their first ticket, they are prompted to claim a sub-ENS name and set up their profile. The profile is their `label.woco.eth` ENS identity.

**Rationale:**
- Sybil resistance — ENS names earned, not farmed
- Social graph bootstrapped from commerce, not explicit follows
- "Your receipt IS your identity" pitch for non-crypto users

**Auto-follow on purchase (novel idea — implement later):** When a ticket is purchased, automatically create an EAS `follows` attestation: the buyer follows the organiser/venue. Profile is pre-populated with their social graph.

**Tiered unlock:**
- Level 1 (1 purchase): claim sub-ENS + basic profile (bio, avatar link)
- Level 2 (3+ EAS attendance attestations): "verified attendee" badge on profile
- Level 3 (Stripe-verified organiser): organiser badge + featured listing
All verifiable on-chain, no WoCo database.

### Profile page integration (Phase 2, after buildathon)

The existing profile page at `/profile/{address}` should grow to support:
- ENS claiming inline (same SubENSPicker component, no site required)
- Display resolved ENS name if already claimed
- Bio, avatar, social links (all from ENS text records)
- EAS attendance badges (from Stylus aggregator)
- Like/follow counts

This reuses the same SubENSPicker and sub-ENS infrastructure — just exposed on a different page.

---

## EAS + Stylus Relationship (clarification)

These are two separate, complementary layers:

| Layer | Tool | Role |
|-------|------|------|
| Write | **EAS (Ethereum Attestation Service)** | Creates attestations: `liked(subject)`, `follows(subject)`, `attended(event)`. Gasless via ZeroDev paymaster. On Arbitrum. |
| Read/Aggregate | **Stylus (Rust contract on Arbitrum)** | Reads EAS attestations, computes trending / follower counts on-chain. One Stylus query = "top 10 venues by likes this week" — cheap, verifiable, demo-able. |

Stylus does NOT replace EAS. It is the aggregation/indexing layer that makes EAS data queryable on-chain without a server. This is the buildathon pitch: "social graph computed in Rust on Arbitrum for $0.0001 per query."

**EAS schemas to define:**
```
follows(address subject, bytes32 subEnsNode)  // subject ENS node being followed
likes(address subject, bytes32 subEnsNode)    // subject being liked
attended(bytes32 eventId, bytes32 subEnsNode) // attendance proof
```

---

## Remaining Buildathon Items (priority order)

| # | Item | Effort | Status |
|---|------|--------|--------|
| 1b | ZeroDev passkey wallet | 1.5d | ⬜ Not started — research first |
| 1 (cont) | Stripe gate on SubENSPicker | 0.25d | ⬜ Next |
| 1 (cont) | ENS picker in EventEditor | 0.5d | ⬜ Next |
| 2 | WoCoStore.sol (Arb Sepolia) | 3d | ⬜ Not started |
| 3 | Store section in MultiSiteBuilder | 3d | ⬜ Not started |
| 4 | EAS likes + attendance | 2d | ⬜ Not started |
| 5 | Stylus aggregator contract | 2.5d | ⬜ Not started |
| 7 | Pitch deck + 2-min demo | 2.5d | ⬜ Not started |

**Cut valve if tight:** Stylus → testnet tx + benchmark slide only; Store → product grid only (no cart/checkout). Do NOT cut Sub-ENS, ZeroDev, or pitch.

---

## Key env vars (server.env on Hetzner)

```
SUB_ENS_CHAIN_ID=421614
SUB_ENS_REGISTRAR_ADDRESS=0x7c0DE55a1713e6C1a53Db50314C7CB608179aAf1
SUB_ENS_REGISTRY_ADDRESS=0x41Fb196Ae7D65E06880A240c8d1B91245Fb84807
WOCO_SPONSOR_PRIVATE_KEY=<set>
```

## Key file map (sub-ENS related)

```
apps/web/src/lib/api/sub-ens.ts                   # checkSubEnsLabel, claimSubEnsLabel
apps/web/src/lib/creator/builder/SubENSPicker.svelte  # claim UI (add Stripe gate here)
apps/web/src/lib/creator/builder/MultiSiteBuilder.svelte  # Domain tab host
apps/server/src/routes/sub-ens.ts                 # check / claim / permit / set-contenthash routes
apps/server/src/lib/chain/sub-ens-contract.ts     # ABI, isLabelAvailable, mintSubEnsName, signSubEnsPermit
apps/server/src/routes/sites.ts                   # deploy hook (auto set-contenthash)
packages/shared/src/site/types.ts                 # Site.subEnsLabel?: string
```
