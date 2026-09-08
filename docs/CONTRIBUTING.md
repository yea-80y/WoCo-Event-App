# Contributing

How to get the repo running, how to land a change, and the traps that have caught people before.

**Verified against `main` on 2026-09-08.**

---

## 1. Setup

```bash
node --version        # >= 24. .nvmrc pins 24; CI and the server Docker image match it.
git clone …
npm install           # from the repo root — this is an npm workspaces monorepo
npm run check         # typecheck everything. Do this first; it proves the install worked.
```

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

> **Read this before you run it.** `dev:server` opens an SSH tunnel to the **production** Bee
> node and `apps/server/.env` points `BEE_URL` at the tunnel. Anything you publish locally lands
> in the real platform feeds — the global event directory included. There is no local Bee in the
> dev loop, and the tunnel needs credentials you may not have.
>
> `npm run dev:notunnel -w @woco/server` skips the tunnel, but Swarm reads then fail unless
> `BEE_URL_FALLBACK` is set to a gateway.

Server configuration is `apps/server/.env`. `apps/server/.env.example` is 356 lines and documents
every key with its rationale — read it rather than guessing. Frontend configuration is
`apps/web/.env*` (`VITE_` prefix); `apps/web/.env.production.example` shows the production shape.
**Never commit a populated `.env`.**

### To exercise event creation and ticketing

You need a Stripe **test** Connect account. Card payments are on by default for a ticket tier and
the server live-checks `charges_enabled` before allowing a publish, so connect and verify an
account via **Dashboard → Payments** (test mode with test identity is fine). To publish without
Stripe, untick **Card payments** on the tier. The gate applies only to card payments — sub-ENS
names, profiles and social actions need no Stripe.

### Other build targets

```bash
npm run build:web        # → apps/web/dist/
npm run build:server     # tsc typecheck + build
npm run build:embed      # BOTH embed bundles → packages/embed/dist/
npm run build:multisite   # → apps/web/dist-multisite/   deployed-site runtime
npm run build:scanner     # → apps/web/dist-scanner/     door-scanner PWA
npm run build:site        # → apps/web/dist-site/        legacy single-site generator
```

`build:site` and `build:multisite` produce **different** bundles for **different** purposes. The
server bakes `dist-multisite/` into every published organiser site. Building the wrong one is a
recurring mistake.

---

## 2. Tests

```bash
npm run check                # typecheck every workspace
npm test -w @woco/shared     # frozen formats, crypto, topics — ~33 files
npm run test:server          # ~91 files — money paths, auth, concurrency
npm test -w @woco/web        # identity-derivation golden vectors
npm test -w @woco/embed      # lap-count honesty rules
```

Tests are plain `node --test` with `tsx` — no Jest, no Vitest.

`.github/workflows/ci.yml` runs: typecheck shared → test shared → test web → typecheck server →
test server → typecheck web → build web → test embed → typecheck embed → build embed. Actions are
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

**One PR per independently revertible concern.** Merges are squashed, so the PR *is* the revert
unit. Two unrelated fixes in one PR cannot be undone separately.

- Merge `main` into your branch (or use GitHub's *Update branch*). Do not rebase-and-force.
- Check `git status` before **every** commit, and stage your own files explicitly. Concurrent
  sessions and terminals may share a checkout; `git add -A` has picked up someone else's work
  more than once, and a stash round-trip has silently dropped staged deletions.
- `contracts/` is a **separate repository** (see below). Commit there separately.

### Commit and PR style

Look at `git log --oneline` and match it. Titles are `type(scope): what changed`, written as a
statement about behaviour rather than about the diff:

```
feat(sub-ens): pickers hide the profile name; rename waits for the cooldown
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

Solidity in there: `WoCoEventV2` (the live ticket ledger), `WoCoTicketLedger` (merged, not
deployed), `WoCoRegistrar` + `durin/` (sub-ENS), `WoCoEscrow`, `ContentHashRegistry`, and
`recovery/`. `contracts/deployments/*.json` is the record of what is actually deployed where —
treat those files as the source of truth for addresses.

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
- The canonical request challenge hashes **raw body bytes**. The server must call `c.req.text()`
  *before* any parse, and the client must hash exactly the bytes it sends.

---

## 6. Things that have cost real time

| Trap | What happens |
|---|---|
| `Vite base` not `'./'` | Absolute paths break under Swarm `/bzz/` URLs. |
| Publishing from a local dev server | It writes to the **production** feeds. |
| Rebuilding `dist-site` instead of `dist-multisite` | The published organiser sites do not change. |
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
