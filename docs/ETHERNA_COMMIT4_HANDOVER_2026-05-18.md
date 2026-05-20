# Etherna Integration — Handover (2026-05-18, updated)

Paste this entire file into a new chat to continue. The working directory is
`/home/ntl/projects/woco_app`. Server is `ntl-dev@192.168.0.144`, dir
`~/woco-events-server`. DO NOT push to GitHub — user pushes themselves.

---

## What was shipped across this session

**Commits already on main (DO NOT redo):**
- `354d125` fix(etherna): correct BZZ labeling, fractional TTL, batch usability wait
- `9878fc2` feat(etherna): per-user batch routing + Etherna deploy path

**This session (deployed, NOT yet committed):**
- `apps/server/src/lib/etherna/batches.ts` — `USABILITY_POLL_INTERVAL_MS` 5000→2000ms;
  credit-debit wait (8s) and usability polling run in `Promise.all` so polling starts
  immediately rather than after the 8s delay
- `apps/web/src/lib/creator/builder/PurchaseBatchModal.svelte` — elapsed timer +
  progressive busy labels ("Contacting Etherna…" → "Purchasing batch on Gnosis chain…"
  → "Waiting for batch to propagate… (Ns)")
- `apps/server/src/lib/etherna/upload.ts` — new `writeEthernaFeedUpdate()` function:
  bypasses bee-js entirely for SOC writes (see bee-js gotcha below), implements inline
  SOC (Case B from probe), returns `feedManifestHash`
- `apps/server/src/routes/sites.ts` — Etherna deploy branch now calls
  `writeEthernaFeedUpdate()` instead of the non-fatal try-catch; feed hash restored in
  deploy response
- `apps/web/src/lib/creator/builder/MySitesScreen.svelte` — `logoUrl()` hardcoded to
  `https://gateway.woco-net.com` (was incorrectly using the selected deploy `gatewayUrl`,
  breaking logos for WoCo-Bee sites when Etherna is selected in the picker)
- Frontend deployed: feed index 70

**Suggest committing these as commit 5 before starting the next task.**

---

## Architecture

```
Creator picks gateway in builder UI → GatewayPicker (Etherna default, WoCo for testing)

Server batchForDeploy({ ownerAddress, gatewayUrl, deployType }):

  Gateway   deployType  User has batch?  → batch                   target
  -------   ----------  ---------------  --------                  ------
  WoCo      any         n/a              POSTAGE_BATCH_ID          wocoBee
  Etherna   any         yes              user's batch              etherna
  Etherna   event       no               ETHERNA_PLATFORM_BATCH   etherna
  Etherna   website     no               throws BatchPurchaseRequired → 402
                                         → UI opens PurchaseBatchModal

Per-user batch store: .data/etherna-batches.json (must survive restarts)
```

---

## Open issue: Etherna feed manifest resolution (MUST run probe)

Mirko (Etherna) said **legacy SOC** (SOC payload = 32-byte ref to manifest) no longer
resolves through Beehive via `/bzz/{feedManifest}/...`.

`writeEthernaFeedUpdate` uses **inline SOC** (SOC payload = raw root chunk bytes of the
content collection). Whether Beehive resolves THIS via `/bzz/{feedManifest}/` is unknown.

**Run the probe before assuming feed-based ENS works on Etherna:**
```bash
cd apps/server
export $(grep -v '^#' .env | grep ETHERNA_API_KEY | xargs)
npx tsx scripts/etherna-soc-legacy-probe.ts
```

Result matrix:
- Case A 200 → legacy works (no problem at all)
- Case A non-200, Case B 200 → our `writeEthernaFeedUpdate` works ✓
- Both non-200 → feed manifest on Etherna doesn't resolve via `/bzz/`

**If both non-200:** mark in code with `// TODO(etherna-feed): Beehive /bzz feed
resolution unconfirmed — migrate when Beehive updated` and write the feed to WoCo Bee
instead for now (call `getBee()` + `writer.uploadPayload()`). Direct content hash URL
still works for sharing; only stable ENS pointer is affected (needs WoCo feed for that).
No regression — just note it clearly.

---

## Main next task: self-contained Etherna sites (image uploads)

### Problem

All image/file uploads (logos, gallery images, event images) go to WoCo Bee at creation
time. When a site is deployed to Etherna, `gatewayUrl = https://gateway.etherna.io` in
`window.SITE_CONFIG`, so the site's JS tries to load images via Etherna — but those refs
are on WoCo Bee and 404.

Events listing is NOT a problem — it calls `GET /api/sites/:id/events-full` (API server
call, not a Swarm read). Works regardless of gateway.

### Solution

Route image uploads to Etherna at **creation time** when Etherna is the user's selected
gateway. Same ref format returned — only the destination changes.

### Steps

**1. Find the upload endpoint(s)**
```bash
grep -r "uploadFile\|/bytes\|upload" apps/server/src/routes/ --include="*.ts" -l
grep -r "upload\|swarm" apps/web/src/lib/api/ --include="*.ts" -l
```

**2. Add gateway/target param to upload route**

Client passes its selected gateway. Server checks:
- `gatewayUrl === "https://gateway.etherna.io"` → upload to Etherna with user's batch
- otherwise → upload to WoCo Bee as now

**3. Etherna upload pattern (copy from sites.ts)**
```typescript
import { ensureEthernaToken, getCachedEthernaToken, registerEthernaOffer } from "../lib/etherna/upload.js";
import { getUserBatch } from "../lib/etherna/batches.js";

const ETHERNA_GW = process.env.ETHERNA_GATEWAY_URL || "https://gateway.etherna.io";

await ensureEthernaToken();
const token = getCachedEthernaToken();
const userBatch = getUserBatch(parentAddress);
if (!userBatch) return c.json({ ok: false, error: "No Etherna batch", code: "BATCH_PURCHASE_REQUIRED" }, 402);

const resp = await fetch(`${ETHERNA_GW}/bytes`, {
  method: "POST",
  headers: {
    "Content-Type": contentType,
    "Swarm-Postage-Batch-Id": userBatch.batchId,
    Authorization: `Bearer ${token}`,
  },
  body: fileBuffer,
});
if (!resp.ok) throw new Error(`Etherna upload ${resp.status}`);
const { reference } = await resp.json();
await registerEthernaOffer(reference);  // make anonymously readable
// return reference — same shape as WoCo Bee upload response
```

**4. Pass target from builder**

In `apps/web/src/lib/creator/builder/`, wherever image uploads are triggered, include
the current `gatewayUrl` so the server knows the target.

### Key files
```
apps/server/src/lib/etherna/upload.ts        # uploadCollectionToEtherna, registerEthernaOffer, writeEthernaFeedUpdate
apps/server/src/lib/etherna/batch-router.ts  # batchForDeploy
apps/server/src/lib/etherna/batches.ts       # getUserBatch(addr) → UserBatchEntry | null
apps/server/src/lib/etherna/auth.ts          # ensureEthernaToken, getCachedEthernaToken
apps/server/src/routes/sites.ts              # multisite deploy (reference for Etherna pattern)
apps/web/src/lib/creator/builder/            # builder UI — find upload calls here
```

---

## Personal Bee node access

No work needed. Any valid Swarm content hash works on any Bee node:
```
http://localhost:1633/bzz/{contentHash}/
```
We already return `contentHash` from deploy. Could add a UI hint later.

---

## bee-js v11 gotchas (don't hit these again)

- **`onRequest` is informational only**: the callback receives a shallow copy of the
  request object. Mutations to `req.headers` are silently discarded — the original
  `requestConfig` is never touched. Auth headers set inside `onRequest` never reach
  Etherna. Workaround: raw `fetch` with explicit `Authorization` header (see
  `writeEthernaFeedUpdate`).
- **`writer.upload()` is deprecated** — use `uploadReference` / `uploadPayload`.
- **`new Reference(hexString)` required** — bee-js no longer accepts plain strings.
- **Feed index**: `GET /feeds/{owner}/{topic}` → header `swarm-feed-index-next` → parse
  with `new FeedIndex(hexStr).toBigInt()`. Returns 404 for fresh feeds (index 0).

---

## Env reference
```
ETHERNA_ENABLED=true
ETHERNA_API_KEY=<id>.<secret>
ETHERNA_PLATFORM_BATCH=<hex>       # fallback for event deploys (no user batch needed)
ETHERNA_GATEWAY_URL=https://gateway.etherna.io   # default if unset
ETHERNA_CLIENT_ID=apiKeyClientId                 # default
ETHERNA_PURCHASE_DEPTH=20
ETHERNA_PURCHASE_TTL_DAYS=365
ETHERNA_PURCHASE_MAX_BZZ=1         # per-purchase BZZ cap (hard ceiling)
```

## Deploy procedure
```bash
# Server
rsync -avz --exclude='node_modules' --exclude='.git' --exclude='dist' \
  apps/server/ ntl-dev@192.168.0.144:~/woco-events-server/apps/server/
rsync -avz --exclude='node_modules' \
  packages/shared/ ntl-dev@192.168.0.144:~/woco-events-server/packages/shared/
ssh ntl-dev@192.168.0.144 'cd ~/woco-events-server && npm run build'
# Kill woco processes only (check /proc/PID/cwd — mf8-server coexists, do NOT kill it)
ssh ntl-dev@192.168.0.144 "nohup npm run start > server.log 2>&1 & disown"
# Frontend
npm run build:web && npm run deploy
```

## Constraints (don't change without asking)
- mf8-server coexists on deploy host — always disambiguate PIDs by `/proc/PID/cwd`
- Never push to GitHub (user pushes themselves)
- WHY-only comments — no teaching prose, no paraphrase
- Small revertable commits — surface "commit X before moving on?" points
- Per-purchase BZZ cap is a hard ceiling — don't widen without user approval
