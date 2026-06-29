# Handover — replace the EOA event-registration sponsor with the ZeroDev Kernel + paymaster

> Requested by owner 2026-06-29. NOT started. This is a meaningful change (not a
> one-liner) — scoped here for a dedicated chat. Read `CLAUDE.md` (AUTH + ZeroDev),
> memory `project_zerodev_passkey`, `project_zerodev_incident_202606`,
> `project_auth_provider_decision` FIRST.

## Goal
Today, on-chain `registerEvent` (and `batchClaimFor` for Stripe card mints) is signed by
a **server EOA sponsor wallet** (`WOCO_SPONSOR_PRIVATE_KEY`, plain `ethers.Wallet` in
`apps/server/src/lib/chain/sponsor-wallet.ts`). The owner wants these sponsored txns to
go through the **ZeroDev Kernel account + paymaster** already used for sub-ENS / likes /
shop (gasless, ERC-4337) instead of a raw funded EOA.

## Why it matters / what it buys
- One sponsorship rail (paymaster) instead of a hot EOA that must be kept funded with
  native gas on every chain. Removes the "sponsor ran out of gas" failure class.
- Consistent with the auth-provider direction (everyone on Kernel + paymaster).
- The EOA private key in env (`WOCO_SPONSOR_PRIVATE_KEY`) stops being a gas-holding hot key.

## Current state (what to change)
- `apps/server/src/lib/chain/sponsor-wallet.ts` — `getSponsorWallet()` builds an
  `ethers.Wallet` from `WOCO_SPONSOR_PRIVATE_KEY`; `isSponsorReady()` checks the wallet
  is on the contract allow-list (`NotAuthorised` guard).
- `apps/server/src/lib/chain/event-contract-v2.ts` — `registerEventV2()` and
  `batchClaimForV2()` send txns via that wallet (ethers `Contract` writes).
- Contract: `WoCoEventV2` (Arb Sepolia `0x351070…`). Registration is permissioned —
  the sponsor address must be `addSponsor`'d (see memory `project_arb_smoketest_20260529`:
  the sponsor had to be authorised or every claim reverted `NotAuthorised`).
- ZeroDev rail already in the server: `apps/server/src/lib/auth/smart-wallet-client.ts`
  + sub-ENS/shop/agent routes build Kernel clients with `ZERODEV_RPC` (bundler+paymaster).
  Reuse that client construction.

## Key design questions to resolve in the dedicated chat
1. **msg.sender identity / contract authorisation.** `eventId = keccak256(abi.encode(
   msg.sender, organiserNonce[msg.sender]++))`. Switching the registrant from the EOA to
   the Kernel account CHANGES `msg.sender` → the Kernel address must be `addSponsor`'d on
   `WoCoEventV2`, and the per-sponsor nonce sequence restarts under the new address (fine —
   eventId stays unique). Confirm the contract's sponsor allow-list + any `onlyOwner`
   admin needed to authorise the Kernel.
2. **Which Kernel signs?** A single PLATFORM Kernel (server-held session key) is the
   straight swap for the platform sponsor. Confirm the session-key/validator setup and
   that the server can sign userOps headlessly (no passkey/PRF — use a server-held ECDSA
   session key, like the existing server-side Kernel rails).
3. **Gas policy / paymaster.** Verify the paymaster sponsors `registerEvent` +
   `batchClaimFor` call policies. NOTE memory `project_zerodev_incident_202606` +
   `project_agent_commerce_aa23`: ZeroDev returned a stub `verificationGasLimit=1` and
   heavy call policies need ~3M `verificationGasLimit` (not 800k) or AA23 OOM. Set explicit
   gas limits on these userOps.
4. **Receipt parsing.** `registerEventV2` parses `onChainEventId` from the `Registered`
   event in the tx receipt. Via ZeroDev, get the receipt from the bundler
   (`waitForUserOperationReceipt` → `receipt.logs`) and parse the same event. KEEP this —
   it's how the on-chain id is resolved (see the onChainEventId resolution work below).
5. **Confirmation semantics.** UserOp inclusion ≠ same as a direct tx; keep the existing
   confirmation/await behaviour equivalent so `confirmSeriesOnChain` still runs after the
   event is truly on-chain.

## Suggested approach
- Add a server Kernel signer module (reuse `smart-wallet-client.ts` patterns) exposing
  `sendSponsoredCall(to, data)` → returns `{ txHash, receiptLogs }`.
- Refactor `event-contract-v2.ts` `registerEventV2` / `batchClaimForV2` to build calldata
  (ethers `Interface.encodeFunctionData`) and route through the Kernel sender, parsing the
  receipt logs for `Registered` / `SlotClaimed` as today.
- Gate behind an env flag (`EVENT_SPONSOR_MODE=eoa|kernel`) for a safe rollout + instant
  rollback. Keep the EOA path until the Kernel path is verified on Arb Sepolia end-to-end.
- Authorise the Kernel address on the contract BEFORE flipping the flag.

## Out of scope / leave alone
- onChainEventId resolution for the money path (separate work — chain is the source of
  truth; see the editions-retire change of 2026-06-29). The sponsor swap does not change
  that the contract assigns the id; only `msg.sender` changes.
- The contract itself (no redeploy needed if the Kernel can be `addSponsor`'d).
