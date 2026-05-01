# WoCo ↔ Etherna Integration

Status as of 2026-04-30. Source-of-truth for any future chat picking this up.

## Goal & Scope

Migrate WoCo's Swarm dependency from our self-hosted Bee node + bee-proxy
(`gateway.woco-net.com`, `192.168.0.144:3323`) to Etherna's hosted gateway
(`gateway.etherna.io`). End state: retire our local Bee entirely.

**Phased rollout** (this is the architecture the user explicitly stated —
do not propose alternatives unless the user asks):

| Phase | Main woco app (woco.eth.limo) | Site-builder events (deployed via woco.eth.limo) |
|---|---|---|
| **Now** | Our Bee + our batch — UNCHANGED | Etherna gateway + Etherna batch |
| **Later** | Migrate to Etherna | Already on Etherna |

Backend (`events-api.woco-net.com`) writes to **both** simultaneously during
the phased period — per-event routing is required.

The deployed event sites (loaded via `eth.limo`) bake `gateway.etherna.io`
into the bundle. eth.limo does NOT use a public gateway of its own — whichever
URL is baked in is what end-user browsers hit. This is a hard requirement.

Etherna's rate-limiting / abuse-protection is the bandwidth defence (we asked
Mirko about this — they have credits + presumably IP limits). User has
explicitly said: not our concern, do not architect around bandwidth.

## Auth — Etherna OAuth2 Password Flow

- Token endpoint: `POST https://sso.etherna.io/connect/token`
- API key shape: `<24-hex-id>.<64-alnum-secret>` — split on `.` into
  `username` / `password`
- `client_id`: `apiKeyClientId` (well-known, same for all integrators —
  confirmed by Mirko 2026-04-29)
- `scope`: `openid profile offline_access ether_accounts role userApi.gateway`
- Access token: 1h expiry. Refresh token: **single-use rotating** (each
  refresh returns a new `refresh_token` — old one dies). Confirmed 2026-04-30.

API key location: `apps/server/.env` as `ETHERNA_API_KEY=<id>.<secret>`.
**NEVER** in `API-key/` folder (gitignore doesn't cover that path).

## Batch (provisioned 2026-04-30)

- **batchID:** `fc957ecd8f3295eb5643fde37e59044445b509a8b77789b8412cbe8c3956bb9a`
- depth 20 (effective volume ~688 MB unencrypted, no erasure-coding)
- amount 37,818,576,000 PLUR/chunk (1.5× margin over 1-month TTL @ 48,635 PLUR/chunk/block)
- TTL ~45 days at provision time
- Cost: ~3.96 BZZ debited from Etherna credits

**Effective volume reference table** (corrected from official Swarm docs —
do not use theoretical/raw values):

| Depth | Effective (unencrypted, no EC) |
|---|---|
| 17 | 44.70 kB |
| 18 | 6.66 MB |
| 19 | 112 MB |
| 20 | 688 MB ← current |
| 21 | 2.60 GB |

Source: `https://docs.ethswarm.org/docs/concepts/incentives/postage-stamps`,
"Effective Utilisation Tables".

## Etherna Gateway API Surfaces

Three swagger specs at `gateway.etherna.io`:

1. `/openapi/swarm.json` — Bee-compatible (bytes, bzz, feeds, stamps, chunks, soc, pins)
2. `/openapi/swarmv1.json` — Swarm v1 (newer paths under `/ev1/`)
3. `/openapi/gateway03.json` — **Etherna-specific** (resources, offers, users, credit, batches)

Critical Etherna-specific endpoints (all under `/api/v0.3/`):

- `POST /resources/{reference}/offers` — make a hash publicly readable. No body. Bandwidth debits to caller's credits.
- `GET /resources/{reference}/isoffered` — boolean check
- `DELETE /resources/{reference}/offers` — un-offer
- `POST /resources/areoffered` — bulk check
- `GET /system/chainstate` — current `currentPrice` for batch sizing
- `POST /users/current/batches` — alt path to provision batches?
- `GET /users/current/credit` — check remaining credits

`POST /stamps/{amount}/{depth}` (Bee-compatible, swarm.json) works directly
and returns `{ batchID, txHash }`.

## "Offer a Resource" Mechanics — Verified

- 402 anonymous on any non-offered ref (`GET /bytes/{ref}`, `/bzz/{ref}/`, `/feeds/...`)
- After `POST /api/v0.3/resources/{ref}/offers`, that exact `ref` is anonymously readable
- Etherna team statement: *"If you offer a folder root manifest, this should propagate to the entire content"* — i.e. offering a `/bzz` upload manifest cascades to all files reachable through it. **One offer covers a multi-file static deploy.**
- For feed manifests specifically: **TBD by validation test** (in progress —
  see `apps/server/scripts/etherna-feed-test.ts`). Etherna team hedged
  ("don't remember if feeds are always readable but their content isn't for sure").

## Critical Gotchas

### 1. bee-js v11 `onRequest` hook does NOT mutate outgoing headers

`@ethersphere/bee-js@11.x` `BeeOptions.onRequest(req)` receives a **shallow
copy** of `req.headers`. Mutations on the copy don't reach axios. The pattern
in `apps/server/src/config/swarm.ts` (added 2026-04-29) is broken and would
silently fail to inject auth headers when `ETHERNA_ENABLED=true`. Verified by
inspection of `node_modules/@ethersphere/bee-js/dist/mjs/utils/http.js` and
test failure (401 on createFeedManifest).

**Source location of the bug:**
```js
// http.js — maybeRunOnRequestHook
options.onRequest({
  ...
  headers: { ...requestConfig.headers },  // <-- shallow copy, mutations lost
  ...
});
```

**Workaround that works:** register an axios request interceptor on bee-js's
*nested* axios instance (`@ethersphere/bee-js/node_modules/axios`, NOT the
root one — they're separate instances). Pattern proven in
`apps/server/scripts/etherna-feed-test.ts`:

```ts
import { createRequire } from "node:module";
const beeRequire = createRequire(
  new URL("../../../node_modules/@ethersphere/bee-js/", import.meta.url),
);
const beeAxios = beeRequire("axios");
beeAxios.interceptors.request.use((cfg) => {
  if (`${cfg.baseURL ?? ""}${cfg.url ?? ""}`.startsWith("https://gateway.etherna.io")) {
    cfg.headers = cfg.headers ?? {};
    cfg.headers.Authorization = `Bearer ${token}`;
  }
  return cfg;
});
```

Production wiring needs the same: `apps/server/src/config/swarm.ts` should
register the interceptor on bee-js's axios at module init, NOT use `onRequest`.

### 2. Anonymous reads — endpoint matrix

| Endpoint | Anonymous after offer? |
|---|---|
| `GET /bytes/{manifestRef}` | ✅ 200 (raw chunk) |
| `GET /feeds/{owner}/{topic}` | ❌ 401 (no anonymous path even after offer) |
| `GET /bzz/{manifestRef}/` | ⚠️ 400 if downstream chunks aren't valid manifests |
| `GET /bzz/{folderRoot}/{file}` | ✅ 200 (cascade verified) |

**Implication:** for live feeds to be anonymously readable via `/bzz`, the
chain must be all-manifests: feed payload = `/bzz` manifest ref (not raw
`/bytes` chunk ref). Our existing feeds use `uploadPayload` with 4096-byte
raw payload — needs adapting for the Etherna path.

### 3. Postage batch settle delay

`POST /stamps` returns 201 with `batchID` instantly, but the batch isn't
`usable: true` until ~25 confirmations on Gnosis (~2 min). Poll
`GET /stamps/{batchId}` until `usable: true`.

## Architecture Required

### Per-event routing — needs implementation

Single `ETHERNA_ENABLED=true|false` flag is **insufficient** — current scaffold.
Need:

```
Event metadata: { swarmTarget: 'wocoBee' | 'etherna', batchId, gatewayUrl }
↓
Backend swarm helpers route per-event:
  - getBee(target) → returns the right Bee client
  - requireBatch(target) → returns the right batch ID
  - bzzReadGateway(target) → for client-side build constants
```

Two Bee clients held in memory side-by-side. Auth interceptor only fires for
the Etherna gateway URL (do NOT inject bearer token into our Bee node calls).

Touch list:
- `apps/server/src/config/swarm.ts` — replace single getBee with target-aware
- `apps/server/src/lib/swarm/bytes.ts` — accept target param
- `apps/server/src/lib/swarm/feeds.ts` — accept target param
- `apps/server/src/lib/event/service.ts` — set target at event creation
- Event POD/JSON schema — add `swarmTarget` field
- Site-builder build pipeline — bake `gateway.etherna.io` as `VITE_GATEWAY_URL`
  for site-builder events, keep `gateway.woco-net.com` for the main app build

### Auto-offer on first feed write

Each new feed (per-event topics like `woco/event/{eventId}`,
`woco/pod/editions/{seriesId}`) needs ONE offer call at creation:

```
1. createFeedManifest(batchId, topic, owner) → manifestRef
2. POST /api/v0.3/resources/{manifestRef}/offers
3. Persist manifestRef somewhere readable by the deployed site
   (either bake into the bundle at deploy, or use a top-level directory
    manifest mapping eventId → feed manifest refs, also offered)
```

If validation test confirms offer-cascade for feed manifests: this is one-time
per feed. Otherwise: per-write offer step needed (worse but workable).

### Frontend feed read code change

`apps/web` and `packages/site-builder` currently use
`bee.makeFeedReader(topic, owner).downloadPayload()` — calls
`GET /feeds/{owner}/{topic}`, anonymous-blocked on Etherna.

Switch to manifest-rooted reads: `bee.downloadData(manifestRef)` (resolves to
`GET /bytes/{ref}` or `/bzz/{ref}` depending on shape). Manifest refs need to
be available to the bundle — either inlined at build time or via a directory.

## Open Questions / Deferred

- **Per-event offer lifecycle:** Test result determines whether we need a
  per-write offer call or just per-feed-creation. (Test in progress.)
- **Per-user Etherna credits:** OAuth Authorization Code flow so each
  organiser pays for their own storage. Deferred. Today: platform pays.
- **Refresh token rotation in `auth.ts`:** Need to update cache to STORE the
  new `refresh_token` returned on each refresh, not just the access token.
- **Rate limiting:** Etherna confirmed they have abuse protection on the
  gateway. Specific limits not enumerated. User said: not our problem, ship.

## Test Artefact

`apps/server/scripts/etherna-feed-test.ts` — standalone validation script.
Throwaway. Not wired into prod. Run with:

```
cd apps/server && export $(grep -v '^#' .env | grep ETHERNA_API_KEY | xargs) && npx tsx scripts/etherna-feed-test.ts
```

## What the User Has Said — Strong Preferences

- **Don't suggest `gateway.ethswarm.org` as a fallback for deployed events.**
  User explicitly rejected. Etherna baked-in is the answer.
- **Don't suggest keeping our Bee for end-user reads.** User explicitly rejected.
- **Don't over-architect for bandwidth.** User explicitly said Etherna's
  rate-limiting handles it.
- Keep responses lean. Heavy explorations burn user trust.
- Confirm before destructive / spending actions (real BZZ on batch purchases).

## Key Files

- `apps/server/src/config/swarm.ts` — Bee client singleton (needs rework for dual-routing)
- `apps/server/src/lib/etherna/auth.ts` — OAuth password-flow token client
- `apps/server/src/lib/swarm/bytes.ts` — `uploadToBytes` / `downloadFromBytes`
- `apps/server/src/lib/swarm/feeds.ts` — feed read/write + index cache
- `apps/server/src/lib/swarm/topics.ts` — topic derivation (won't change)
- `apps/server/.env` — `ETHERNA_API_KEY`, `ETHERNA_ENABLED`, `POSTAGE_BATCH_ID`
- `apps/server/.env.example` — documents Etherna vars
- `apps/server/scripts/etherna-feed-test.ts` — validation test (delete after Phase complete)
