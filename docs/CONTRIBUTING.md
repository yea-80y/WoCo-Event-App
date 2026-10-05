# Contributing

How to get the repo running, how to land a change, and the traps that have caught people before.

**Verified against `main` (94364b56) on 2026-10-05.**

---

## 1. Setup

```bash
node --version        # >= 24. .nvmrc pins 24; CI and the server Docker image match it.
git clone …
npm install           # from the repo root — this is an npm workspaces monorepo
npm run check         # typecheck shared, web, embed and registry. Do this first.
npm run build:server  # the SERVER typecheck - it has no `check` script (see below)
```

`npm run check` runs each workspace's `check` script, and `apps/server` has none: its typecheck
is `build:server` (`tsc` with `noEmit` - the server runs from source under `tsx`, so there is no
build output).

`packages/shared` ships **raw TypeScript** (`main: ./src/index.ts`). Consumers compile it, so
there is nothing to build there — only to typecheck.

### Running the frontend without a backend

This is the cheapest useful loop, and usually the right one:

```bash
# apps/web/.env
VITE_DEV_API_URL=https://events-api.woco-net.com
```

```bash
npm run dev:web       # :5173, /api proxied to VITE_DEV_API_URL
```

### Running the backend

```bash
npm run dev:server    # :3001
```

> **Read this before you run it.** `dev:server` (`apps/server/scripts/dev-with-tunnel.mjs`)
> opens an SSH tunnel to the **production** Bee node and gateway proxy, and `apps/server/.env`
> points `BEE_URL` at the tunnel. Anything you publish locally lands in the real platform feeds -
> the global event directory included. There is no local Bee in the dev loop, and the tunnel
> needs credentials you may not have.
>
> `npm run dev:notunnel -w @woco/server` skips the tunnel, but Swarm reads then fail unless
> `BEE_URL_FALLBACK` is set to a gateway.
>
> Both dev scripts blank `ATTENDEE_STAMPER_PRIVATE_KEY`, so a local checkout refuses with 503.
> Why: a second server stamping the production attendee batch would reuse its slots and evict
> live orders (#546).

Server configuration is `apps/server/.env`. `apps/server/.env.example` is 475 lines and documents
most keys with their rationale — read it rather than guessing, but **it is not complete**.

> **Known gap that will bite you.** The ticket-contract keys are **not in `.env.example`**:
> `WOCO_EVENT_CHAIN_ID`, `WOCO_EVENT_VERSION_{chainId}` and `WOCO_EVENT_ADDRESS_LEDGER_{chainId}`
> (`apps/server/src/lib/chain/event-contract.ts`). Production runs Arbitrum Sepolia (`421614`)
> with version `ledger` (`WoCoTicketLedger`); the code's built-in ledger address table is empty,
> so the ledger address must come from the env. Unset, the server defaults to chain `84532`
> (Base Sepolia) and version `v1` — a fresh local server registers events on a different contract
> on a different chain, with no warning. An unknown version string throws. Also without an entry
> of their own: `WOCO_SPONSOR_PRIVATE_KEY` (the ticket sponsor that mints; named only in
> comments) and `CHECKIN_PASS_SECRET` (door check-in).

Frontend configuration is `apps/web/.env*` (`VITE_` prefix); `apps/web/.env.production.example`
shows the production shape. **Never commit a populated `.env`.**

### To exercise event creation and ticketing

You need a **passkey account** and a Stripe **test** Connect account.

- **Passkey only (#768).** The organiser area opens only for a passkey account, and the server's
  Stripe connect, onboarding-link and account-session routes refuse any parent that is not a
  smart account. Why: attendee data is sealed to a key from the account's seed, and only a
  passkey roots that seed outside every email and wallet key.
- **Stripe is mandatory to publish.** Card is the only live payment method and free events are
  off (`packages/shared/src/features.ts`), so every tier has card payments and a price of at
  least `MIN_TICKET_PRICE` (1). The server live-checks `charges_enabled` before a publish. Connect
  and verify via **Organiser → Payouts** (test mode with test identity is fine). The server's
  refusal text still says "Dashboard → Payments".
- Sub-ENS names, profiles, likes and follows need an unlock (a ticket, Stripe verification or
  a confirmed invite - `apps/server/src/lib/gate/check.ts`), not a Stripe account as such.

### Other build targets

```bash
npm run build:web        # → apps/web/dist/  (app + the static ticket page, ticket.html)
npm run build:server     # tsc typecheck only (noEmit)
npm run build:embed      # BOTH embed bundles → packages/embed/dist/
npm run build:multisite   # → apps/web/dist-multisite/   multi-page website runtime
npm run build:site        # → apps/web/dist-site/        single-event page runtime
npm run build:scanner     # → apps/web/dist-scanner/     door-scanner PWA
npm run build:registry    # → apps/registry/dist/         World Computer Registry UI
```

`build:site` and `build:multisite` produce **different** bundles, and both are live. The server
bakes `dist-multisite/` into every published website (`routes/sites.ts`) and `dist-site/` into
every published event page (`routes/site.ts`). Building the wrong one is a recurring mistake,
and a change to shared site code (checkout, sealing, auth) needs both.

---

## 2. Tests

```bash
npm run check                # typecheck shared, web, embed, registry
npm run build:server         # typecheck server
npm test -w @woco/shared     # frozen formats, crypto, topics - 52 files
npm run test:server          # 163 files - money paths, auth, concurrency
npm test -w @woco/web        # 156 files - identity golden vectors + DOM-free app rules
npm test -w @woco/embed      # 5 files - lap-count honesty, checkout, seat hold, return
```

File counts as of 94364b56. Test counts grow fast; count them, do not trust this line.

Tests are plain `node --test` with `tsx` — no Jest, no Vitest.

`.github/workflows/ci.yml` runs: typecheck shared → test shared → test web → typecheck server →
test server → typecheck web → build web → test embed → typecheck embed → build embed. It does not
typecheck `apps/registry` or build `dist-site`, `dist-multisite` or `dist-scanner`. Actions are
pinned by commit SHA, and `npm ci --ignore-scripts` means no dependency runs code at install time
in CI — a future dependency that genuinely needs its install script will fail there, visibly,
which is the point.

### Three gates that are easy to skip by accident

**`npm run build:web` does not typecheck.** Vite and esbuild strip types without checking them,
so a `.svelte` file referencing an undeclared identifier bundles clean and fails at runtime — that
is exactly how a dead send button once reached a green CI run. Use
`npm run check -w @woco/web` (svelte-check).

**The same is true of `build:embed`.** The package compiled and shipped green while `tsc`
reported five errors, one of them a live `TypeError` on the claim path that sat undetected for
three weeks. `npm run check -w @woco/embed` gates at **zero** errors, deliberately not
ratcheting: a known-failing check is not a check, it is noise.

**Golden vectors pin identity derivation.** `apps/web/test` pins the derived keys for a fixed
seed. If a crypto dependency bump changes them, every existing user's identity has changed. **Do
not update the expected values to make the test pass** — work out what moved.

### Writing tests here

Two conventions worth adopting, both learned the hard way:

- **Test the rule, not a mock.** Where a decision matters, it is extracted into a DOM-free,
  store-free module so a `node:test` file can exercise it directly. `gate-denial.ts` is the model:
  it exists as its own module purely so the "is this 403 ours?" rule is testable without dragging
  in the Svelte auth store.
- **Then delete the guard and check the test notices.** A green suite is not coverage. A test
  that cannot fail is worse than no test, because it looks like a guarantee. One real example: a
  test guarding against a signature leaking into a log line could not fail, and the leak shipped
  anyway.

---

## 3. Landing a change

`main` is protected. Branch → PR → green CI → merge.

**One PR per independently revertible concern.** PRs land as a squash or a merge commit; either
way the PR *is* the revert unit. Two unrelated fixes in one PR cannot be undone separately.

- Merge `main` into your branch (or use GitHub's *Update branch*). Do not rebase-and-force.
- Check `git status` before **every** commit, and stage your own files explicitly. Concurrent
  sessions and terminals may share a checkout; `git add -A` has picked up someone else's work
  more than once, and a stash round-trip has silently dropped staged deletions.
- `contracts/` is a **separate repository** (see below). Commit there separately.

### Commit and PR style

Look at `git log --oneline` and match it. Titles are a statement about behaviour rather than
about the diff, ending with the issue number. Recent ones lead with the area (`Server:`, `App:`);
older ones use `type(scope):`. Both are fine:

```
Organising needs a passkey account (#746)
Server: an account seen co-owned never falls back to the counterfactual (#746)
feat(sub-ens): every name error reaches the user as a sentence
```

### Comments

This codebase is unusually heavily commented, on purpose, and the standard is specific:

- Comments record **why**, never what. A comment that paraphrases the line below it is noise.
- The highest-value comment explains a **decision or a defect** — what was tried, what broke,
  what the alternative was and why it lost. Much of the reasoning in `docs/` was reconstructed
  from these.
- If you remove a guard, remove its comment. If you add one, say what happens without it.

Read the comments around code you are changing before you change it. Several look like
opportunities for simplification and are load-bearing — the `VERSION_PROBE_WINDOW = 2` constant
and the `unhandledVersion` exhaustiveness guard both look like ceremony and are not.

---

## 4. `contracts/` is a different repository

```
contracts/  →  github.com/yea-80y/WoCo-Contracts   (Foundry, branch `master`)
```

It is a **nested checkout, gitignored by the monorepo.** `git status` at the root will not show
changes to it. `master` is protected — PRs only, enforced for admins, so never push to it
directly.

Solidity in there: `WoCoTicketLedger` (the live ticket ledger - the server mints on Arbitrum
Sepolia; also deployed on Arbitrum One, server not switched yet), `WoCoEventV2` and `WoCoEvent`
(its predecessors), `WoCoRegistrar` + `WoCoSubEnsDeployer` + `durin/` (sub-ENS), `WoCoEscrow`,
`ContentHashRegistry`, and `recovery/`. `contracts/deployments/*.json` is the record of what is
actually deployed where — treat those files as the source of truth for addresses.
[DEPLOYMENTS.md](./DEPLOYMENTS.md) is the readable summary.

`contracts-stylus/` (Rust/WASM) **is** in this repo, and holds the like-aggregator that was
superseded along with the EAS social rail.

---

## 5. Conventions

- **TypeScript strict everywhere.** Shared types live in `packages/shared` and are never
  duplicated. Restating a constant that both sides must agree on is how the sub-ENS registrar
  address silently drifted between client and server for months — the fix was one exported
  constant, so the compiler catches a disagreement instead of a paymaster silently refusing.
- **Svelte 5 runes** (`$state`, `$derived`, `$effect`) — not the stores API. **Initialise every
  field at declaration:** properties absent from the initial object literal are not reactive
  (write `approvalRequired: false`, never omit it).
- **API responses** are `{ ok: boolean, data?: T, error?: string }`.
- **Hex conventions:** Swarm refs are 64-hex **without** `0x`; Ethereum values **with**.
  Addresses are lowercase — feed topics are derived from them.
- **CSS** uses `var(--token)` from `app.css`. Never a hardcoded hex.
- **Feature flags** gate UI *and* server validation in lockstep, and must stay that way. A flag
  that only hides a button is not a flag.
- **Errors reach the user as sentences.** A raw code or a bare "failed" is a defect.

### Hono specifics

- `AppEnv` is the context type (`apps/server/src/types.ts`).
- Route order matters: register `GET /mine` **before** `GET /:id`, or "mine" matches as an id.
- Hono's default 404 returns plain-text `404 Not Found`, so a client's `resp.json()` throws
  `Unexpected non-whitespace character at position 4`. If you see that error, you hit an
  unregistered route.
- The canonical request challenge hashes **raw body bytes** — call `c.req.text()` before any
  parse. Why, and what it breaks:
  [IDENTITY_AND_KEYS.md § API authentication](./IDENTITY_AND_KEYS.md#9-api-authentication).

---

## 6. Things that have cost real time

| Trap | What happens |
|---|---|
| `Vite base` not `'./'` | Absolute paths break under Swarm `/bzz/` URLs. |
| Publishing from a local dev server | It writes to the **production** feeds. |
| Rebuilding `dist-site` instead of `dist-multisite` (or the reverse) | Websites bake `dist-multisite`, event pages bake `dist-site`. The one you skipped does not change, and organisers must re-publish to pick up either. |
| `npm run check` as the full typecheck | It skips the server. Run `npm run build:server` too. |
| `docker compose restart` after an env change | Reuses the env the container was *created* with and silently ignores `env_file` changes. Use `up -d`. |
| Deploying an empty gateway whitelist | Real data starts reading as **absent**, and absent looks clean to the erasure guards. |
| Planning a feed write off a lenient read | `null` means absent **or** transient, and those need opposite responses. |
| Two Bee nodes on one keystore | Irreversible feed corruption. |
| Assuming an issue number resolves in this repo | There are two repositories. A `#n` in a commit message may belong to either. |
| Closing keywords in an issue body | "filed not fixed: #470" auto-closed #470. Check issue state after every merge. |

---

## 7. Where the depth lives

`CLAUDE.md` is the always-loaded orientation file — short by design, and the closest thing to an
index of invariants. Then:

| Doc | For |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | The system, the trust model, the chains |
| [IDENTITY_AND_KEYS.md](./IDENTITY_AND_KEYS.md) | Keys, signing, login, sealed envelopes |
| [SWARM_DATA_MODEL.md](./SWARM_DATA_MODEL.md) | Chunks, feeds, topics, addressing |
| [TICKETING.md](./TICKETING.md) | Issuance → sale → mint → door |
| [PAYMENTS_INTEGRATION.md](./PAYMENTS_INTEGRATION.md) | Stripe mechanics |
| [PAYOUTS.md](./PAYOUTS.md) | **Authoritative** on payouts |
| [PRICING_AND_EMAIL.md](./PRICING_AND_EMAIL.md) | **Authoritative** on all fee arithmetic |
| [DEVLOG.md](./DEVLOG.md) / [NEXT.md](./NEXT.md) | What happened, and what is next |
| [README.md](./README.md) | The full document index |

Two docs are **authoritative** for their areas and win over anything that disagrees with them:
`PAYOUTS.md` for payout policy and `PRICING_AND_EMAIL.md` for fee arithmetic. Never restate a
rate outside them.

Operational detail — SSH targets, deploy commands, secret management — is deliberately **not in
this repository**. It lives in an untracked local runbook. This repo is public; keep it that way.
