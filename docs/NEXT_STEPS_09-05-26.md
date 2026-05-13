# WoCo App — Handoff (2026-05-09, updated post end-to-end test)

## Repo: /home/ntl/projects/woco_app (branch: main)
Read CLAUDE.md and memory files before writing any code.
Full architecture plan: docs/ON_CHAIN_TICKETING_PLAN.md

---

## What was built / fixed this session

### Steps 1–3 (previous session — already deployed)
- `WoCoEvent.sol` redeployed Base Sepolia: `0x4bf8aa0FDaF5045EFEd675e019F81316063c94b4`
- Stripe webhook → `claimFor` on-chain for v2 events
- Organiser dashboard reads attendees from chain

### This session — fixes made during end-to-end test

**Frontend redeployed** (woco.eth now on latest build):
- `PublishButton.svelte` — removed `isWalletAvailable` check; removed nonce fetch; removed `callRegisterEvent` client-side wallet call
- `apps/web/src/lib/chain/woco-event.ts` — updated contract address + added `wallet_addEthereumChain` fallback (kept for wallet users; not used by passkey/Para organisers)
- `apps/web/src/lib/api/events.ts` — added `registerSeriesOnChain()` which calls new server endpoint

**Server changes:**
- `apps/server/src/lib/chain/event-contract.ts` — added `EXTRA_RPC_URLS` for Base Sepolia (84532 was missing from `PaymentChainId`); exported `getChainRpcUrl()`
- `apps/server/src/lib/chain/sponsor-wallet.ts` — `getSponsorWallet()` now uses `getChainRpcUrl()` (was defaulting to `localhost:8545`); added `registerEventOnChain()` function
- `apps/server/src/routes/events.ts` — new `POST /:id/register-on-chain` endpoint: sponsor wallet calls `registerEvent`, then writes `onChainEventId` back to Swarm feed. No organiser wallet needed.

**Stripe Connect test mode:**
- Cleared `.data/stripe-accounts.json` (live-mode `acct_` can't be used with test keys)
- Re-onboarded a test-mode Stripe connected account
- `card_payments` capability must be enabled on the test account before checkout works

---

## End-to-end test result ✓

```
[sponsor] registerEvent supply=100 manifestRef=0xe56f3dc1… chain=84532
[sponsor] registerEvent confirmed txHash=0xa86bce3...
[sponsor] Registered onChainEventId=0xee233fe8...
[sponsor] claimFor eventId=0xee233fe8… burner=0x4E43De0… orderRef=0x7024500a… chain=84532
[sponsor] claimFor confirmed txHash=0x5f7b4ec0...
[sponsor] SlotClaimed slot=0
```

Attendee info visible in organiser dashboard after decrypt. ✓

---

## Current deployment state

- **Contract**: `WoCoEvent.sol` on Base Sepolia (`0x4bf8aa0FDaF5045EFEd675e019F81316063c94b4`, chain 84532)
- **Server**: deployed to 192.168.0.144, `npm run start` running, health OK
- **Stripe**: test mode keys (`sk_test_...`). Test connected account in `.data/stripe-accounts.json`
- **Frontend**: redeployed to woco.eth (Swarm) this session

### Env vars on server (apps/server/.env)
```
WOCO_SPONSOR_PRIVATE_KEY=<deployer key>
WOCO_EVENT_CHAIN_ID=84532
```

---

## How v2 events work end-to-end

1. Organiser creates event → server calls `registerEvent(supply, manifestRef)` via sponsor wallet → `onChainEventId` stored in event feed on Swarm
2. Buyer pays via Stripe → `checkout.session.completed` webhook fires
3. Webhook: uploads encrypted order to Swarm → calls `claimForOnChain(onChainEventId, burner, orderRefBytes32)` → gets slot from `SlotClaimed` event → fetches pod body → sends email ticket
4. Organiser opens dashboard → `/api/events/:id/orders` reads `nextSlot` from chain → `getSlotData` per slot → downloads encrypted blobs → returns to client
5. Client decrypts with X25519 private key (derived from wallet sig via POD identity, never leaves browser)

---

## Three platform keys — keep distinct

1. **Swarm FEED_PRIVATE_KEY** — platform signs SOC feed updates. Still needed for v1 feeds + site builder.
2. **Ethereum sponsor wallet** (`WOCO_SPONSOR_PRIVATE_KEY`) — calls BOTH `registerEvent` (on publish) AND `claimFor` (on webhook). Currently = deployer EOA for Sepolia testing. **Must be rotated to a dedicated wallet before Base mainnet launch.**
3. **Burner wallet** — generated per-ticket by `generateBurnerAddress()`. Private key discarded immediately.

---

## Known gaps / deferred

- `claimedAt` is blank for v2 rows — not stored on-chain. Options: (a) store in encrypted order blob, (b) look up tx timestamp from chain (expensive), (c) accept the gap
- Stripe Connect test mode: if switching back to live keys, re-link the live `acct_` by going through Connect onboarding again (or manually update `.data/stripe-accounts.json`)
- v1 free-event path kept intentionally — free events don't justify gas costs

---

## Next steps (future sessions)

### When ready for Base mainnet
1. `forge script script/DeployEvent.s.sol --rpc-url base --broadcast` (from contracts/)
2. Set `WOCO_EVENT_CHAIN_ID=8453` and `WOCO_EVENT_ADDRESS_8453=<new address>` in .env
3. Create dedicated sponsor wallet, fund with ~$10 ETH
4. Call `addSponsor(newAddress)` on new contract from owner key
5. Set `WOCO_SPONSOR_PRIVATE_KEY` to new sponsor key
6. Re-link organiser Stripe accounts (live-mode `acct_` IDs)

### Code cleanup (deferred)
- v1 retirement: remove `topicClaimers`, `topicClaims`, `topicEditions` feed writes from claim-service.ts
- `save-order` endpoint in stripe.ts is a no-op for v2 — remove once v1 retired
- `confirm-chain` endpoint (`POST /:id/confirm-chain`) is now superseded by `register-on-chain` — can be removed once v1 is retired
- `callRegisterEvent` and `getWoCoEventAddress` in `apps/web/src/lib/chain/woco-event.ts` are unused for normal flow — kept for potential future wallet-based override

### Crypto payAndClaim (v1.5)
- Buyer calls contract directly with ETH/USDC — no platform in claim path
- Requires `payAndClaim` function added to `WoCoEvent.sol`
- Formal audit required before this ships
- Design doc: docs/PAYMENTS_PHASE_2.md

### Batch claimFor — multi-ticket gas efficiency
Currently each ticket in a multi-ticket purchase fires a separate `claimFor` transaction.
For a 2-ticket buy: 2 txs, 2 gas payments, sequential.

**Plan**: Add `batchClaimFor` to `WoCoEvent.sol`:
```solidity
function batchClaimFor(
    bytes32 eventId,
    address[] calldata burners,
    bytes32[] calldata orderRefs
) external onlySponsor {
    require(burners.length == orderRefs.length, "length mismatch");
    for (uint i = 0; i < burners.length; i++) {
        _claimSlot(eventId, burners[i], orderRefs[i]); // emits SlotClaimed per slot
    }
}
```
Server side: in `stripe.ts` webhook, collect all (burner, orderRef) pairs for the batch
then call `batchClaimFor` once. One tx per checkout session regardless of ticket count.

Files to change:
- `contracts/src/WoCoEvent.sol` — add `batchClaimFor`
- `apps/server/src/lib/chain/sponsor-wallet.ts` — add `batchClaimForOnChain()`
- `apps/server/src/routes/stripe.ts` — use batch call in `checkout.session.completed` handler
- Requires contract redeployment (new address → update WOCO_EVENT_ADDRESS_84532 / 8453 env)
- Must re-call `addSponsor` on new contract before going live

### Dashboard improvements
- `claimedAt` empty for v2 rows (see Known gaps above)
- Sales panel could use `onChainData.nextSlot` for faster read instead of orders array length

---

## Key files changed this session
```
apps/server/src/lib/chain/event-contract.ts    # getChainRpcUrl() + Base Sepolia RPC URL
apps/server/src/lib/chain/sponsor-wallet.ts    # registerEventOnChain() + use getChainRpcUrl
apps/server/src/routes/events.ts               # POST /:id/register-on-chain endpoint
apps/web/src/lib/api/events.ts                 # registerSeriesOnChain() client fn
apps/web/src/lib/chain/woco-event.ts           # new contract address + addEthereumChain fallback
apps/web/src/lib/components/events/PublishButton.svelte  # server-side chain registration
```

---

## Hard constraints (carry forward)
- NEVER deploy Base mainnet without explicit user confirmation
- NEVER push to GitHub without being asked
- contracts/ is a separate nested git repo (branch: master)
- apps/server/.env on laptop is master — sync to server on every deploy
- Kill only woco-events-server PIDs on restart — check /proc/PID/cwd to distinguish from mf8-server and devconnect-server (all coexist on 192.168.0.144)
- Swarm refs: Hex64 (no 0x). Ethereum: 0x-prefixed.
- Stripe test mode: `.data/stripe-accounts.json` stores test `acct_` — don't overwrite with live account IDs
