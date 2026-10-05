# WoCo

**A decentralised event and ticketing platform.** Organisers create events, sell tickets by
card, publish their own websites at `*.woco.eth` names, and email their attendees. Underneath,
app data lives on [Swarm](https://www.ethswarm.org/) rather than in a database, every ticket is
a slot on an Arbitrum ticket ledger checked against a signed batch, and users sign their own
storage with keys the platform never holds.

**Live app:** [woco.eth.limo](https://woco.eth.limo/) · **API:** `https://events-api.woco-net.com`
· **Health:** [`/api/health`](https://events-api.woco-net.com/api/health)

> ### Status: pre-launch
> There are no customers and no real user data. Card payments run against Stripe **test** keys,
> email login runs against a Web3Auth **devnet** project, and tickets mint on the ticket ledger's
> **Arbitrum Sepolia** copy. The Arbitrum One ledger is deployed and the app switches to it at
> launch, together with the other two. Treat everything in the running system as disposable.

---

## What works today

- **Organisers** use a passkey account, connect Stripe, and publish events with paid ticket
  types. Card is the only payment method.
- **Buyers** check out as guests by card, in the app or through the `<woco-tickets>` embed on an
  organiser's own site. Each ticket is minted onchain at fulfilment and emailed as a link to a
  static ticket page that works offline once opened.
- **At the door**, a scanner PWA verifies tickets against the onchain slot owner and admits each
  ticket once across every scanner. Refunded and charged-back tickets are refused.
- **Refunds and cancellations**: an organiser can cancel an event and refund every buyer;
  payouts are manual and released after the event ([PAYOUTS.md](docs/PAYOUTS.md)).
- **Sites and names**: organisers publish multi-page websites and event pages to Swarm, served
  at `<name>.woco.eth.limo`. Names are ERC-721 tokens on Arbitrum One, resolved from Ethereum
  mainnet.
- **Accounts**: attendees can unlock a profile, a name, likes and follows with a ticket, their
  own Stripe verification or a confirmed invite. Passkey accounts are Kernel smart accounts on
  Arbitrum One, where every passkey is an equal co-owner.
- **Email**: ticket delivery and organiser broadcasts through Amazon SES, with consent,
  suppression and one-click unsubscribe.
- **Privacy**: buyers' order details and organisers' contact lists are sealed so only the
  organiser can open them, and stored attendee data can be erased per order.

### Onchain

| Chain | Contracts |
|---|---|
| Arbitrum One | WoCoTicketLedger, sub-name registrar and registry (`*.woco.eth`), WoCoGuardianHook |
| Arbitrum Sepolia | WoCoTicketLedger (live until launch) and test copies |
| Ethereum mainnet | L1Resolver for `woco.eth` (CCIP-Read to Arbitrum One) |

Addresses, roles and explorer links: **[docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md)**.

---

## Start here

**→ [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is the place to start.** Its first section is
the whole system in about five minutes; the rest routes you to whichever part you need.

| If you want to… | Read |
|---|---|
| Understand the system | **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** - the mental model, the trust boundaries, one ticket traced through every layer |
| Know which key signs what, and why there are four | [IDENTITY_AND_KEYS.md](docs/IDENTITY_AND_KEYS.md) |
| Understand storage - chunks, feeds, addressing | [SWARM_DATA_MODEL.md](docs/SWARM_DATA_MODEL.md) |
| Follow a ticket from creation to the door | [TICKETING.md](docs/TICKETING.md) |
| Understand what a signed "object" is, and how it differs from a verifiable credential | [OBJECTS.md](docs/OBJECTS.md) |
| Find a contract address | [DEPLOYMENTS.md](docs/DEPLOYMENTS.md) |
| See how organiser websites work | [SITE_BUILDER.md](docs/SITE_BUILDER.md) |
| Understand `*.woco.eth` names | [SUBENS_IDENTITY.md](docs/SUBENS_IDENTITY.md) |
| Get the repo running and land a change | [CONTRIBUTING.md](docs/CONTRIBUTING.md) |
| Find any other document | [docs/README.md](docs/README.md) - the full index, sorted by how much to trust it |

The docs follow one rule: **one subject, one owner.** `ARCHITECTURE.md` is a map and links out;
detail lives with its subject, so no fact is stated in two places where the copies could drift.

---

## Seven things that surprise people

The obvious mental model is wrong in seven specific ways. Each is expanded in the deep-dive docs.

**1. There is no database, but the server is not stateless either.**
Event content, profiles, sites, tickets-in-hand and social statements all live on Swarm. There
is no SQL, no Mongo, no Redis. But the server keeps a few dozen small JSON stores on local disk
under `.data/`, and several are *authoritative and not rebuildable*: losing
`onchain-events.json` stops all ticket sales, and losing `event-attendees.json` means no
organiser can email their attendees again. "No database" describes the data model, not the
operational reality. See [ARCHITECTURE.md § What the server is for](docs/ARCHITECTURE.md#4-what-the-server-is-for).

**2. Users sign their own storage - but the server is more involved than that sounds.**
A profile, an event or a site is a **Single-Owner Chunk** signed in the browser by a key the user
owns. The server verifies the signature recovers to the claimed owner, pays for the storage, and
uploads it. It holds no user key, so it **cannot forge** a signed object.

What it *can* do is worth knowing up front: most reads go **through** the API, and a reader
learns *which signer owns an event's chunk* from a platform-signed carrier. So the accurate line
is **"the server cannot author, but it can misdirect"** - not "the server is untrusted". See
[ARCHITECTURE.md § Who trusts what](docs/ARCHITECTURE.md#13-who-trusts-what) and
[SWARM_DATA_MODEL.md](docs/SWARM_DATA_MODEL.md).

**3. Four keys per account, and one seed that is not a key.**
A parent account (wallet, passkey smart account or email login) and a session key that signs API
requests. Then a 32-byte **identity seed**: for wallets and email, the hash of one EIP-712
signature; for passkeys, derived from the passkey's PRF output with no signature at all. The
other keys derive from the seed:

| Derived from the seed | Curve | Does |
|---|---|---|
| **Issuing key** | secp256k1 | Signs ticket batches (manifests) - what an organiser issues |
| **Content-feed signer** | secp256k1 | Owns the user's Swarm feeds (profile, events, sites, likes) |
| **Encryption key** | X-Wing (ML-KEM-768 + X25519) | Signs nothing; opens sealed orders and contact lists |

Tickets themselves are signed by a single-use key per purchase and verified against the onchain
slot owner. There used to be a fifth, ed25519 key; it signed nothing on any launch path and is
gone ([#518](https://github.com/yea-80y/WoCo-Event-App/issues/518)). See
[IDENTITY_AND_KEYS.md](docs/IDENTITY_AND_KEYS.md).

**4. Nothing signs an individual ticket for the organiser.**
An organiser signs one **manifest** committing to a Merkle root over every ticket in a ticket
type. A ticket's authenticity comes from that root, the onchain registration and the onchain
slot owner - not from a per-ticket organiser signature. See [TICKETING.md](docs/TICKETING.md) and
[OBJECTS.md](docs/OBJECTS.md).

**5. Likes and follows are not onchain.**
They are chain-free Swarm statements (`woco.like.v1` / `woco.follow.v1`) written to the user's
own feed, with counting left to indexers that read public feeds. Writing one needs the same
unlock as a name. The earlier EAS attestation rail is deleted, and a CI test keeps it out. See
[SWARM_SOCIAL_PLAN.md](docs/SWARM_SOCIAL_PLAN.md).

**6. Card is the only live payment rail.**
Crypto payments, free events, shops and POS, badges, agent commerce, Coinbase login and organiser
sending domains are all switched off in `packages/shared/src/features.ts`. Flags gate the UI
**and** server validation in lockstep, so an old client cannot reach a disabled rail through the
API. Read that file before assuming a rail is reachable.

**7. Organising needs a passkey account.**
An organiser's attendee data is sealed to a key from the account's seed, and only a passkey
roots that seed outside every email and wallet key. So the app opens the organiser area only
for a passkey account, and the server refuses Stripe onboarding to anything but a smart account
(email and passkey smart accounts look alike to the server, so that half is the app's).
Attendees can use any login. See [PASSKEY_SMART_WALLET.md](docs/PASSKEY_SMART_WALLET.md).

---

## Repo map

```
apps/web/              Vite + Svelte 5 (runes) + TypeScript - the platform UI.
                       Also builds three other bundles from the same source:
                         dist-multisite/  deployed organiser sites (standalone, no server)
                         dist-site/       single-event pages (baked into each published page)
                         dist-scanner/    door-scanner PWA (offline-capable)
apps/server/           Hono API - Swarm relay, auth verification, Stripe, email,
                       chain writes, ENS CCIP-Read gateway. ~36 route modules.
apps/registry/         World Computer Registry UI - onchain content-hash verification.
packages/shared/       Types, frozen wire formats, crypto, topic derivation.
                       THE source of truth for anything both sides must agree on.
packages/embed/        Two framework-free IIFE bundles for third-party sites:
                       <woco-tickets> (guest Stripe checkout) and <woco-lap-count>.
contracts-stylus/      Rust/WASM Stylus like-aggregator. Unused since likes left the chain.
contracts/             Solidity - a SEPARATE repo, see below.
docs/                  Design records, plans and handovers. Start at docs/README.md.
```

`contracts/` is **not part of this repo.** It is a nested Foundry checkout of
[yea-80y/WoCo-Contracts](https://github.com/yea-80y/WoCo-Contracts) (branch `master`, protected -
PRs only) and is gitignored here. `git status` at the monorepo root will not show changes to it;
commit and push there separately.

### Where to look in `packages/shared`

Anything with a signature or an address over it is defined once, in `packages/shared`, and both
workspaces import it. If you are tempted to restate a constant, don't - that is how the sub-name
registrar address once drifted between client and server for months.

| Path | What lives there |
|---|---|
| `crypto/issuing.ts` | Issuing-key derivation, EIP-191 signing, issuer-binding proof |
| `crypto/feed-signer.ts` | The content-feed signer, derived from the same seed |
| `crypto/xwing.ts`, `crypto/sealed-box.ts` | The X-Wing encryption key and the sealed box (HPKE) |
| `crypto/passkey-prf.ts` | The passkey seed from the PRF output (labels frozen) |
| `edition/` | `woco.manifest.v2` + `woco.edition.v1` - the ticket formats |
| `cert/` | `woco.cert.v1` - awarded certificates (outside launch scope) |
| `swarm/soc.ts` | Chunk addressing, versioned feeds, multi-chunk paging |
| `statement/discipline.ts` | The frozen rules every Swarm-native statement follows |
| `social/` | Likes and follows |
| `kernel/` | Passkey smart accounts: chain, co-owner validators, recovery contracts |
| `site/types.ts` | The site-builder schema |
| `sub-ens/addresses.ts` | Per-chain sub-name registry and registrar addresses |
| `features.ts` | Feature flags - read this first |

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
> lands in the real platform feeds - the global event directory included. There is no local
> Bee in the dev loop. If you only need the UI, run `dev:web` against the deployed API instead.

Other builds:

```bash
npm run build:web        # production frontend
npm run build:server     # tsc typecheck (noEmit)
npm run build:embed      # both embed bundles
npm run build:multisite  # deployed-site runtime → apps/web/dist-multisite/
npm run build:site       # single-event page runtime → apps/web/dist-site/
npm run build:scanner    # door-scanner PWA → apps/web/dist-scanner/
```

Server configuration is `apps/server/.env` - see `apps/server/.env.example`, which documents
every key. Never commit a populated `.env`.

**To exercise event creation and ticketing** you need a passkey account and a Stripe Connect
account in test mode (test identity is fine), connected from the organiser dashboard. Every
ticket type must be paid by card (free events are off, and there is a minimum ticket price), and
the server live-checks `charges_enabled` before it allows a publish.

---

## Tests and CI gates

```bash
npm run check                # typecheck shared, web, embed and registry
npm run build:server         # typecheck the server (it has no check script)
npm test -w @woco/shared     # frozen formats, crypto, topic derivation (~50 files)
npm run test:server          # ~160 files - money paths, auth, concurrency
npm test -w @woco/web        # ~150 files - identity golden vectors, auth, UI logic
npm test -w @woco/embed      # lap-count honesty rules
```

`.github/workflows/ci.yml` runs, in order: typecheck shared → test shared → test web →
typecheck server → test server → typecheck web (`svelte-check`) → build web → test embed →
typecheck embed → build embed. Two gates are load-bearing and easy to skip by accident:

- **`npm run build:web` does not typecheck.** Vite strips types without checking them. Use
  `npm run check -w @woco/web` (svelte-check) - a `.svelte` file referencing an undeclared
  identifier bundles clean and fails at runtime.
- **Golden vectors pin identity derivation.** `apps/web/test` pins the derived keys for a fixed
  seed. If a crypto dependency bump changes them, every existing user's identity changes. Do not
  "update the expected values" to make that test pass.

---

## Conventions

The full set - TypeScript, Svelte 5 runes, hex and address rules, Hono specifics, commit style,
and the traps that have each cost a day - lives in
**[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)**. The four worth knowing before you read any code:

- **`packages/shared` is the single source of truth** for anything both sides must agree on
  byte-for-byte. Never restate a constant.
- **Feature flags gate the UI *and* server validation in lockstep.** A flag that only hides a
  button is not a flag.
- **Comments explain *why*.** This codebase is unusually heavily commented on purpose - most
  comments record a decision or a defect that the code alone cannot express. Read them before
  changing the code around them; several things that look like ceremony are load-bearing.
- **Branch → PR → green CI → merge.** `main` is protected, and one PR is one revertible
  concern.

---

## Project history

WoCo started in early 2026 and has changed substantially since: the v1 Swarm claim rail was
retired in favour of an onchain ticket ledger, the social graph left EAS for Swarm, the issuer
key changed curve, signed data once called "PODs" is now called **objects**
([why](docs/OBJECTS.md#why-not-pod)), organisers moved to passkey accounts, and both names and
smart accounts moved to Arbitrum One. Older design records are kept for provenance and labelled
as historical - see [docs/README.md](docs/README.md#historical). The running history is
[docs/DEVLOG.md](docs/DEVLOG.md).
