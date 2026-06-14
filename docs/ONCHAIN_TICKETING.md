# On-Chain Ticketing + Smart Wallets

How WoCo issues event tickets on-chain on **Arbitrum Sepolia (`421614`)**, and the two
smart-account login methods that make every user action gasless. Companion to
[`BUILDATHON_SUBMISSION.md`](./BUILDATHON_SUBMISSION.md).

---

## 1. `WoCoEventV2` — the ticketing contract

`WoCoEventV2` (`0x351070Aff6dECa449506a6eA6dC6cB84D13cAedf`) is a USDC ticketing contract with:

- **Per-event supply + pricing** — each event is registered with its own organiser, supply,
  price, platform-fee basis points, and an optional time-lock (`releaseDelay`).
- **Sponsor-gated minting** — `claimFor(eventId, owner, orderRef)` and `batchClaimFor(...)` mint
  ticket slots to a recipient. They are callable by the platform sponsor
  (`0x7b318c46a6FDC544212ebd83335f6b7414A97925`), which is how a **card buyer who never touches a
  wallet still receives an on-chain ticket**: the Stripe webhook drives `claimFor`.
- **Pay-and-claim with permit** — `payAndClaimWithPermit(...)` lets a buyer pay USDC and claim in
  one transaction using an EIP-2612 permit (no separate approval tx).
- **Time-locked payout + refunds** — `withdraw(eventId)` releases funds to the organiser only
  after the event end plus `releaseDelay`, splitting off the platform fee
  (`fee = gross * platformFeeBps / 10_000`). `claimRefund(...)` returns funds to buyers if an
  event is cancelled.
- **Fee bound on-chain** — the platform fee is a per-event value (default 1.5%), and the contract
  **rejects any fee above 10%** at registration (`FeeTooHigh`).

V1 (`0x172031E6a8428617B05F2002e0e278bb8fb3Ed8A`) is the earlier deploy and remains live.

Register + claim were smoke-tested end-to-end against the production stack on 2026-05-29.

### How a card buyer gets a real on-chain ticket (burner + encrypted Swarm pointer)

A card (or email) buyer has no wallet, so the sponsor path mints to a **fresh ephemeral burner
address generated per ticket** — that burner becomes the on-chain ticket owner, and the signed
ticket edition is verifiable against it. The buyer's order data is **ECIES-encrypted to the
organiser's X25519 key (derived from their POD ed25519 identity)** — so only the organiser can
decrypt it — and uploaded to Swarm. The resulting **Swarm hash of the encrypted blob is written
on-chain as the claim's `orderRef`** (and emitted in the `SlotClaimed` event). The chain therefore
carries a tamper-evident pointer to encrypted attendee data that nobody but the organiser can read —
with no database anywhere in the path.

## 2. Passkey smart wallet (ZeroDev Kernel)

A user can log in with a **passkey** and get a full ERC-4337 smart account with no seed phrase:

- The account's **root key is an ECDSA key derived from the passkey's PRF extension** — it is
  never on the hot path of day-to-day actions.
- Day-to-day actions are signed by **scoped session keys**, each pinned by on-chain policies
  (which contract + function it may call, a timestamp window, a rate limit, and a gas budget). A
  leaked session key can only do what its policies allow.
- Session keys send **gasless** userOps via a paymaster. This is the engine behind gasless
  sub-ENS claims, gasless EAS likes, and the bounded agent draw.

## 3. Coinbase Smart Wallet login

Coinbase Smart Wallet (CSW) is an alternative first-class login (a smart account on Base):

- CSW signs WoCo's `AuthorizeSession` EIP-712 payload as an **ERC-1271 / ERC-6492** signature; the
  server verifies it with viem's universal signature validator.
- **Signature verification is multi-chain by design**: the server checks 1271/6492 across every
  smart-account home chain — **Base for CSW and Arbitrum Sepolia for the Kernel wallet** — so the
  two coexist as first-class identities. (A single-chain pin previously rejected all passkey
  logins; the multi-chain verifier is the fix.)
- CSW always signs on **Base** regardless of the app's configured chains, and connect + sign are
  two separate user gestures (the CSW SDK rejects an in-flight popup listener) — both reflected in
  the UI.

## 4. Security review (summary)

A `/security-review` pass over `WoCoEventV2` found **no HIGH or MEDIUM findings** at the confidence
threshold. Two items are parked for a future mainnet deploy, not Sepolia:

1. **Treasury-blacklist resilience** — `withdraw` pays the platform fee and the organiser net in one
   transaction; if the platform treasury were USDC-blacklisted, the fee leg would revert and brick
   payouts until the owner rotates the treasury. Recoverable, not attacker-controlled. Mainnet fix:
   pay the organiser first, or accrue fees for later sweep.
2. **Permit front-run griefing** — the `permit` call is wrapped in an empty `catch` on purpose
   (an attacker landing the signed permit first consumes the nonce but leaves the allowance set, so
   the claim still works). A WHY-comment is wanted so a maintainer doesn't "fix" it into a vector.

Mainnet pre-deploy checklist: address both items, move the treasury and owner to a Safe multisig,
rotate the dispute authority, and source-verify on Arbiscan.

## Addresses (Arbitrum Sepolia `421614`)

| Contract | Address | Source-verified on Arbiscan |
|---|---|---|
| `WoCoEventV2` | `0x351070Aff6dECa449506a6eA6dC6cB84D13cAedf` | ✅ Yes |
| `WoCoEvent` (V1) | `0x172031E6a8428617B05F2002e0e278bb8fb3Ed8A` | No (superseded by V2) |
| Platform sponsor (public EOA) | `0x7b318c46a6FDC544212ebd83335f6b7414A97925` | — |
| USDC (Circle test) | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | Canonical Circle |

## Honest state

- **Arbitrum Sepolia (testnet).** Go-live is a one-line USDC address swap to Arbitrum One.
- `WoCoEventV2` is **source-verified on Arbiscan** — judges can read the Solidity at the address.
- **Stripe is the live payment rail today.** Direct USDC ticket payment code exists; the escrow
  contract (`WoCoEscrow.sol`) is disabled pending changes + an audit.
