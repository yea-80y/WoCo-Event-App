# Custom Domains — Fresh Chat Handover

## What this feature does
Organisers connect their own domain (e.g. `events.mybar.com`) to their WoCo
multi-page site. The domain resolves to their Swarm-hosted site content.

---

## What was built this session (already committed, already deployed)

### Server — `apps/server/src/lib/domains/`
- **`service.ts`** — domain registry backed by `apps/server/data/domains.json`.
  Stores hostname, siteId/eventId, contentHash, feedManifestHash, ownerAddress,
  verified, onCloudflare, provider, trialExpiresAt, deactivated.
  NS detection for 20+ providers. `CNAME_TARGET = "sites.woco-net.com"`.
- **`poller.ts`** — 15-min background poller. Checks CNAME / apex A record.
  Marks domain verified, sends email, deactivates on grace expiry.

### Server routes — `apps/server/src/routes/domains.ts`
- `POST /api/domains` — register domain (siteId or eventId)
- `POST /api/domains/verify` — manual DNS check
- `GET /api/domains/site/:siteId` — list domains for a site
- `GET /api/domains/resolve/:hostname` — used by proxy to get contentHash
- `POST /api/domains/mine`, `POST /api/domains/remove`

### Server — `apps/server/src/routes/sites.ts`
After deploy, calls `updateDomainsForSite(siteId, contentHash, feedManifestHash)`
so registered domains always point to the latest deploy.

### Frontend — `apps/web/src/lib/creator/builder/`
- **`DomainLinker.svelte`** — inline domain UI: input hostname, shows per-provider
  DNS instructions, copy buttons, verify button. Two paths: Cloudflare (CNAME/A)
  vs non-Cloudflare (two options: quick CNAME trial vs free Cloudflare migration).
- **`DomainTab.svelte`** — wraps DomainLinker in a "Domain" tab. Empty state
  (URL transform visual + "Publish first" CTA) when feedHash is absent.
- **`domain-instructions.ts`** — step-by-step CNAME instructions for 20+ providers.
- **`MultiSiteBuilder.svelte`** — Domain tab added. contentHash persisted to
  localStorage per siteId. deployedHash restored from localStorage on site open.

### Edge proxy — `packages/edge-proxy/`
Cloudflare Worker deployed at `sites.woco-net.com`. Reads Host header,
calls `/api/domains/resolve/:hostname`, proxies to Swarm gateway.

---

## The problem — why the Worker approach is wrong

The Cloudflare Worker at `sites.woco-net.com/*` only runs for the `woco-net.com`
Cloudflare zone. When an external organiser (GoDaddy, Namecheap, etc.) adds
a CNAME to `sites.woco-net.com`, the DNS resolves to Cloudflare's IPs, but
Cloudflare does NOT run the Worker — it's a different zone/domain.

To make external CNAMEs trigger the Worker, Cloudflare charges **$2/month per
100 custom hostnames** (Cloudflare for SaaS). We're not paying for this.

---

## The correct approach — Caddy on Hetzner (free)

Run Caddy on the Hetzner VM. It listens on ports 80/443, gets Let's Encrypt
SSL certs on-demand for organiser domains, and forwards to the Hono server.
The Hono server reads the `Host` header, looks up the domain → content hash,
and proxies the response from the bee-proxy.

DNS instruction for ALL users: **one CNAME record** pointing to `sites.woco-net.com`.
For apex/bare domains: **A record → `46.225.174.72`**.

`sites.woco-net.com` DNS is changed to a plain A record (DNS-only, grey cloud,
no Worker) pointing to `46.225.174.72`. This means CNAME targets resolve to
our Hetzner server directly.

---

## Hetzner VM current state

- IP: `46.225.174.72`
- Docker Compose at `/opt/woco/docker-compose.yml`:
  - `bee-node` — Swarm node (port 1634 exposed for P2P)
  - `bee-proxy` — Swarm proxy (port 3000, bound to `127.0.0.1` only)
  - `woco-server` (Hono) — API server (port 3001, bound to `127.0.0.1` only)
  - `bee-internal` bridge network shared by all three
  - cloudflared runs on the HOST (not in Docker), tunnelling
    `events-api.woco-net.com → localhost:3001` and
    `gateway.woco-net.com → localhost:3000`
- **Firewall: INACTIVE** — ports 80 and 443 are free to open.
- All source code synced to `/opt/woco/repo/`, env at `/opt/woco/server.env`.

---

## Full implementation plan

### Step 1 — Cloudflare DNS changes (user does in CF dashboard)
1. Go to `woco-net.com` zone → DNS records
2. Find `sites` subdomain: change from Worker route to `A` record → `46.225.174.72`,
   **Proxy status: DNS only (grey cloud)**
3. Remove Worker route `sites.woco-net.com/*` from Workers → Routes
4. Remove Worker route `woco-net.com/*` (added during testing) from Workers → Routes
5. The `woco-edge-proxy` Worker can be left deployed or deleted — it won't receive
   traffic once the routes are removed.

### Step 2 — Add Caddy to Docker Compose

Create `/opt/woco/Caddyfile`:
```
{
  on_demand_tls {
    ask http://localhost:3001/api/domains/can-issue-cert
  }
}

http:// {
  reverse_proxy localhost:3001
}

https:// {
  tls {
    on_demand
  }
  reverse_proxy localhost:3001
}
```

Update `/opt/woco/docker-compose.yml` — add Caddy service:
```yaml
  caddy:
    image: caddy:2-alpine
    container_name: woco-caddy
    restart: unless-stopped
    network_mode: host          # needs host network to reach localhost:3001 + Let's Encrypt
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on: [server]

volumes:
  caddy_data:
  caddy_config:
```

Note: `network_mode: host` lets Caddy reach `localhost:3001` (the Hono server)
without Docker networking complexity. Caddy then exposes 80/443 on the host.

### Step 3 — New server endpoint: cert issuance check

Add to `apps/server/src/routes/domains.ts`:
```typescript
// Caddy on_demand_tls ask — returns 200 if domain is registered, 400 if not
domains.get("/can-issue-cert", async (c) => {
  const domain = c.req.query("domain");
  if (!domain) return c.json({}, 400);
  const entry = await getDomainByHostname(domain);
  if (!entry) return c.json({}, 400);
  return c.json({}, 200);
});
```

### Step 4 — Custom domain proxy middleware in Hono

Create `apps/server/src/middleware/custom-domain.ts`:
```typescript
import type { MiddlewareHandler } from "hono";
import { getDomainByHostname, markDomainVerified } from "../lib/domains/service.js";
import { PROXY_URL } from "../config/swarm.js";

const WOCO_HOSTS = new Set([
  "events-api.woco-net.com",
  "gateway.woco-net.com",
  "localhost",
  "127.0.0.1",
]);

export const customDomainProxy: MiddlewareHandler = async (c, next) => {
  const host = (c.req.header("host") ?? "").split(":")[0].toLowerCase();

  if (!host || WOCO_HOSTS.has(host) || host.endsWith(".woco-net.com")) {
    return next();
  }

  const entry = await getDomainByHostname(host);
  if (!entry || entry.deactivated) return next();

  // Mark verified on first traffic — DNS pointing to us = proof of ownership
  if (!entry.verified) {
    await markDomainVerified(host);
  }

  const path = new URL(c.req.url).pathname;
  const search = new URL(c.req.url).search;
  const target = `${PROXY_URL}/bzz/${entry.contentHash}${path}${search}`;

  try {
    const resp = await fetch(target, {
      headers: { Accept: c.req.header("accept") ?? "*/*" },
    });
    const headers = new Headers(resp.headers);
    headers.delete("content-encoding"); // Hono re-encodes; avoid double-gzip
    return new Response(resp.body, { status: resp.status, headers });
  } catch {
    return c.text("Failed to fetch site content", 502);
  }
};
```

Register it at the TOP of `apps/server/src/index.ts` (before API routes):
```typescript
import { customDomainProxy } from "./middleware/custom-domain.js";
app.use("*", customDomainProxy);
```

### Step 5 — Simplify domain verification logic

In `apps/server/src/lib/domains/service.ts` — `verifyDomain()`:
- Remove Cloudflare-specific apex path (accepting any A record)
- Replace with: check A record equals `46.225.174.72`
- Keep CNAME check for subdomains (unchanged — CNAME → `sites.woco-net.com`)
- Remove `onCloudflare` special-casing

In `apps/server/src/lib/domains/poller.ts` — `checkDomain()`:
- Same simplification: apex check = A record `46.225.174.72`
- CNAME check for subdomains unchanged

Export from service.ts:
```typescript
export const SERVER_IP = "46.225.174.72";
```

### Step 6 — Simplify DomainLinker.svelte

Current DomainLinker has two paths:
- Cloudflare users: CNAME/apex instructions, Proxied orange cloud
- Non-Cloudflare users: two options (quick 7-day trial vs free Cloudflare migration)

**Remove entirely:**
- The two-option tabs (quick/free)
- Cloudflare-specific instructions (no more "you're already on Cloudflare" badge)
- `onCloudflare` conditional rendering
- `trialExpiresAt` / grace period UI
- `option` state variable

**Replace with one simple instruction set:**
- For subdomains (www.mybar.com, events.mybar.com): CNAME → `sites.woco-net.com`
- For apex/bare domains (mybar.com): A record → `46.225.174.72`
- Provider-specific steps still shown (from domain-instructions.ts)
- Verify button still works (but now auto-verified on first traffic)

DomainLinker no longer needs the `feedManifestHash` prop for anything user-visible
(still passed through to register API). Simplify component significantly.

### Step 7 — Update domain-instructions.ts

All 20+ providers currently show CNAME steps. Keep CNAME steps (they're correct
for subdomains). Add or update `apexSupported` flags and add `aRecordSteps` for
providers that support apex A records (all of them do).

Add a new field to `ProviderInstructions`:
```typescript
aRecordSteps?: string[];  // Steps to add A record for apex domain
```

For each provider, add generic A record steps since the UI will show them
when the user enters a bare domain.

### Step 8 — Remove the edge-proxy package

Delete: `packages/edge-proxy/` (entire directory)

Remove from `package.json` workspaces if listed there.

Also remove from `packages/shared/` or root `tsconfig` references if any.

### Step 9 — Open firewall ports on Hetzner

Firewall is currently inactive. Either:
```bash
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```
Or just confirm firewall stays inactive (no iptables rules blocking 80/443).
The Hetzner network-level firewall (in Hetzner console) may need updating too —
check Cloud Console → Firewall for the server.

---

## Files summary

| File | Action |
|---|---|
| `packages/edge-proxy/` | **DELETE entire directory** |
| `apps/server/src/routes/domains.ts` | Add `GET /can-issue-cert` endpoint |
| `apps/server/src/middleware/custom-domain.ts` | **CREATE** — proxy middleware |
| `apps/server/src/index.ts` | Register `customDomainProxy` at top |
| `apps/server/src/lib/domains/service.ts` | Simplify verifyDomain — A record check |
| `apps/server/src/lib/domains/poller.ts` | Simplify checkDomain — A record check |
| `apps/web/src/lib/creator/builder/DomainLinker.svelte` | Simplify — one instruction set |
| `apps/web/src/lib/creator/builder/domain-instructions.ts` | Add aRecordSteps per provider |
| `/opt/woco/Caddyfile` | **CREATE on server** |
| `/opt/woco/docker-compose.yml` | Add Caddy service + volumes |

---

## What already works and does NOT need changing

- Domain registry (`service.ts` data model, file storage, all CRUD functions)
- Domain poller startup/shutdown in `index.ts`
- Domain API routes (register, mine, remove, resolve)
- `DomainTab.svelte` (empty state + active state wrapper — keep as-is)
- `MultiSiteBuilder.svelte` — Domain tab wiring, contentHash localStorage persistence
- `sites.ts` deploy route calling `updateDomainsForSite` after redeploy
- NS detection (`detectProvider`) — still useful for showing provider-specific steps

---

## DNS record instructions for users (final, correct)

**For www or subdomain (www.mybar.com, events.mybar.com):**
```
Type:   CNAME
Name:   www  (or events, etc.)
Target: sites.woco-net.com
```

**For bare/apex domain (mybar.com):**
```
Type:  A
Name:  @  (or leave blank)
Value: 46.225.174.72
```

No Cloudflare proxy required. No Worker routes. No SaaS fees.
SSL is issued automatically by Let's Encrypt via Caddy on first request.
