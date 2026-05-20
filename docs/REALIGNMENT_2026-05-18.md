# Realignment — 2026-05-18

Handover doc. Pick up in a new chat from here.

---

## Shipped this session

- **bee-proxy patched & deployed** — `/bzz` and `/bytes` now forward `swarm-redundancy-level`, `swarm-encrypt`, `swarm-deferred-upload`, `swarm-pin`, `swarm-tag`. CORS allow-list expanded. Verified end-to-end with EC level 1.
- **Three speed-test scripts** under `apps/server/scripts/`:
  - `gateway-speed-test.ts` — /bytes upload+download, woco vs Etherna
  - `gateway-bzz-speed-test.ts` — /bzz collection + anonymous read
  - `gateway-concurrent-test.ts` — 20-parallel asset fan-out (real-site UX)
- **Etherna test batch script** ready but **not run yet**: `apps/server/scripts/etherna-test-batch.ts`
- **`apps/server/src/routes/sites.ts`** patched locally (inline-SOC feed write, fixes Mirko's legacy SOC issue) — **not deployed to server yet**

---

## Speed-test results (TL;DR)

| Test | woco | etherna | Winner |
|---|---|---|---|
| /bytes upload 5MB | 2.2s | 4.7s | woco (2× faster) |
| /bytes download 5MB | 14s | 4.7s | **etherna (3× faster)** |
| /bzz GET asset 5MB | 13.4s | 2.9s | **etherna (4.7× faster)** |
| Concurrent 20-asset fan-out (5MB total) | 13.2s wall, 13s p95 | 8.7s wall, 8.7s p95 | **etherna** |

**Root cause of slow woco downloads:** home-broadband upload bandwidth via CF tunnel. Bee proxy itself streams correctly (not buffering). **Hetzner migration should close the gap** (datacenter gigabit upload vs UK home ~50Mbps).

**Decision:** for now, all deployed content goes through Etherna gateway + Etherna batches. Revisit post-Hetzner.

**Hetzner migration:** owner planned for "later today" (2026-05-18). After it lands, re-run the three speed-test scripts to validate the gap closes. See `docs/HETZNER_DEPLOY.md`.

---

## Decisions captured (need to be re-saved to memory)

### Batch model

| Scenario | Gateway | Batch |
|---|---|---|
| Creator deploys a **website** (paid hosting) | Etherna | New batch bought per user → `etherna-batches.json[addr]` |
| Standalone event AND creator has website batch | Etherna | **Reuse their website batch** |
| Standalone event AND no website batch | Etherna | **Shared platform Etherna batch** |
| Free events | — | **Not allowed for now** |
| Crypto payments | — | **Not allowed for now** |

**Platform batch transition plan:**
1. Launch with existing `fc957ecd…` (free, ~688MB, ~4 weeks TTL left)
2. Monitor utilisation weekly
3. If <100MB after 2 weeks → buy smaller batch (depth 18 or 19), flip `ETHERNA_PLATFORM_BATCH` constant
4. Old batch content stays readable until TTL out (~mid-June)

**Batch sizing math** (per `apps/server/scripts/etherna-chainstate.ts` live result, 2026-05-18):
- `currentPrice = 53,487 PLUR/chunk/block`, Gnosis 5s/block, 17,280 blocks/day
- Depth 17 = ~0.045 MB usable, depth 18 = ~6.66 MB, depth 19 = ~112 MB, depth 20 = ~688 MB
- 30-day, +25% margin, depth 19 ≈ 0.062 BZZ (very cheap given we have ~50 xDai of free credits)
- 24h test batch at depth 18 +50% margin = trivial spend — script ready at `etherna-test-batch.ts` (hard cap $1 xDai)

**Hosting model:** sell 1-year hosting up front, buy postage 1 month at a time. Auto-renewal NOT being built — owner will check if someone else has built it first.

**Flexibility — "per-user batch on signup" later:** one env flag, no refactor:
```
BATCH_PER_USER_AUTO_PROVISION=false
```
When true, `batchForDeploy()` auto-buys per user on first call instead of falling back to platform.

### Event creator changes (no free events, Stripe-only)

- Feature flags in `packages/shared/src/index.ts`:
  ```ts
  export const FEATURES = {
    freeEventsAllowed: false,
    cryptoPaymentsAllowed: false,
  };
  ```
- Defaults flip: `isPaid: true`, `cryptoEnabled: false`, `stripeEnabled: true`
- Hide "Paid ticket" toggle when `!freeEventsAllowed`
- Hide entire crypto block when `!cryptoPaymentsAllowed`
- Price required, publish blocked if empty / ≤0
- **Keep buyer-pays toggle** — owner's call
- **Fee structure (confirmed):**
  - Default 10% when buyer-pays toggle ON
  - **Floor: 4.5%** (3% Stripe + 1.5% WoCo) — UI snaps anything lower back to floor
  - **No ceiling** — organiser can set any value ≥ 4.5%
- Importer (Skiddle/Fatsoma): reject 0-price tier (best-effort — importer accuracy is known-iffy)

### Server defence-in-depth

In `apps/server/src/routes/events.ts`, validate before write:
- Every series has `payment` config
- `payment.stripeEnabled === true`
- `payment.cryptoEnabled === false`

Reject with clear error → prevents an old client or direct API call from bypassing UI.

### Site deploy → Etherna

- `apps/server/src/routes/sites.ts` deploy path posts to local Bee proxy today. Add Etherna code path:
  - Tar + `POST /bzz` against Etherna with OAuth + router-chosen batch
  - `POST /api/v0.3/resources/{ref}/offers` to make anonymously readable
  - Inline-SOC feed write (already patched locally)
- **Keep gateway picker** visible for testing — do NOT hide it

### Standalone event page

Clarified: legacy "site-builder event" — single-page deployable event with own BZZ hash + standalone URL that organiser can DNS/ENS-point. Options: add to existing site OR get standalone link/hash. Uses batch router (per-user-batch if exists, else platform).

### Embed widget — verify before launch

- `packages/embed/` exists (~71KB IIFE) — Eventbrite-style box on organiser's website
- Devlog says wallet claims disabled in embed (session delegation not wired)
- **For Stripe-only email path, no session needed** — should "just work"
- Need to test current embed loads + can claim a Stripe-only paid ticket
- Document snippet for organisers
- If session delegation is the blocker, treat as separate task

### Test events

- All existing events to be wiped pre-launch (nothing live yet)
- **Do NOT delete yet** — owner will give signal

---

## Open questions

None outstanding. Ready to build.

---

## Build order (each step independently revertable)

1. Add `FEATURES` flags to shared (commit 1)
2. Event creator UI: defaults + flag-gated hiding + fee floor + keep buyer-pays toggle (commit 2)
3. Server validation in `events.ts` (commit 3)
4. Batch router + `etherna-batches.json` registry (commit 4)
5. Etherna deploy path in `sites.ts` + deploy locally-patched inline-SOC code to server (commit 5)
6. Embed widget verification + Eventbrite-style snippet docs (commit 6)
7. Standalone event page deploy — larger; new ship doc (commit 7+)

**Suggested bundle:** (1)–(3) as a single "no-free-events, Stripe-only" commit. Then (4)–(5) as the Etherna migration commit. Then (6) and (7) split out.

---

## Key files / pointers

### Bee proxy (laptop is master, deploy to `~/bee_gateway/bee-slam/` on server)
- `/home/ntl/projects/bee_gateway/bee-slam/proxy/src/index.ts`
- **Deploy procedure (exact):**
  1. `rsync -avz /home/ntl/projects/bee_gateway/bee-slam/proxy/src/index.ts ntl-dev@192.168.0.144:/home/ntl-dev/bee_gateway/bee-slam/proxy/src/index.ts`
  2. `ssh ntl-dev@192.168.0.144 'cd ~/bee_gateway/bee-slam && docker compose build proxy && docker compose up -d proxy'`
  3. Verify: `ssh ntl-dev@192.168.0.144 'curl -s -o /dev/null -w "health %{http_code}\n" http://localhost:3323/health'` → expect 200
- Dead files NOT on server (don't sync src dir whole): `index_new.ts`, `index_old_v.ts`, `index_backup.ts`
- **bee-node container is separate** — never restart it as part of proxy deploys
- Server proxy lives in Docker network `bee-internal`, talks to `bee-node:1633` internally

### WoCo app server (laptop is master, deploy to `~/woco-events-server/` on server)
- `/home/ntl/projects/woco_app/apps/server/src/routes/sites.ts` — has unsynced inline-SOC patch (lines ~564-588)
- `/home/ntl/projects/woco_app/apps/server/scripts/etherna-*.ts` — new helper scripts (don't need server)
- **Deploy procedure (exact, from CLAUDE.md):**
  ```
  rsync -avz --exclude='node_modules' --exclude='.git' --exclude='dist' apps/server/ ntl-dev@192.168.0.144:~/woco-events-server/apps/server/
  rsync -avz --exclude='node_modules' packages/shared/ ntl-dev@192.168.0.144:~/woco-events-server/packages/shared/
  ssh ntl-dev@192.168.0.144 'cd ~/woco-events-server && npm run build'
  ```
- **Restart procedure (must follow exactly):**
  1. `ssh ntl-dev@192.168.0.144 "ps aux | grep -E 'node|tsx' | grep -v grep"` — find ALL processes
  2. **Disambiguate by `/proc/PID/cwd`** before killing — mf8-server coexists on the host
  3. Kill only the woco PIDs
  4. `sleep 2`, re-verify none of ours remain
  5. `ssh ntl-dev@192.168.0.144 "cd ~/woco-events-server && nohup npm run start > server.log 2>&1 & disown"`
  6. `sleep 3 && curl http://localhost:3001/api/health` → expect ok
- `npm run start` runs `node --import tsx src/index.ts` — NOT `node dist/index.js`

### Event creator
- `apps/web/src/lib/creator/events/TicketSeriesEditor.svelte` — main UI changes
- `apps/web/src/lib/creator/events/EventForm.svelte`, `EventEditor.svelte`, `PublishButton.svelte` — touch points

### Existing memory pointers to read
- `memory/project_etherna_integration.md`
- `memory/project_etherna_legacy_soc.md`
- `memory/project_etherna_batch_registry.md` (updated this session)
- `memory/project_crypto_payments.md`
- `memory/project_stripe_ux.md`
- `memory/feedback_*` — collaboration norms

### Memory updates pending (do at next-chat start)
- New memory: `project_realignment_2026_05_18.md` pointing at this doc
- Update `project_etherna_batch_registry.md` with the website-batch-reuse-for-standalone-events rule

---

## Key constants / env

```
ETHERNA_PLATFORM_BATCH=fc957ecd8f3295eb5643fde37e59044445b509a8b77789b8412cbe8c3956bb9a
ETHERNA_API_KEY=<set in apps/server/.env>
BEE_URL=http://192.168.0.144:3323            # local proxy
WOCO_GW=https://gateway.woco-net.com         # external CF tunnel → local proxy
ETHERNA_GW=https://gateway.etherna.io
TOKEN_ENDPOINT=https://sso.etherna.io/connect/token
BATCH_PER_USER_AUTO_PROVISION=false           # future flexibility flag
```

Etherna auth pattern (every script that hits Etherna):
```ts
const apiKey = process.env.ETHERNA_API_KEY!;
const dot = apiKey.indexOf(".");
const body = new URLSearchParams({
  grant_type: "password",
  client_id: "apiKeyClientId",
  username: apiKey.slice(0, dot),
  password: apiKey.slice(dot + 1),
  scope: "openid profile offline_access ether_accounts role userApi.gateway",
});
// POST to TOKEN_ENDPOINT → { access_token }
```

Anonymous reads on Etherna need offer registration after upload:
```
POST /api/v0.3/resources/{ref}/offers  (Authorization: Bearer <token>)
```

---

## Reminders from earlier feedback (don't lose)

- **Comments policy:** WHY-only, no paraphrase, no teaching prose
- **Commit cadence:** small revertable commits, ask before piling diff
- **mf8-server coexists on deploy host** — DO NOT kill all node/tsx, disambiguate by `/proc/PID/cwd`
- **No chained sleeps** on deploy verify — one short health+ps check
- **bee-js v11** — use `uploadPayload()` (inline SOC ≤4096B), NOT `uploadReference()` (legacy, breaks Etherna anonymous reads)
- **Costs**: Etherna gives credits (xDai), not BZZ — old memory was wrong about unit
