# Contract deployments

Every contract WoCo has deployed and still uses, by chain. **Verified onchain on 2026-10-05**
(code present at each address; ledger deploy times read from the deploy blocks). Sub-names and
the launch switch-over re-checked on 2026-10-23.

The authoritative records, with deploy blocks, constructor arguments and the addresses each
version replaced, live in the contracts repo:
[yea-80y/WoCo-Contracts `deployments/`](https://github.com/yea-80y/WoCo-Contracts/tree/master/deployments).
Inside this repo, code reads addresses from `packages/shared` (`sub-ens/addresses.ts`,
`kernel/*.ts`) and the server's environment, never from this page.

---

## Arbitrum One (chain 42161) - production

| Contract | Address | Role |
|---|---|---|
| WoCoTicketLedger | [`0xEa6Eb3E153164c451A3CCdc41e1D93Cc76Ba65A2`](https://arbiscan.io/address/0xEa6Eb3E153164c451A3CCdc41e1D93Cc76Ba65A2) | **The live ticket ledger.** One slot per sold ticket, owner-authorised transfers. Deployed 2026-09-25; the server mints on it since 2026-10-19. |
| WoCoRegistrar (sub-names v2.2) | [`0x2812A3F1Fe35C85a953248152eF41EeD5Dc9c12A`](https://arbiscan.io/address/0x2812A3F1Fe35C85a953248152eF41EeD5Dc9c12A) | Mints `*.woco.eth` names and relays holder-signed pointer and release writes. |
| L2Registry (sub-names v2.2) | [`0x00d0054Ca80d97014947CE97d58402EbED0946EE`](https://arbiscan.io/address/0x00d0054Ca80d97014947CE97d58402EbED0946EE) | `*.woco.eth` names as ERC-721 tokens, with their records. A minimal-proxy clone. Launch deploy, 2026-10-23. |
| WoCoGuardianHook | [`0xF43524473EBC651969BeCc748462ED27ed39d4Db`](https://arbiscan.io/address/0xF43524473EBC651969BeCc748462ED27ed39d4Db) | ERC-7579 hook that pins which guardian accounts may call a passkey account's recovery route, with real per-guardian revocation. No owner or admin. Same address on every chain (CREATE2). |

Admin roles on the ledger and the sub-name contracts are held by a Safe multisig. The platform
holds no key that can repoint someone's name (registrar v2.2).

## Arbitrum Sepolia (chain 421614) - test copies

| Contract | Address | Role |
|---|---|---|
| WoCoTicketLedger | [`0x6B9b93eFe44Ee729BC68158F5F59B4F7aA082972`](https://sepolia.arbiscan.io/address/0x6B9b93eFe44Ee729BC68158F5F59B4F7aA082972) | Same source as the Arbitrum One copy. Deployed 2026-09-24. Tickets sold before launch were minted here and still verify. |
| WoCoEventV2 | [`0x351070Aff6dECa449506a6eA6dC6cB84D13cAedf`](https://sepolia.arbiscan.io/address/0x351070Aff6dECa449506a6eA6dC6cB84D13cAedf) | The previous ticket contract. No transfer function. Tickets minted on it still verify; new registrations go to the ledger. |
| WoCoRegistrar / L2Registry (v2.2) | [`0x4E28BEB33BB5E4B952F749BfAc4985bb3b97F7BB`](https://sepolia.arbiscan.io/address/0x4E28BEB33BB5E4B952F749BfAc4985bb3b97F7BB) / [`0xAf3124EE7360c7B9FD06311102f635392da44886`](https://sepolia.arbiscan.io/address/0xAf3124EE7360c7B9FD06311102f635392da44886) | Test copies of the sub-name contracts. |
| WoCoGuardianHook | [`0xF43524473EBC651969BeCc748462ED27ed39d4Db`](https://sepolia.arbiscan.io/address/0xF43524473EBC651969BeCc748462ED27ed39d4Db) | As above. |

## Ethereum mainnet (chain 1)

| Contract | Address | Role |
|---|---|---|
| L1Resolver v2 | [`0xD9357945E2fc3bA586Cbc1Cdc2f79f0E512cFfD7`](https://etherscan.io/address/0xD9357945E2fc3bA586Cbc1Cdc2f79f0E512cFfD7) | The resolver for `woco.eth`. Answers for `*.woco.eth` by CCIP-Read (EIP-3668) from the Arbitrum One registry through our gateway, whose answers are signed and bound to their chain. Live since 2026-09-25. |

---

## Launch, 2026-10-23

WoCo launched on 2026-10-23: card payments are on Stripe live mode, tickets mint on the
Arbitrum One ledger, sign-in uses the Web3Auth mainnet project, and `*.woco.eth` names
started fresh on a new registry and registrar (the table above). Nothing from the test period
carried over: the names, organiser accounts and test sales of the old pair are retired.

Each event registration records the contract it was made on, so a ticket keeps verifying
against the contract that minted it (#563). `GET /api/health` reports which chain and
contract the server mints on (`ticketMinting`). See
[TICKETING.md](./TICKETING.md#3-sale-and-mint).

## Contracts we use but did not write

Passkey accounts are [ZeroDev](https://zerodev.app/) Kernel smart accounts on Arbitrum One
(ERC-4337, EntryPoint v0.7). The validators (ECDSA and WeightedECDSA) and the recovery action
are ZeroDev's shared contracts, and gas is sponsored through ZeroDev's Sponsorship Paymaster,
funded by WoCo's deposit, with our server deciding which operations qualify. Their addresses
are pinned in `packages/shared/src/kernel/`. See [PASSKEY_SMART_WALLET.md](./PASSKEY_SMART_WALLET.md).

## Retired

`WoCoEvent` (v1) on Arbitrum Sepolia and Base Sepolia, and the earlier sub-name versions (v1,
v2, v2.1), are recorded in the contracts repo with what replaced them. The pre-launch v2.2 pair
on Arbitrum One - registry `0x4c2265470e0134C0a2df6902ebcb5397a40102a8`, registrar
`0x5974bd7bb11C5a33B3d35996d4D95660F315fFaB` - was retired at launch: the registrar is no longer
enrolled on its registry and our sponsor is no longer authorised on it. Production uses none of
them; the server code still carries the v1 address as a default for unconfigured chains.
