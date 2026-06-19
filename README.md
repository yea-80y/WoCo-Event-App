# WoCo — Decentralised Event & Commerce Platform

**Live app:** [woco.eth.limo](https://woco.eth.limo/) · **API:** `https://events-api.woco-net.com`

WoCo lets organisers create events, sell tickets, and run a shop — with **no traditional database**
(all app data lives on [Swarm](https://www.ethswarm.org/) feeds) and an Ethereum-standards identity,
payments, and social layer. Attendees claim tickets with a wallet, a passkey, or just an email, and
pay by card or in USDC.

---

## 🚀 Arbitrum Buildathon Judges — Start Here

**One link to read first → [docs/BUILDATHON_SUBMISSION.md](docs/BUILDATHON_SUBMISSION.md)** — the
judge-facing summary with every contract address, transaction-hash evidence, and links to all spoke
docs below.

**▶ [Watch the 1-minute demo](https://github.com/yea-80y/WoCo-Event-App/releases/tag/v0.1-buildathon)** — an
AI agent autonomously buys a ticket in USDC from a bounded, non-custodial spend permission. On-chain
proof: [Arbiscan draw tx](https://sepolia.arbiscan.io/tx/0x3f21a88674ede7979ed7359a876f9537eafd211d0684359abb559bd218b2813d).

All on-chain work is **Arbitrum Sepolia (`421614`)**. This is a single **monorepo** — every contract
lives here (`contracts/` Solidity, `contracts-stylus/` Rust/WASM), no other repos to hunt through.

| Doc | Contents |
|---|---|
| [docs/BUILDATHON_SUBMISSION.md](docs/BUILDATHON_SUBMISSION.md) | **Start here** — addresses, tx evidence, links to all spokes |
| [docs/ONCHAIN_TICKETING.md](docs/ONCHAIN_TICKETING.md) | On-chain ticketing (`WoCoEventV2`, USDC) + smart wallets |
| [docs/PASSKEY_SMART_WALLET.md](docs/PASSKEY_SMART_WALLET.md) | Passkey smart wallet (ZeroDev Kernel) + gasless scoped session keys |
| [docs/SUBENS_IDENTITY.md](docs/SUBENS_IDENTITY.md) | Sub-ENS identity (Durin L2Registry) |
| [docs/EAS_SOCIAL_GRAPH.md](docs/EAS_SOCIAL_GRAPH.md) | EAS likes & follows |
| [docs/STYLUS_AGGREGATOR.md](docs/STYLUS_AGGREGATOR.md) | Stylus (Rust/WASM) trending engine |
| [docs/SHOP_AND_LOYALTY.md](docs/SHOP_AND_LOYALTY.md) | USDC shop, spend-permission rail, POD loyalty |
| [docs/WOCO_AGENT_ARCHITECTURE.md](docs/WOCO_AGENT_ARCHITECTURE.md) | Bounded non-custodial agent commerce |

---

## Demo

**▶ [Watch the agent-commerce demo (~1 min)](https://github.com/yea-80y/WoCo-Event-App/releases/tag/v0.1-buildathon)** — an AI agent autonomously buys an event ticket in USDC from a **bounded, non-custodial spend permission**: the user's funds never leave their wallet and the agent can't exceed its on-chain cap. On-chain proof: [Arbiscan draw tx](https://sepolia.arbiscan.io/tx/0x3f21a88674ede7979ed7359a876f9537eafd211d0684359abb559bd218b2813d). More: [docs/DEMO.md](docs/DEMO.md).

---

## What's in the platform

**Core ticketing platform**
- **Event + ticket creation** — organisers define events and ticket series; tickets are signed
  credentials (PODs) and stored on Swarm feeds.
- **Claiming, three ways** — wallet (EIP-712 session delegation), passkey/wallet-signed (EIP-191), or
  email (rate-limited, hashed). Optional organiser **approval flow**.
- **Always-on encryption** — every claim encrypts the order data for the organiser dashboard (ECIES:
  X25519 + AES-256-GCM); CSV export + webhook relay.
- **Passport / My Tickets**, composite ticket cards (PNG + shareable `/t/…` link), email delivery.
- **Embed widget** — a framework-free `<woco-tickets>` Web Component for external sites.
- **Multi-page site builder** — organisers publish standalone Swarm-hosted sites; no server at runtime.

**Payments**
- **Stripe Connect** (card) — the live rail for paying customers today (destination charges, 1.5%
  platform fee).
- **Crypto** — ETH/USDC with a signed-quote flow + on-chain verification (on-chain ticketing + USDC
  shop rails; see the buildathon docs). Built and **verified on-chain** (the agent draw settles real
  USDC), but intentionally **held back from real customers until a security audit** (not yet done).

**Identity & login**
- Web3 wallet (MetaMask / WalletConnect), **passkey smart wallet** (ZeroDev Kernel), **Coinbase Smart
  Wallet**, Para embedded wallet (email → MPC), and a local encrypted browser account.
- Three identity layers: primary wallet (secp256k1) → 30-day session key → POD identity (ed25519).

**Built for the Arbitrum Buildathon** (full detail + on-chain evidence in
[docs/BUILDATHON_SUBMISSION.md](docs/BUILDATHON_SUBMISSION.md))
- On-chain ticketing (`WoCoEventV2`, USDC), passkey + Coinbase smart wallets
- `label.woco.eth` **sub-ENS identity** (Durin L2Registry, ERC-721)
- **EAS social graph** — likes (events) + follows (profiles) as on-chain attestations
- **Stylus** (Rust/WASM) trending aggregator
- **USDC shop + POS** with a capped, non-custodial spend-permission rail and on-chain **POD loyalty**
- **AI-agent commerce** — an agent buys a ticket within bounds the user signs on-chain

## Architecture

```
apps/web/              # Vite + Svelte 5 (runes) + TypeScript frontend
apps/server/           # Hono API server (Swarm relay + auth + on-chain verify)
packages/shared/       # Shared types, POD schema, constants
packages/embed/        # <woco-tickets> Web Component (IIFE bundle)
packages/site-builder/ # Static site generator for organiser sites
contracts/             # Solidity: WoCoEventV2, WoCoRegistrar (sub-ENS), escrow, registry
contracts-stylus/      # Rust/WASM Stylus: LikeAggregator (trending)
```

- **No database.** App data is Swarm feeds; the EAS likes index and the Stylus read path are both
  rebuildable from chain, so the server is a droppable cache, not the source of truth.
- **Gasless on Arbitrum.** A ZeroDev Kernel + paymaster sponsor user actions (sub-ENS claims, likes,
  spend-permission draws), each scoped by an on-chain session-key policy.

## Getting started

```bash
npm install

npm run dev:server     # API server (opens an SSH tunnel to the Bee node, then tsx watch)
npm run dev:web        # Vite dev server on :5173 (proxies /api → server)

npm run build:web      # production frontend build
npm run build:server   # tsc typecheck + build
npm run build:embed    # IIFE embed bundle
```

Server configuration lives in `apps/server/.env` (see `apps/server/.env.example` for the full list of
keys — Bee node, postage, feed signer, payment/Stripe, and chain RPC settings). **Never commit a
populated `.env`.**

**To use the full app (event creation, ticketing, shop), set up a Stripe test account first.** Card
payments are on by default for a ticket tier, and the server live-checks Stripe `charges_enabled`
before allowing publish — so connect and verify a Stripe Connect account via **Dashboard → Payments**
(a Stripe **test-mode** account with test identity is fine). To publish without Stripe, untick **Card
payments** on the tier. This gate applies only to card payments — likes/follows and sub-ENS identity
need no Stripe.

## Documentation

The full buildathon doc index is in **[🚀 Judges — Start Here](#-arbitrum-buildathon-judges--start-here)**
above (submission summary + one spoke doc per component). Start with
[docs/BUILDATHON_SUBMISSION.md](docs/BUILDATHON_SUBMISSION.md).
