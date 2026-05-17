# WoCo — Security Posture

Last reviewed: 2026-05-17

A plain-language summary of how WoCo handles your money, your tickets, and your identity.

---

## Credential safety

- **Wallet private keys never leave your browser.** Web3 wallets (MetaMask, WalletConnect, Para MPC) sign locally; only signatures cross the wire.
- **Session keys never leave your browser.** A short-lived (30-day) signing key is generated in your browser and stored encrypted in IndexedDB. It signs API requests but is unknown to our server.
- **Local browser accounts** are AES-256-GCM encrypted with a non-extractable device key held by your browser's Web Crypto. The raw key material is never accessible to JavaScript.
- **Passkeys** use platform biometrics; private material never leaves the secure enclave.

## Transport security (HTTPS)

- Frontend → API: HTTPS via Cloudflare Tunnel end-to-end (`events-api.woco-net.com`).
- Frontend → Swarm gateway: HTTPS (`gateway.woco-net.com`).
- ENS-hosted sites: HTTPS via `.eth.limo`.
- No HTTP fallback. No mixed content.

## Request authentication

- Every authenticated API request is signed with a canonical EIP-191 challenge:
  `woco-session-v1\n{METHOD}\n{path}\n{timestamp}\n{nonce}\n{sha256(rawBody)}`
- Server rebuilds the challenge from the verified raw bytes and verifies the session key signature.
- Timestamp window: ±5 minutes.
- **Nonce replay protection:** in-memory blacklist per session, TTL = 5 min (matches timestamp window). Acceptable trade-off: a server restart re-allows nonces that were within the last 5 minutes — documented gap, not exploitable in practice because the timestamp window still bounds the attack.

## Payments — risk model

### Stripe (cards)
- Charges happen **inside Stripe's network**, not via our server. We never see card numbers, and we cannot redirect funds.
- Worst case (webhook signing secret leak): an attacker forges `checkout.session.completed` events → free tickets get minted. The organiser loses **inventory**, not revenue. No money theft.
- Replay defence: each Stripe session ID is consumed exactly once (`.data/consumed-stripe-sessions.json`).
- Webhook signature tolerance: 1 hour (so Stripe's retry-on-timeout still verifies).

### Crypto (ETH, USDC on Base/Optimism/Mainnet)
- Signed payment quotes (HMAC-SHA256) lock the exact wei amount before payment — no client/server oracle race.
- Server verifies on-chain: tx hash + chain + exact amount + recipient + confirmations + `tx.from`.
- `tx.from` MUST equal the verified claimer address. For email/passkey claims, an EIP-191 signature binds the paying wallet to the claim (prevents mempool front-running).
- Each `txHash` is consumed exactly once (`.data/consumed-tx-hashes.json`).
- Confirmation thresholds: mainnet 12, L2s 3.

## Data on Swarm

- All event data lives on **Swarm** (decentralised storage). No traditional database.
- Buyer emails are stored as **HMAC-SHA256(email, secret)** — never plaintext, never reversible without the secret key.
- Order forms are encrypted with **libsodium SealedBox** to the organiser's ed25519 public key — only the organiser can decrypt.

## Directory integrity

- Public directory feeds (event listings, organiser pages) use a **strict read pattern**: only HTTP 404 from Swarm is treated as "empty/new". Transient errors refuse the subsequent write — preventing a network blip from wiping the directory.
- Empty results from transient failures are never cached (server-side or client-side).
- Client-side caches are user-scoped and cleared on logout (shared-device safety).

## POD ticket identity

- Each user derives a deterministic ed25519 signing key from an EIP-712 signature by their primary wallet. Same wallet → same POD key on any device.
- POD seed is encrypted in IndexedDB with a per-browser device key + AAD (Additional Authenticated Data) that binds it to the storage slot kind.
- Cross-identity decryption on a shared device is prevented by clearing the POD seed on logout and on wallet-account switch.

## Known gaps / future work

- **Persistent nonce store.** Replay blacklist is in-memory. A restart re-allows nonces within the active timestamp window (max 5 min). Not exploitable in practice; persistent store planned.
- **AAD identity binding.** Current AAD binds encrypted material to slot kind, not to the parent wallet address. Procedural clears on logout and wallet switch defend in depth; planned hardening will include the parent address in AAD so decryption fails cryptographically on identity transition.
- **Light-client verification.** Frontend currently trusts the platform feed signer. Planned: on-chain content-hash registry (World Computer Registry) so users can verify frontend authenticity without trusting our gateway.
- **Escrow contract.** `WoCoEscrow.sol` (Foundry-tested, ReentrancyGuard, 150bp fee) holds funds time-locked for organiser disputes. Audit round documented in `docs/CRYPTO_AUDIT_2026-04-08.md` and `docs/SECURITY_FIXES_2026-04-09.md`.

## Reporting

Security issues: open an issue on the public repository or contact the maintainer directly. No bug bounty programme yet.
