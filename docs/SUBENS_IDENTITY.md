# Sub-ENS Identity Layer

`label.woco.eth` sub-names as the identity primitive for organiser brands and user profiles, minted
on **Arbitrum Sepolia (`421614`)**. Companion to [`BUILDATHON_SUBMISSION.md`](./BUILDATHON_SUBMISSION.md).

---

## What it is

A WoCo brand or profile is a **sub-ENS name** — `punkpub.woco.eth`, etc. — minted as an **ERC-721
token** via a [Durin](https://durin.dev) L2Registry. Because the name is an NFT:

- **Brand identity travels on transfer.** Sell the brand, and the name (and the reputation attached
  to it — see the [EAS social graph](./EAS_SOCIAL_GRAPH.md)) moves with it. This is the defining
  reason a name is an NFT and not a database row.
- **Ownership is resolved live from chain** (`L2Registry.ownerOf`), never cached at a parent. The
  social graph keys "who owns this brand" off the chain at read time, so a transfer is reflected
  immediately with no re-indexing.

The subject identifier for a name is its **node** (a `bytes32` namehash):

```
node = keccak256(abi.encodePacked(namehash("woco.eth"), keccak256(bytes(label))))
```

This is the same value used as the EAS **follow** subject, so a follow attaches to the name (and
therefore to whoever currently owns it).

## How a name is claimed

- **Passkey users claim gaslessly.** The user's ZeroDev Kernel session key calls the registrar's
  `registerWithPermit(...)` via a server-signed permit, sponsored by the paymaster — the user pays
  no gas and signs no raw transaction.
- **The registrar enforces availability** (`available(label)`), one canonical record per name, and
  sets the EIP-1577 **contenthash** so a name can resolve to a Swarm site.
- **One sub-ENS name per profile**, with a rename/re-link affordance, and the site builder can
  **reuse an existing name** or **route a name at an event** from the deploy step.

## On-chain addresses (Arbitrum Sepolia `421614`)

| Contract | Address | Notes |
|---|---|---|
| WoCo Registrar | `0x7c0DE55a1713e6C1a53Db50314C7CB608179aAf1` | `register` / `registerWithPermit` / `setContenthash` |
| L2Registry (Durin clone) | `0x41Fb196Ae7D65E06880A240c8d1B91245Fb84807` | ERC-721 `ownerOf`, contenthash resolver |

The registrar address is configured identically on the client and the server, and confirmed live
on-chain (the registrar holds the `register`/permit logic; the registry is a Durin-factory clone).
Both contracts are **source-verified on Arbiscan**.

## Honest state

- **Arbitrum Sepolia (testnet).** Mainnet (Arbitrum One) is a config swap.
- Public resolution of `label.woco.eth` through `.woco.eth.limo` is surfaced as "live soon" in the
  UI while the gateway resolver path is finalised; the name, ownership, and contenthash are all
  already on-chain and readable today.
