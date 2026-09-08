# Documentation index

This folder is nine months of design records, plans and handovers. Most of it was written to
capture a decision at the moment it was made, which makes it valuable and also means **age
matters**. This index sorts every tracked document by how much you should trust it today.

**Index reviewed 2026-09-08.** Dates are the last commit that touched the file.

> **Only `docs/*.md` and `docs/legal/*.md` are tracked.** Some documents on a developer's disk
> are deliberately gitignored (local plans and handovers, and the ops runbook). If a doc is
> referenced somewhere and you cannot find it, that is why.

---

## Start here

| Doc | What it covers |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | The system, layer by layer: what the server is for, which chain does what, how a request is authenticated, how an event is created and sold |
| [IDENTITY_AND_KEYS.md](./IDENTITY_AND_KEYS.md) | All five keys, sign-to-derive, the issuer-curve migration, sealed order envelopes, login methods |
| [SWARM_DATA_MODEL.md](./SWARM_DATA_MODEL.md) | Chunks and addressing, mutable feeds from immutable chunks, topic derivation, bands, postage, the gateway whitelist |
| [TICKETING.md](./TICKETING.md) | Manifests and Merkle roots, sale and mint, what makes a ticket genuine, the door, certificates |
| [SITE_BUILDER.md](./SITE_BUILDER.md) | How organiser websites are built, published and addressed |
| [SUBENS_IDENTITY.md](./SUBENS_IDENTITY.md) | `*.woco.eth` names, and how mainnet ENS resolves to an L2 registry |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Setup, tests, CI gates, conventions, traps |

### How this folder is organised

One subject, one owner. **[ARCHITECTURE.md](./ARCHITECTURE.md) is a map, not an encyclopaedia** —
it explains the system as a whole and then routes you to the document that owns each part. Detail
lives with its subject, so a fact has exactly one home and cannot drift between two copies.
Where a document is the **authority** for something (payout policy, fee arithmetic, the social
graph), everything else links to it rather than restating it.

That is why the overview is short on any single subsystem and the subsystem docs are long. If you
find the same fact stated in two places, that is a bug in the docs — fix it by deleting one and
linking.

---

## Authoritative — these win over anything that disagrees

| Doc | Authority over |
|---|---|
| [PAYOUTS.md](./PAYOUTS.md) | Payout policy. Manual, released after the event. |
| [PRICING_AND_EMAIL.md](./PRICING_AND_EMAIL.md) | **All** fee arithmetic (§7, §15–§17). Never restate a rate elsewhere. |
| [MARKETING_COMPLIANCE.md](./MARKETING_COMPLIANCE.md) | Marketing lists, consent, suppression, RFC 8058, the abuse gate. |
| [legal/](./legal/) | `DATA_INVENTORY`, `PRIVACY_POLICY`, `TERMS_OF_SERVICE`, `ORGANISER_TERMS`, `DATA_PROCESSING_ADDENDUM`, `COOKIE_NOTICE`. Imported by the web build at compile time, which is why they are tracked. |

---

## Current — reflects the system as built

### State and direction
| Doc | Date |
|---|---|
| [DEVLOG.md](./DEVLOG.md) — running history of completed work | 2026-09-06 |
| [NEXT.md](./NEXT.md) — the working order | 2026-09-06 |

The living launch plan is **GitHub issue #353**, not a file. Re-read it top-down rather than
trusting a snapshot.

### Payments, money, email
| Doc | Date |
|---|---|
| [PAYMENTS_INTEGRATION.md](./PAYMENTS_INTEGRATION.md) — Stripe mechanics, reservations, the ticket card | 2026-08-23 |
| [EMAIL_NEXT_HANDOVER.md](./EMAIL_NEXT_HANDOVER.md) — **start here for email work** | 2026-08-17 |
| [SES_MIGRATION_HANDOVER.md](./SES_MIGRATION_HANDOVER.md) · [SES_PRODUCTION_ACCESS.md](./SES_PRODUCTION_ACCESS.md) | 2026-08-02 |
| [CONTACT_MANAGEMENT_DESIGN.md](./CONTACT_MANAGEMENT_DESIGN.md) | 2026-07-28 |
| [EVENT_CREATION_ANTI_ABUSE.md](./EVENT_CREATION_ANTI_ABUSE.md) | 2026-06-17 |

### Storage and social
| Doc | Date |
|---|---|
| [SWARM_SOCIAL_PLAN.md](./SWARM_SOCIAL_PLAN.md) — **authoritative** on the Swarm-native social graph | 2026-08-21 |
| [COASTER_CREDITS_PLAN.md](./COASTER_CREDITS_PLAN.md) — the credits rail, and the design record for the frozen statement discipline | 2026-08-20 |
| [CLIENT_FEED_SIGNER_HANDOVER.md](./CLIENT_FEED_SIGNER_HANDOVER.md) — why users own their feeds | 2026-08-06 |
| [FEED_SIGNER_REVIEW_2026-07-02.md](./FEED_SIGNER_REVIEW_2026-07-02.md) — the review that kept sign-to-derive | 2026-07-02 |
| [CONTENT_FEED_VERSIONING_HANDOVER_2026-07-04.md](./CONTENT_FEED_VERSIONING_HANDOVER_2026-07-04.md) — versioned feeds | 2026-07-06 |
| [ETHERNA_INTEGRATION.md](./ETHERNA_INTEGRATION.md) · [ETHERNA_USER_CONTENT_HANDOVER.md](./ETHERNA_USER_CONTENT_HANDOVER.md) — the second storage origin | 2026-08-06 |
| [EVENTS_DIRECTORY.md](./EVENTS_DIRECTORY.md) — the chain-log directory + snapshot | 2026-07-17 |

### Identity, accounts, recovery
| Doc | Date |
|---|---|
| [PASSKEY_RECOVERY_PLAN.md](./PASSKEY_RECOVERY_PLAN.md) — guardian escrow, the envelope, the threat model | 2026-08-23 |
| [CROSS_DEVICE_RECOVERY.md](./CROSS_DEVICE_RECOVERY.md) — the portability envelope | 2026-06-21 |
| [RECOVERY_VERIFICATION_CHECKLIST.md](./RECOVERY_VERIFICATION_CHECKLIST.md) — the supervised test sequence | 2026-06-21 |
| [PASSKEY_SMART_WALLET.md](./PASSKEY_SMART_WALLET.md) — the Kernel design and the Option 1 / Option 2 call | 2026-09-03 |

### Sites, SEO, performance
| Doc | Date |
|---|---|
| [SEO_PLAN.md](./SEO_PLAN.md) — **authoritative** on SEO and custom domains | 2026-08-10 |
| [SEO_GUIDANCE.md](./SEO_GUIDANCE.md) | 2026-07-28 |
| [SITE_BUILDER.md](./SITE_BUILDER.md) — **current**: publish/deploy flow, feeds, quota | 2026-09-08 |
| [MULTI_PAGE_SITE_BUILDER.md](./MULTI_PAGE_SITE_BUILDER.md) — the original design record | 2026-05-01 |
| [SITE_EVENTS_CLIENT_SIGNED_HANDOVER.md](./SITE_EVENTS_CLIENT_SIGNED_HANDOVER.md) | 2026-07-13 |
| [PERF_BASELINE_ETH_LIMO.md](./PERF_BASELINE_ETH_LIMO.md) | 2026-07-28 |
| [self-hosted-setup.md](./self-hosted-setup.md) — running your own instance | 2026-02-25 |

### Security reviews
| Doc | Date |
|---|---|
| [CRYPTO_AUDIT_2026-04-08.md](./CRYPTO_AUDIT_2026-04-08.md) → [SECURITY_FIXES_2026-04-09.md](./SECURITY_FIXES_2026-04-09.md) | 2026-04 |
| [PLATFORM_SIGNER_AUDIT.md](./PLATFORM_SIGNER_AUDIT.md) — what the platform signer may touch | 2026-07-16 |
| [V1_RETIREMENT_HANDOVER.md](./V1_RETIREMENT_HANDOVER.md) — what the v1 claim rail removal deleted | 2026-08-09 |

---

## Built but switched off

The code exists; the flag is `false` in `packages/shared/src/features.ts`. Read the flag's own
comment first — it says what is missing and what turning it on would require.

| Doc | Flag |
|---|---|
| [CRYPTO_CLIENT_VERIFIABLE_PAYMENTS_PLAN.md](./CRYPTO_CLIENT_VERIFIABLE_PAYMENTS_PLAN.md) | `cryptoPaymentsAllowed` |
| [WOCO_AGENT_ARCHITECTURE.md](./WOCO_AGENT_ARCHITECTURE.md) · [AGENT_COMMERCE_SURFACE.md](./AGENT_COMMERCE_SURFACE.md) | `agentCommerceAllowed` — and the v1 mint path it used is **deleted**, so the rail refuses outright |
| [SHOP_AND_LOYALTY.md](./SHOP_AND_LOYALTY.md) | Shop and POS routes are live; the **USDC spend-permission rail** described here is the crypto side and is off |
| [ATTENDEE_GATE_RESALE_PLAN.md](./ATTENDEE_GATE_RESALE_PLAN.md) | The gate is live; resale is built and untested |

---

## Research and future work

Explorations, not descriptions of the system.

- [VERIFIABLE_SIGNER_ENCLAVE.md](./VERIFIABLE_SIGNER_ENCLAVE.md) — removing trust in the platform signer
- [WAKU_DISCOVERY.md](./WAKU_DISCOVERY.md) — peer-to-peer discovery
- [EMAIL_KERNELIZE_PLAN.md](./EMAIL_KERNELIZE_PLAN.md) · [EMAIL_WEB3AUTH_LOGIN.md](./EMAIL_WEB3AUTH_LOGIN.md)
- [CODEX_CONTEXT.md](./CODEX_CONTEXT.md) — a condensed brief for a coding agent

---

## Historical

Kept for provenance. **Do not build from these** — each is superseded by something above.

| Doc | Superseded by |
|---|---|
| [TECHNICAL_ARCHITECTURE.md](./TECHNICAL_ARCHITECTURE.md) (2026-02) | [ARCHITECTURE.md](./ARCHITECTURE.md), [IDENTITY_AND_KEYS.md](./IDENTITY_AND_KEYS.md), [SWARM_DATA_MODEL.md](./SWARM_DATA_MODEL.md), [TICKETING.md](./TICKETING.md) — it predates client-owned feeds, the issuer-curve migration, the v1 rail retirement and on-chain ticketing |
| [PASSKEY_AUTH.md](./PASSKEY_AUTH.md) (2026-02) | [PASSKEY_SMART_WALLET.md](./PASSKEY_SMART_WALLET.md) + [PASSKEY_RECOVERY_PLAN.md](./PASSKEY_RECOVERY_PLAN.md) |
| [EAS_SOCIAL_GRAPH.md](./EAS_SOCIAL_GRAPH.md) (2026-06) | [SWARM_SOCIAL_PLAN.md](./SWARM_SOCIAL_PLAN.md) — likes and follows left EAS |
| [STYLUS_AGGREGATOR.md](./STYLUS_AGGREGATOR.md) (2026-06) | Nothing — the on-chain trending engine went with EAS |
| [ONCHAIN_TICKETING.md](./ONCHAIN_TICKETING.md) (2026-06) | [TICKETING.md](./TICKETING.md). Its `WoCoEventV2` contract description is still accurate; the surrounding flow is not |
| [BUILDATHON_SUBMISSION.md](./BUILDATHON_SUBMISSION.md) · [DEMO.md](./DEMO.md) (2026-06) | The buildathon entry, as submitted |
| [LAUNCH_PLAN.md](./LAUNCH_PLAN.md) (2026-06) | GitHub issue #353 |
| [WoCo-Events-Architecture-2026-02-28.pdf](./WoCo-Events-Architecture-2026-02-28.pdf) | The February architecture deck |

### Superseded handovers

Each captured one migration as it happened. Useful as a record of *why*; not a description of the
system now.

`CLIENT_FEEDS_AUTH_KINDS_HANDOVER.md` · `CLIENT_FEEDS_EDITIONS_HANDOVER_2026-06-28.md` ·
`CLIENT_FEEDS_ETHERNA_HANDOVER_2026-06-27.md` · `EDITIONS_PUBLISH_SPEED_HANDOVER_2026-06-29.md` ·
`FEED_SIGNER_ESCROW_HANDOVER.md` · `WEB3AUTH_ESCROW_AND_REFRESH_HANDOVER_2026-07-02.md` ·
`WEB3AUTH_FEEDS_POSTAGE_HANDOVER_2026-07-02.md` · `WEB3AUTH_FEED_SIGNER_HANDOVER.md` ·
`WEB3AUTH_GUARDIAN_ESCROW_HANDOVER_2026-07-02.md` ·
`ZERODEV_SPONSOR_FOR_EVENT_REGISTRATION_HANDOVER.md`

---

## Conventions for this folder

- **Terse.** If a section grows past a screen, split it.
- **Record the *why*, including refutations.** What was rejected, and on what grounds, is the
  part nobody can reconstruct later.
- **One authority per subject.** If two documents could disagree about a number, one of them
  should point at the other instead of restating it.
- **Date what you write**, and say what it was verified against.
- **Nothing operational.** No SSH targets, no deploy commands, no secret handling. This
  repository is public.
