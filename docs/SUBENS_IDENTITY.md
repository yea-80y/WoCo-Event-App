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

Names are browsable at `<label>.woco.eth.limo`. That suffix is `SUB_ENS_WEB_SUFFIX` in
`packages/shared/src/sub-ens/web.ts` and appears **nowhere else** — a test fails if a literal
reappears under `apps/web/src`. It has moved before (a day on `.link` over a misread of eth.limo's
on-demand certificates), which is exactly why it is a single constant. eth.limo issues a
subname's certificate at its first TLS handshake, only once the name resolves to a contenthash,
and rate-limits the ask per hostname — so the server warms it once after every contenthash
receipt, and nothing should link to a name before that.

---

## Where it lives

Names are on **Arbitrum One (`42161`)** — mainnet. Every real name lives there, and `woco.eth`'s
L1 resolver answers from that registry.

| | Address |
|---|---|
| `SubENSRegistry` (L2Registry v2.2 clone, since 2026-09-21) | `0x4c2265470e0134C0a2df6902ebcb5397a40102a8` |
| `WoCoRegistrar` | `0x5974bd7bb11C5a33B3d35996d4D95660F315fFaB` |
| L2Registry implementation | `0x44F3CE28DFb86d6827637D6b3E55D4111cA55367` |
| `L1Resolver` v2 (Ethereum mainnet, since 2026-09-25) | `0xD9357945E2fc3bA586Cbc1Cdc2f79f0E512cFfD7` |
| `L1Resolver` v1 (kept only as the rollback target) | `0x172031E6a8428617B05F2002e0e278bb8fb3Ed8A` |
| woco.eth's own records (the apex fallback: ENS Public Resolver) | `0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63` |
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
    (v2: the signed hash also binds chain id 1, so the gateway signs per resolver -
    ENS_GATEWAY_RESOLVER_ADDRESSES entry `0xADDR:1` for v2, bare `0xADDR` for v1)
```

Step 4 is the security-critical one: **a signature from that key over any `result` is
authoritative resolution for any name under the parent.** There is no second opinion. So every
refusal in `apps/server/src/lib/ens-gateway/ccip.ts` is a security control, not input
validation — nothing is signed until the request has been proved to be about a name this gateway
may answer for, and the answer has come from the registry rather than from the request.

`/api/health` reports the gateway's live configuration: `signer`, `chainId`, `registry`, `parent`
and a `crossCheck` flag.

---

## Claiming a name, and pointing it

- **The platform mints, for every login kind.** `POST /api/sub-ens/claim` sends
  `register(label, holder)` from the NAMES sponsor key (`SUB_ENS_SPONSOR_PRIVATE_KEY`, never the
  events key). The name is minted EMPTY: its holder and the holder's own address records, no
  contenthash and no text records.
- The registrar enforces availability, the label rules, a per-recipient mint cap and a
  registrar-wide cap (300 an hour at deploy, the leaked-key detector; `mint_global_cap` → 503).
- **What a name points at is the holder's signature, never the platform's** (registrar v2.2).
  The holder signs EIP-712 `SetContenthash` (`"WoCo Registrar"`/`"1"`; name, node, contenthash,
  per-name nonce, expiration) and `POST /api/sub-ens/set-contenthash` relays it; no WoCo key can
  repoint a name. It is asked for once, at BIND: a site name points at the site's feed manifest,
  which every publish advances, so publishing never needs a chain write or a prompt. A profile
  name points at the app (`SUB_ENS_APEX_CONTENTHASH`) and nowhere else. Web3 wallets sign
  directly; passkey and web3auth sign as their Kernel (ERC-1271); a Coinbase Smart Wallet's
  signature only verifies on Base, so its holder will act by its own transaction.
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

### Registry v2.2 rules (they arrive with the v2.2 cutover)

After audit 950 the registry refuses ERC-721 delegation, because a name's holder has every power
over it and an approval let the approvee become the holder. What that means in practice:

- **No approvals.** `approve` and `setApprovalForAll` always revert `DelegationNotSupported()`,
  and only a name's holder moves it. Names cannot be listed on approval-based marketplaces. A
  sale is the holder's own transfer, or a push into an escrow contract that pays the seller and
  hands the name on in the same transaction (proven in the contracts suite, not built). Listing is
  a change of holder, so it resets the name's records while it is listed.
- **Custody is push-only, and not custodial-safe.** A vault receives a name by its holder's
  `safeTransferFrom`. The admin can still `adminTransfer` it, and the holder of the name above can
  still take or release it, whoever holds it.
- **An admin handover drops every registrar,** WoCoRegistrar included. The incoming admin's
  acceptance is therefore ONE executor batch, `[acceptAdmin(), addRegistrar(WoCoRegistrar)]`.
  Accepted alone, new names and relayed pointer writes stop (the server answers 503) until the second
  call lands; existing names keep resolving. The `subEns.minting` health section alarms on it.
- **No public `multicall`.** A smart-account holder batches record writes in its own user
  operation.

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
