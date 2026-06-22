# Codex Context

This file is a lightweight handover for Codex sessions. It captures the current WoCo framing and
load-bearing project facts so future work does not need to rediscover them from scratch.

## Current Product Framing

WoCo is a decentralised event and commerce platform. It starts with events, tickets, organiser
websites, storefronts, and loyalty, but the broader thesis is open commerce infrastructure: identity,
payments, reputation, discovery, and credentials should be portable primitives rather than locked
inside centralised platforms.

The platform-tax framing matters, but it should not be the whole story. The stronger framing is:
WoCo gives organisers, communities, venues, brands, agents, and users programmable commerce rails
where users own their identity, payments are verifiable, and participation history can travel across
applications.

## Arbitrum Buildathon State

The Arbitrum Buildathon submission is documented in `docs/BUILDATHON_SUBMISSION.md`.

Buildathon work is on Arbitrum Sepolia and includes:

- `WoCoEventV2`: USDC on-chain ticketing with sponsor-gated claim paths.
- ZeroDev Kernel passkey smart wallets and scoped session keys.
- Coinbase Smart Wallet login support.
- `label.woco.eth` sub-ENS identities via Durin L2Registry.
- EAS likes and follows as a rebuildable on-chain social graph.
- Rust/WASM Stylus `LikeAggregator` that verifies EAS attestations on-chain.
- USDC shop and POD loyalty rails.
- Bounded, non-custodial AI-agent commerce: an agent buys a ticket using its own key and a user-granted
  spend permission enforced by the user's Kernel wallet.

Crypto payments and agent commerce are verified on-chain, but production customer crypto rails are
held back pending security audit.

## Blog Framing To Preserve

Arbitrum's June 2026 post, "The Architecture of the Programmable Economy", is enterprise-finance
oriented: predictable costs, compliance, confidentiality, ZK settlement, economic levers, Universal
Intents, sequencing/priority feeds, and the path from Arbitrum One to dedicated blockchains.

For WoCo, the best tie-in is not "Arbitrum wrote our exact thesis." It is:

Arbitrum is describing the infrastructure layer for programmable markets; WoCo is a concrete
consumer/community commerce instance of that architecture, where tickets, loyalty, profiles, agent
spend permissions, and social reputation become interoperable rails.

Avoid over-claiming unbuilt roadmap items. Be explicit about what is live on Arbitrum Sepolia versus
what maps to Arbitrum's future/dedicated-chain roadmap.

## Discord Context

The user's Arbitrum Discord framing emphasized open standards, portable identities, interoperable
POD credentials, sub-ENS identities, and positive network effects across teams. Example use cases:
event/forum gating, loyalty, sports attendance badges, digital mementos, venue/attraction credits,
proof of participation, gaming avatars/skins/achievements evolving from real-world participation,
hacker-house trust/reputation, marketplace/payment-link identity, and self-sovereign commerce.

This context should be central in future public writing. It is more distinctive than generic
"cheaper fees" or "platform tax" copy.
