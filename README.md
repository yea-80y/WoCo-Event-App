# WoCo

**A decentralised event and ticketing platform.** Organisers create events, sell tickets by
card, publish their own websites, and email their attendees. Underneath, the app data lives on
[Swarm](https://www.ethswarm.org/) rather than in a database, tickets are on-chain slots plus
signed credentials, and users sign their own storage with keys the platform never holds.

**Live app:** [woco.eth.limo](https://woco.eth.limo/) · **API:** `https://events-api.woco-net.com`
· **Health:** [`/api/health`](https://events-api.woco-net.com/api/health)

> ### Status: pre-launch
> There are no customers and no real user data. Card payments run against Stripe **test** keys
> and email login runs against a Web3Auth **devnet** project — both are launch-day cutovers that
> discard their test-side accounts. Treat everything in the running system as disposable, and
> don't design compatibility paths for it.

---

## Start here

**→ [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is the place to start.** Its first section is
the whole system in about five minutes; the rest routes you to whichever part you need.

| If you want to… | Read |
|---|---|
| Understand the system | **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the mental model, the trust boundaries, one ticket traced through every layer |
| Know which key signs what, and why there are five | [IDENTITY_AND_KEYS.md](docs/IDENTITY_AND_KEYS.md) |
| Understand storage — chunks, feeds, addressing | [SWARM_DATA_MODEL.md](docs/SWARM_DATA_MODEL.md) |
| Follow a ticket from creation to the door | [TICKETING.md](docs/TICKETING.md) |
| See how organiser websites work | [SITE_BUILDER.md](docs/SITE_BUILDER.md) |
| Understand `*.woco.eth` names | [SUBENS_IDENTITY.md](docs/SUBENS_IDENTITY.md) |
| Get the repo running and land a change | [CONTRIBUTING.md](docs/CONTRIBUTING.md) |
| Find any other document | [docs/README.md](docs/README.md) — the full index, sorted by how much to trust it |

The docs follow one rule: **one subject, one owner.** `ARCHITECTURE.md` is a map and links out;
detail lives with its subject, so no fact is stated in two places where the copies could drift.

---

## Six things that surprise people

This section exists because the obvious mental model is wrong in six specific ways. Everything
here is expanded in the deep-dive docs.

**1. There is no database, but the server is not stateless either.**
Event content, profiles, sites, tickets-in-hand and social statements all live on Swarm. There
is no SQL, no Mongo, no Redis. But the server does keep about forty small JSON stores on local
disk under `.data/`, and a handful of them are *authoritative and not rebuildable* — losing
`onchain-events.json` stops all ticket sales; losing `event-attendees.json` means no organiser
can email their attendees again. "No database" describes the data model, not the operational
reality. See [ARCHITECTURE.md § What the server is for](docs/ARCHITECTURE.md#4-what-the-server-is-for).

**2. Users sign their own storage — but the server is more involved than that sounds.**
A profile, an event or a site is a **Single-Owner Chunk** signed in the browser by a key the user
owns. The server verifies the signature recovers to the claimed owner, pays for the storage with
the platform postage batch, and uploads it. It holds no user key, so it **cannot forge** a signed
object.

What it *can* do is worth knowing up front: most reads go **through** the API (the event
directory, the per-creator catalogue and event detail pages, with the server resolving the
creator's chunk as a relay), and a reader learns *which signer owns an event's chunk* from a
platform-signed carrier. So the accurate line is **"the server cannot author, but it can
misdirect"** — not "the server is untrusted". See
[ARCHITECTURE.md § Who trusts what](docs/ARCHITECTURE.md#13-who-trusts-what) and
[SWARM_DATA_MODEL.md](docs/SWARM_DATA_MODEL.md).

**3. Signing is secp256k1 end to end. One seed derives several keys — the seed is not a key.**
A parent wallet, a session key, and then a 32-byte **seed** established by a single EIP-712
signature. Independent keys derive from that seed, and only the derivation differs:

| Derived | Curve | Signs |
|---|---|---|
| **Issuing key** | secp256k1 | editions + manifests — what an organiser issues |
| **Encryption key** | X25519 | nothing; it *opens* sealed orders |

**Tickets are signed by the per-purchase burner key (secp256k1)** and verified against the
on-chain slot owner. `packages/shared/src/edition/types.ts` puts it plainly: *"no ed25519
anywhere on the issuer side"*. There used to be an ed25519 holder key here too; it signed
nothing on any launch path and is gone ([#518](https://github.com/yea-80y/WoCo-Event-App/issues/518)).
Two out-of-launch-scope rails — cert-possession challenges and credit statements — still specify
the curve in their frozen formats, so they derive it from the same seed on demand and drop it.
See [IDENTITY_AND_KEYS.md](docs/IDENTITY_AND_KEYS.md).

**4. Nothing signs an individual ticket.**
An organiser signs one **manifest** committing to a Merkle root over every edition in the
series. A ticket's authenticity comes from that root plus a membership proof — not from a
per-ticket signature. See [TICKETING.md](docs/TICKETING.md).

**5. Likes and follows are not on chain.**
They were EAS attestations on Arbitrum. They are now chain-free Swarm statements
(`woco.like.v1` / `woco.follow.v1`) written to the user's own feed, with counting left to
indexers who read public feeds. The EAS code still exists and two read surfaces still call it
([#475](https://github.com/yea-80y/WoCo-Event-App/issues/475),
[#476](https://github.com/yea-80y/WoCo-Event-App/issues/476)), which is a known inconsistency,
not a design. See [docs/SWARM_SOCIAL_PLAN.md](docs/SWARM_SOCIAL_PLAN.md).

**6. Card is the only live payment rail.**
The crypto rail, free events, agent commerce and Coinbase login are all built and all switched
off in `packages/shared/src/features.ts`. Flags gate the UI **and** server validation in
lockstep, so an old client cannot reach a disabled rail through the API. Read that file before
assuming a rail is reachable.

---

## Repo map

```
apps/web/              Vite + Svelte 5 (runes) + TypeScript — the platform UI.
                       Also builds three other bundles from the same source:
                         dist-multisite/  deployed organiser sites (standalone, no server)
                         dist-scanner/    door-scanner PWA (offline-capable)
                         dist-site/       single-site generator (legacy path)
apps/server/           Hono API — Swarm relay, auth verification, Stripe, email,
                       chain writes, ENS CCIP-Read gateway. ~35 route modules.
apps/registry/         World Computer Registry UI — on-chain content-hash verification.
packages/shared/       Types, frozen wire formats, crypto, topic derivation.
                       THE source of truth for anything both sides must agree on.
packages/embed/        Two framework-free IIFE bundles for third-party sites:
                       <woco-tickets> (guest Stripe checkout) and <woco-lap-count>.
contracts-stylus/      Rust/WASM Stylus like-aggregator (superseded with EAS).
contracts/             Solidity — a SEPARATE repo, see below.
docs/                  Design records, plans and handovers. Start at docs/README.md.
```

`contracts/` is **not part of this repo.** It is a nested Foundry checkout of
[yea-80y/WoCo-Contracts](https://github.com/yea-80y/WoCo-Contracts) (branch `master`, protected —
PRs only) and is gitignored here. `git status` at the monorepo root will not show changes to it;
commit and push there separately.

### Where to look in `packages/shared`

Anything with a signature or an address over it is defined once, in `packages/shared`, and both
workspaces import it. If you are tempted to restate a constant, don't — that is how the sub-ENS
registrar address silently drifted between client and server for months.

| Path | What lives there |
|---|---|
| `crypto/issuing.ts` | Issuing-key derivation, EIP-191 signing, issuer-binding proof |
| `crypto/ecies.ts` | The sealed envelope (X25519 + AES-256-GCM) |
| `edition/` | `woco.manifest.v2` + `woco.edition.v1` — the ticket/badge formats |
| `cert/` | `woco.cert.v1` — awarded certificates |
| `swarm/soc.ts` | Chunk addressing, versioned feeds, multi-chunk paging |
| `statement/discipline.ts` | The frozen rules every Swarm-native statement follows |
| `social/` | Likes and follows |
| `site/types.ts` | The site-builder schema |
| `sub-ens/addresses.ts` | Per-chain registry + registrar addresses |
| `features.ts` | Feature flags — read this first |

---

## Running it locally

```bash
node --version   # must be >= 24 (.nvmrc pins 24; CI and the Docker image match)
npm install      # workspace install from the repo root
```

```bash
npm run dev:web        # Vite dev server on :5173, proxies /api → :3001
npm run dev:server     # API on :3001 (see the warning below)
```

> **`npm run dev:server` tunnels to the production Bee node.** Anything you publish locally
> lands in the real platform feeds — the global event directory included. There is no local
> Bee in the dev loop. If you only need the UI, run `dev:web` against the deployed API instead.

Other builds:

```bash
npm run build:web        # production frontend
npm run build:server     # tsc typecheck + build
npm run build:embed      # both embed bundles
npm run build:multisite  # deployed-site runtime → apps/web/dist-multisite/
npm run build:scanner    # door-scanner PWA → apps/web/dist-scanner/
```

Server configuration is `apps/server/.env` — see `apps/server/.env.example`, which documents
every key. Never commit a populated `.env`.

**To exercise event creation and ticketing you need a Stripe test account.** Card payments are
on by default for a ticket tier and the server live-checks `charges_enabled` before allowing a
publish, so connect a Stripe Connect account (test mode with test identity is fine) via
**Dashboard → Payments**. To publish without Stripe, untick **Card payments** on the tier.

---

## Tests and CI gates

```bash
npm run check                # typecheck every workspace
npm test -w @woco/shared     # frozen formats, crypto, topic derivation (~33 files)
npm run test:server          # ~91 files — money paths, auth, concurrency
npm test -w @woco/web        # identity-derivation golden vectors
npm test -w @woco/embed      # lap-count honesty rules
```

`.github/workflows/ci.yml` runs, in order: typecheck shared → test shared → test web →
typecheck server → test server → typecheck web (`svelte-check`) → build web → test embed →
typecheck embed → build embed. Two gates are load-bearing and easy to skip by accident:

- **`npm run build:web` does not typecheck.** Vite strips types without checking them. Use
  `npm run check -w @woco/web` (svelte-check) — a `.svelte` file referencing an undeclared
  identifier bundles clean and fails at runtime.
- **Golden vectors pin identity derivation.** `apps/web/test` pins the derived keys for a fixed
  seed. If a crypto dependency bump changes them, every existing user's identity changes. Do not
  "update the expected values" to make that test pass.

---

## Conventions

The full set — TypeScript, Svelte 5 runes, hex and address rules, Hono specifics, commit style,
and the traps that have each cost a day — lives in
**[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)**. The four worth knowing before you read any code:

- **`packages/shared` is the single source of truth** for anything both sides must agree on
  byte-for-byte. Never restate a constant.
- **Feature flags gate the UI *and* server validation in lockstep.** A flag that only hides a
  button is not a flag.
- **Comments explain *why*.** This codebase is unusually heavily commented on purpose — most
  comments record a decision or a defect that the code alone cannot express. Read them before
  changing the code around them; several things that look like ceremony are load-bearing.
- **Branch → PR → green CI → merge.** `main` is protected, merges are squashed, so one PR is one
  revertible concern.

---

## Project history

WoCo was built for the Arbitrum Buildathon in mid-2026 and has moved on substantially since:
the v1 Swarm claim rail was retired in favour of an on-chain contract, the social graph left EAS
for Swarm, the issuer key changed curve, and both sub-ENS names and smart accounts moved to
Arbitrum One. The buildathon
documents are kept for provenance and are labelled as historical —
see [docs/README.md](docs/README.md#historical).
