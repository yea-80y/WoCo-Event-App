# Coding-Agent Brief

Status (2026-10-05): rewritten. The earlier version described a product framing and rails
(EAS social graph, Stylus aggregator, Coinbase login, shop and loyalty, agent commerce,
"POD" credentials) that are deleted or switched off. Do not restore it from history.

This file is deliberately short. It points at the sources that are kept current instead
of duplicating them, so it cannot drift far.

## Read first, in this order

1. `CLAUDE.md` (repo root) - architecture, conventions, key file map, gotchas. Wins over
   any other doc when they disagree.
2. `docs/README.md` - index of every doc, sorted by how far to trust each.
3. `docs/ARCHITECTURE.md` - layers, trust boundaries, one ticket traced end to end.

The code is the ground truth. A doc that disagrees with it is the bug.

## Load-bearing facts (verify in code before relying on them)

- WoCo is event ticketing: Svelte 5 web app (`apps/web`), Hono server (`apps/server`),
  Swarm storage with no database, Arbitrum contracts (`contracts/`, a nested repo).
- Pre-launch: Stripe test keys, Web3Auth devnet, no real customers.
- Stripe card is the ONLY live payment method. Every other rail is behind a flag in
  `packages/shared/src/features.ts`, all currently `false`: free events, crypto payments,
  agent commerce, shops/POS, Coinbase login, organiser sending domains, badges. Flags gate
  UI and server validation together.
- There is no claim endpoint. A sale is reserve -> Stripe Checkout -> webhook -> fulfilment,
  which mints onchain on `WoCoTicketLedger` (Arbitrum Sepolia today; the same ledger is
  deployed on Arbitrum One, server not switched yet). See `docs/TICKETING.md`.
- Four keys per account, one identity seed. See `docs/IDENTITY_AND_KEYS.md`. The ed25519
  holder key is gone (#518); attendee data is sealed with X-Wing
  (`packages/shared/src/crypto/xwing.ts`, `sealed-box.ts`).
- Organising requires a passkey account (#768). The organiser area is called "Organiser".
- Likes and follows are Swarm-native statements on the user's own feed; EAS is deleted
  (`docs/SWARM_SOCIAL_PLAN.md`).
- Product noun is "object" (formerly called POD). CI fails on the old noun.
- Fees: never restate a rate. `docs/PRICING_AND_EMAIL.md` is the one place for them.

## Writing about WoCo

Say what is live and what is built but off. Do not present a flagged-off rail, a design
doc or a roadmap item as shipped.
