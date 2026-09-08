# Sub-ENS identity

`label.woco.eth` names as the identity primitive for user profiles and organiser brands.

**Verified against `main` and the live `/api/health` on 2026-09-08.**

---

## What a name is

A WoCo profile or brand is a **sub-ENS name** — `nabil.woco.eth` — held as an **ERC-721 token**
in an L2 registry (a [Durin](https://durin.dev)-style `L2Registry`, deployed from our own
implementation).

Because the name is an NFT rather than a database row:

- **Identity travels on transfer.** Sell the brand and the name moves with it, along with
  whatever is attached to it.
- **Ownership is read live from chain** (`ownerOf`), never cached at a parent. A transfer is
  visible immediately with no re-indexing.

Names are browsable at `<label>.woco.eth.link`. That suffix is `SUB_ENS_WEB_SUFFIX` in
`packages/shared/src/sub-ens/web.ts` and appears **nowhere else** — a test fails if a literal
reappears under `apps/web/src`. It has moved before (eth.limo refused certificates for two-label
subnames at one point), which is exactly why it is a single constant.

---

## Where it lives

Names are on **Arbitrum One (`42161`)** — mainnet. Every real name lives there, and `woco.eth`'s
L1 resolver answers from that registry.

| | Address |
|---|---|
| `SubENSRegistry` (L2Registry clone) | `0x8630000177d44ec12e4752Ae0C8b26390d30A2B6` |
| `WoCoRegistrar` | `0xACfe7c02909a5c1eB64aE5aA10D18618323403a2` |
| L2Registry implementation | `0x172031e6a8428617b05f2002e0e278bb8fb3ed8a` |
| `L1Resolver` (Ethereum mainnet) | `0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63` |
| baseNode (`woco.eth`) | `0x616c19dee44e200629c0e4918ca0fe2f6e85100ea0b354c4f888e11c07a9006f` |

Source of truth: `packages/shared/src/sub-ens/addresses.ts` and
`contracts/deployments/42161-subens.json` in the WoCo-Contracts repo. Arbitrum Sepolia
(`421614`) carries a parallel deployment for testing; names do **not** carry across registries,
so every label is claimable from scratch there.

Registry and registrar admin roles are held by a **Safe**, not an EOA, so a compromised deployer
key cannot move names.

### The two layers, and why they are separate

| Layer | Role |
|---|---|
| **`L2Registry`** | **Permanent.** Holds every name as an ERC-721 and carries the resolver records. Replacing it is a migration of every holder, every follow target and every ENS pointer — so it is treated as frozen from the mainnet deploy onward. |
| **`WoCoRegistrar`** | **Replaceable policy.** Who may mint, the rate cap, the permit scheme. Swapping it costs one `addRegistrar` call. |

That split is the reason the registrar has been redeployed several times and the registry has
not.

---

## How resolution actually works

`*.woco.eth` resolves through **EIP-3668 CCIP-Read**, so a mainnet lookup ends up reading an
Arbitrum One registry:

```
1.  resolver for woco.eth  →  L1Resolver on Ethereum mainnet
2.  L1Resolver reverts OffchainLookup pointing at
      https://events-api.woco-net.com/api/ens-gateway/v1/{sender}/{data}
3.  our gateway reads the PINNED Arbitrum One registry and signs the answer
4.  L1Resolver accepts anything SignatureVerifier.verify() accepts for signer()
```

Step 4 is the security-critical one: **a signature from that key over any `result` is
authoritative resolution for any name under the parent.** There is no second opinion. So every
refusal in `apps/server/src/lib/ens-gateway/ccip.ts` is a security control, not input
validation — nothing is signed until the request has been proved to be about a name this gateway
may answer for, and the answer has come from the registry rather than from the request.

`/api/health` reports the gateway's live configuration: `signer`, `chainId`, `registry`, `parent`
and a `crossCheck` flag.

---

## Claiming a name

- **Passkey and email users claim gaslessly.** The account is a ZeroDev Kernel on the *same*
  chain as the registry, and a scoped session key calls `registerWithPermit(...)` against a
  server-signed permit, sponsored by the paymaster. The user pays no gas and signs no raw
  transaction.
- The registrar enforces availability, one canonical record per name, a per-recipient mint cap,
  and sets the EIP-1577 **contenthash** so a name can resolve to a Swarm site.
- Claiming is behind the **attendee gate**: hold a ticket, or be an organiser
  ([TICKETING.md § The attendee gate](./TICKETING.md#7-the-attendee-gate)).

### Why the Kernel and the registry must share a chain

A name holder proves control by answering **ERC-1271** — and the registrar's EIP-712 domain and
the holder's ERC-1271 answer have to be on the same chain, or a release cannot verify. That is
why `KERNEL_CHAIN_ID` and `SUB_ENS_DEFAULT_CHAIN_ID` are both `42161` and why
`packages/shared/test/kernel/chain.test.ts` pins them equal. They remain two constants with two
jobs; an address indexed by the wrong one is a valid-looking address on a chain the caller is not
on.

---

## Releasing and reclaiming

The registry carries `release` and `releaseWithSignature`, so a holder can give a name up —
including a smart-account holder, via a signature a relayer submits. The flow for changing a name
is **mint → bind → release**, in that order, so a user is never nameless mid-change.

Two records the chain cannot hold, and which therefore live server-side in
`.data/profile-names.json`:

1. **Which name is an account's *profile* name.** A registry says who **holds** a name, never
   what it is **for**, and the profile feed is client-signed.
2. **The rename cooldown clock.**

Losing that file **fails open** by design: cooldowns reset and the profile-name refusal stops
firing until each user re-binds. Nothing is lost that a user cannot redo. Note the clock
deliberately outlives the name it refers to — nothing deletes a record, because otherwise
`release old → mint new → bind` would read as a first bind and skip the cooldown.

Administrative reclaim is `adminTransfer` — **transfer-only, no timelock**, held by the Safe.

---

## What a name is *not* used for

**Social subjects are keyed by account ADDRESS, not by name.** A follow subject was briefly the
registry namehash of the holder's name, which keyed an audience to something that WoCo
governance, a re-minter and the parent name's custody could each move independently. It is now
derived from the account's address in `packages/shared/src/social/subject.ts`.

Read that as the general rule: a name is a **display and routing** primitive. Anything that must
survive a name changing hands keys off the address.

---

## Related

- [ARCHITECTURE.md § The chains](./ARCHITECTURE.md#3-the-chains-and-which-one-does-what)
- [PASSKEY_SMART_WALLET.md](./PASSKEY_SMART_WALLET.md) — the Kernel that claims gaslessly
- [SEO_PLAN.md](./SEO_PLAN.md) — names, custom domains and how sites are addressed
