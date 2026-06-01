# Custom Domain Linking — Design & Implementation Plan

## What we're building

Organisers can point their own domain (e.g. `mybar.com` or `events.mybar.com`) at their
WoCo-deployed event site or multi-page site builder site. The domain serves the Swarm-hosted
content under the organiser's own URL — no redirect, no WoCo URL visible.

Currently the feature exists for event sites only (SiteBuilder.svelte) with domain
registration, CNAME verification, and a DNS resolution API. It has never been deployed or
tested end-to-end. We need to:

1. Fix the edge proxy (wrong gateway in wrangler.toml — see below)
2. Extend domain linking to site builder deployments (siteId alongside eventId)
3. Add NS detection to route users to the correct flow (CF vs non-CF)
4. Add Cloudflare Custom Hostnames API call for non-CF users (paid path)
5. Ship and test end-to-end

---

## Architecture

```
User visits mybar.com
  → CNAME → sites.woco-net.com
  → Cloudflare Worker (packages/edge-proxy/) intercepts
  → Worker calls GET /api/domains/resolve/mybar.com on our API
  → Gets contentHash back
  → Proxies request to gateway.woco-net.com/bzz/{contentHash}/
  → User sees their site under their domain
```

On redeploy: contentHash in our domain store is auto-updated. No DNS change needed by the
organiser ever again after initial setup.

---

## Critical bug to fix first

`packages/edge-proxy/wrangler.toml` currently has:

```toml
SWARM_GATEWAY = "https://gateway.ethswarm.org"   # WRONG — never use this
```

Must be changed to:

```toml
SWARM_GATEWAY = "https://gateway.woco-net.com"
```

WoCo uses its own gateway (gateway.woco-net.com) and Etherna (gateway.etherna.io).
The public Swarm gateway is never used anywhere in this project.

---

## One-time Cloudflare setup (before any code ships)

1. In Cloudflare dashboard → woco-net.com zone → DNS:
   Add `A  sites  192.0.2.1  Proxied (orange cloud)`
   (dummy IP — Worker intercepts before it hits origin)

2. Deploy the Worker:
   ```bash
   cd packages/edge-proxy
   npx wrangler login   # first time only
   npm run deploy
   ```

3. Add route in Cloudflare dashboard:
   Workers & Pages → woco-edge-proxy → Settings → Triggers → Add route:
   `sites.woco-net.com/*`  zone: woco-net.com

4. (Optional but recommended) KV namespace for 5-min domain→hash caching:
   ```bash
   npx wrangler kv namespace create DOMAINS
   ```
   Add the returned ID to wrangler.toml `[[kv_namespaces]]` block and redeploy.

5. Enable Cloudflare for SaaS on the woco-net.com zone:
   SSL/TLS → Custom Hostnames → Enable
   First 100 custom hostnames free, $0.10/month each after that.
   This issues SSL certs for organiser domains not managed by Cloudflare.

---

## SSL — the key problem and solution

When an organiser CNAMEs `mybar.com` → `sites.woco-net.com`:

- **If their DNS is on Cloudflare**: SSL works automatically. Free. No action needed on our side.
- **If their DNS is NOT on Cloudflare**: Browser gets a cert for sites.woco-net.com, not
  mybar.com → SSL error. Two solutions:

  **Option A (free forever)**: They move their DNS to Cloudflare.
  They do NOT transfer their domain (no lock-in). They just change nameservers at their
  existing registrar to Cloudflare's two NS hostnames. Takes 5 minutes, propagates in
  24–48 hours. Cloudflare DNS management is free with no domain limit.

  **Option B ($2/month)**: They keep their existing DNS provider. We call Cloudflare's
  Custom Hostnames API to issue an SSL cert for their domain. Costs us $0.10/month,
  we charge $2/month. Near-instant after they add the CNAME.

---

## Grace period UX — no barrier to entry

Organisers should never be blocked from launching. The flow:

```
Deploy → site is live on WoCo URL immediately (always, no wait)
         ↓
Enter custom domain in builder → NS lookup runs automatically
         ↓
┌─ Already on Cloudflare DNS ─────────────────────────────────────────┐
│  Show CNAME record to add. Goes live within minutes.                │
│  No cost, no grace period needed.                                   │
└─────────────────────────────────────────────────────────────────────┘

┌─ Not on Cloudflare DNS ─────────────────────────────────────────────┐
│  Domain registered immediately. 7-day free trial starts.           │
│  Site still live on WoCo URL throughout.                            │
│                                                                     │
│  Option A: Move DNS to Cloudflare (free forever)                    │
│  → Show provider-specific instructions (see NS detection below)     │
│  → Change NS takes 24–48 hrs — we poll, email them when live        │
│  → No cost ever                                                     │
│                                                                     │
│  Option B: Keep existing DNS ($2/month after 7-day trial)           │
│  → Add CNAME record now — live within the hour                      │
│  → We call CF Custom Hostnames API, cert issued automatically       │
│  → After 7 days, Stripe subscription required to stay active        │
└─────────────────────────────────────────────────────────────────────┘
```

**Grace period mechanics:**
- Day 0: Domain registered. 7-day window starts. WoCo URL always works.
- Day 5: Email — "Your custom domain trial ends in 2 days. Keep it free by moving to
  Cloudflare DNS, or subscribe for $2/month."
- Day 7: If no CF DNS detected and no active subscription → domain deactivated.
  Site still exists on WoCo URL, nothing else breaks. Organiser can reactivate any time.

**Background polling:** Server checks all unverified/pending domains every 15 minutes.
When CNAME resolves and (for non-CF) CF confirms cert issuance → auto-marks as verified,
sends "Your domain mybar.com is now live!" email. No manual verify click required.
The Verify button in the UI is a force-check for impatient users only.

---

## Timing per path

| Path | How fast |
|------|----------|
| Already on Cloudflare DNS | Minutes — launch straight away |
| Keep existing DNS + pay $2/mo (Option B) | Minutes to ~1 hour (DNS TTL dependent, rarely more) |
| Move nameservers to Cloudflare (Option A) | 24–48 hours — we email when done |

---

## NS detection — routing users to the right flow

When organiser enters their domain we do a server-side NS lookup:

```typescript
import dns from 'node:dns/promises';
const ns = await dns.resolveNs('mybar.com');
const onCloudflare = ns.some(n => n.endsWith('.ns.cloudflare.com'));
```

We also identify their current provider from NS records to show personalised instructions.

**NS fingerprint table:**

| NS pattern | Provider |
|------------|----------|
| `*.ns.cloudflare.com` | Cloudflare — green path |
| `ns*.domaincontrol.com` | GoDaddy |
| `*.registrar-servers.com` | Namecheap |
| `*.googledomains.com` / `*.squarespacedns.com` / `*.nsone.net` / `*.systemdns.com` | Squarespace Domains |
| `*.ui-dns.*` | IONOS |
| `ns-*.awsdns-*.*` | AWS Route 53 |
| `ns[1-4].name.com` | Name.com |
| `ns[1-2].hover.com` | Hover |
| `*.ns.porkbun.com` | Porkbun |
| `*.ovh.net` / `*.anycast.me` / `*.ovh.ca` | OVHcloud |
| `ns-###-[a-c].gandi.net` | Gandi |
| `ns.123-reg.co.uk` | 123-reg (legacy; newer accounts may show domaincontrol.com) |
| `ns0[1-2].one.com` | One.com |
| `ns[1-4].strato.de` | Strato |
| `ns[0-1].fasthosts.co.uk` / `ns[0-1].ukfast.net` | Fasthosts |
| `pdns*.ultradns.*` | Network Solutions |
| `ns[1-3].dreamhost.com` | DreamHost |
| `ns[1-2].bluehost.com` | Bluehost |
| `ns[1-2].hostgator.com` | HostGator |
| `ns[1-2].heartinternet.uk` | Heart Internet |
| `hydrogen.ns.hetzner.com` / `helium.ns.hetzner.de` | Hetzner DNS |
| No match | Unknown provider — show generic instructions |

---

## Root domain vs subdomain — important nuance

`events.mybar.com` (subdomain) → CNAME works everywhere, no issues.

`mybar.com` (apex/root) → Standard CNAME is technically invalid at the apex per RFC.
- **Cloudflare**: CNAME flattening — works perfectly, transparent to user
- **AWS Route 53**: Alias record only (AWS resources only, not our target)
- **All other providers**: No apex CNAME/ALIAS support

**Recommendation for the UI:** Recommend subdomains first (`www.mybar.com`,
`events.mybar.com`). Offer apex domain support only for users already on Cloudflare DNS.
For all others, show: "Using your main domain? We recommend `www.mybar.com` or
`events.mybar.com` — most DNS providers don't support linking the bare domain."

---

## Per-provider DNS instructions

These are the exact current steps shown to users in the UI, personalised by detected provider.
Instructions verified against official help docs. **Always test against live provider UIs before shipping.**

### Cloudflare (already there — green path)

**Add CNAME:**
1. Log in to dash.cloudflare.com → select your domain
2. Click **DNS** in the left sidebar → **Records**
3. Click **Add record**
4. Type: **CNAME** | Name: `www` (or `@` for root) | Target: `sites.woco-net.com`
5. Proxy status: **Proxied** (orange cloud) ← important, enables SSL
6. Click **Save**

Apex (`@`) supported: **Yes** — Cloudflare flattens it automatically.

---

### GoDaddy

**Add CNAME:**
1. Sign in → Domain Portfolio → click your domain
2. Click **DNS**
3. Click **Add New Record** → Type: **CNAME**
4. **Name**: your subdomain (e.g. `www` or `events`) — not the full domain
5. **Value**: `sites.woco-net.com`
6. Click **Save**

**Change nameservers to Cloudflare:**
1. Domain Portfolio → click domain → **DNS** → scroll to **Nameservers**
2. Click **Change** → **Enter my own nameservers (advanced)**
3. Delete existing entries, enter Cloudflare's two NS hostnames
4. Click **Save** (may require SMS/authenticator code if Domain Protection is on)

Apex supported: **No** — use a subdomain (e.g. `www.mybar.com`)
Gotcha: Domain Protection requires active 2-step verification before NS changes are allowed.

---

### Namecheap

**Add CNAME:**
1. Log in → **Domain List** → **Manage** next to your domain
2. Click **Advanced DNS** tab
3. Click **Add New Record** → Type: **CNAME Record**
4. **Host**: subdomain prefix only (e.g. `www`) — Namecheap appends the domain automatically
5. **Value**: `sites.woco-net.com`
6. Click the green checkmark to save

**Change nameservers to Cloudflare:**
1. Domain List → **Manage** → **Domain** tab
2. Under **Nameservers**, open the dropdown → select **Custom DNS**
3. Replace default entries with Cloudflare's two NS hostnames
4. Click the green checkmark

Apex supported: **No** — use a subdomain.
Gotcha: DNS records are only editable when using Namecheap BasicDNS, PremiumDNS, or FreeDNS. If you see a message about custom NS, edit DNS at your new provider instead.

---

### Squarespace Domains (formerly Google Domains)

**Add CNAME:**
1. Go to account.squarespace.com/domains → click your domain
2. Click **DNS Settings** → scroll to **Custom Records** → click **Add record**
3. Re-authenticate when prompted
4. Type: **CNAME** | Name: `www` | Target: `sites.woco-net.com`
5. Click **Save**

**Change nameservers to Cloudflare:**
1. Domains dashboard → your domain → **DNS** → **Domain Nameservers**
2. Click **Use Custom Nameservers** → authenticate
3. Confirm disabling DNSSEC when prompted (required before NS change)
4. Enter Cloudflare's two NS hostnames → **Save**

Apex supported: **No** — use a subdomain.
Gotcha: DNSSEC must be disabled before changing NS. Switching NS disconnects Squarespace website hosting and Google Workspace email — set those up at the new provider first.

---

### IONOS (1&1)

**Add CNAME:**
1. Log in → **Domains & SSL**
2. Click the gear/Actions icon next to your domain → **Manage Subdomains**
3. Click the gear icon next to the subdomain → **DNS**
4. Click **ADD RECORD** → select **CNAME**
5. **Hostname**: subdomain (e.g. `www`) | **Point to**: `sites.woco-net.com`
6. Click **Save**

**Change nameservers to Cloudflare:**
1. Domains & SSL → click your domain → **Name Server Settings**
2. Click **Use Custom Name Servers**
3. Enter Cloudflare's NS hostnames in Name Server 1–4 fields
4. Click **Save**

Apex supported: **No** — use a subdomain.
Gotcha: Adding a CNAME to a subdomain removes all other IONOS-managed services for that subdomain (email forwarding, FTP, etc.). IONOS will warn you — this is expected.

---

### AWS Route 53

**Add CNAME:**
1. AWS Console → Route 53 → **Hosted zones** → click your domain's zone
2. Click **Create record**
3. **Record name**: subdomain (e.g. `www`) | **Record type**: CNAME
4. **Value**: `sites.woco-net.com`
5. TTL: 300 (default) → click **Create records**

**Change nameservers to Cloudflare:**
1. In Cloudflare, after adding your domain, copy the two assigned NS hostnames
2. In Route 53, find the NS record set for your hosted zone
3. Go to your domain registrar (wherever the domain is registered, not Route 53 itself) and update nameservers to Cloudflare's
4. Note: Route 53 charges $0.50/month per hosted zone — you can delete the zone after switching NS

Apex supported: **Alias only** (AWS resources) — use a subdomain for our target.
Gotcha: Do not edit the NS record set inside Route 53 — change NS at the domain registrar instead.

---

### Name.com

**Add CNAME:**
1. Log in → **My Domains** → click your domain
2. Click **Manage DNS Records**
3. **Type**: CNAME | **Host**: subdomain (e.g. `www`) | **Answer**: `sites.woco-net.com`
4. TTL: 300 → click **Add Record**

**Change nameservers to Cloudflare:**
1. My Domains → click your domain → **Manage Nameservers**
2. Delete existing NS entries, enter Cloudflare's two NS hostnames
3. Click **Save**

Apex supported: **No** — use a subdomain.

---

### Hover

**Add CNAME:**
1. Log in at hover.com → click your domain name
2. Click the **DNS** tab → **Add a record**
3. **Type**: CNAME | **Hostname**: subdomain (e.g. `www`) | **Target Name**: `sites.woco-net.com`
4. Click **Add Record**

**Change nameservers to Cloudflare:**
1. Hover dashboard → your domain → **DNS** tab → **Edit Nameservers**
2. Replace default entries with Cloudflare's two NS hostnames (minimum 2 required)
3. Click **Save**

Apex supported: **No** — no ALIAS/ANAME support, use a subdomain.

---

### Porkbun

**Add CNAME:**
1. Log in → **Domain Management** → **Details** next to your domain
2. Click the DNS/edit icon → **Add Record**
3. **Type**: CNAME | **Host**: subdomain (e.g. `www`) | **Answer**: `sites.woco-net.com`
4. Click **Add**

**Change nameservers to Cloudflare:**
1. Domain Management → **Details** → click the edit icon next to Nameservers
2. Delete existing entries, enter Cloudflare's NS hostnames (one per line)
3. Click **Submit** → confirm with second **Submit**

Apex supported: **No** — use a subdomain.
Gotcha: Porkbun blocks adding a CNAME if an A or AAAA record already exists for the same subdomain — delete the conflicting record first.

---

### OVHcloud

**Add CNAME:**
1. Log in to OVH Control Panel → **Web Cloud** → **Domain names** → your domain
2. Click the **DNS zone** tab → **Add an entry** → select **CNAME**
3. **Subdomain**: your subdomain (e.g. `www`)
4. **Target**: `sites.woco-net.com.` ← **trailing dot is required**
5. Click **Next** → **Confirm**

**Change nameservers to Cloudflare:**
1. Control Panel → **Web Cloud** → **Domain names** → your domain
2. Click **DNS servers** tab → **Modify DNS servers**
3. Delete existing entries, enter Cloudflare's NS hostnames
4. Click **Apply configuration**

Apex supported: **No** — use a subdomain.
Gotcha: **The trailing dot is mandatory** on CNAME targets in OVH. Without it, the target is treated as a subdomain of your own zone.

---

### Gandi

**Add CNAME:**
1. Log in to admin.gandi.net → **Domain** → your domain
2. Click **DNS records** tab → **Add**
3. **Type**: CNAME | **Name**: subdomain (e.g. `www`) | **Hostname**: `sites.woco-net.com`
4. Click **Create**

**Change nameservers to Cloudflare:**
1. Gandi admin → your domain → **Nameservers** tab
2. Click the **External** option
3. Enter Cloudflare's NS hostnames → **Save**

Apex supported: **No** — use a subdomain.
Gotcha: Switching to external NS disables Gandi's LiveDNS editor. Set up records at Cloudflare before switching.

---

### 123-reg (UK)

**Add CNAME:**
1. Log in to 123-reg Control Panel → **Domain Portfolio**
2. Select your domain → click **DNS** in the toolbar
3. **Add New Record** → Type: **CNAME**
4. **Hostname**: subdomain (e.g. `www`) | **Value**: `sites.woco-net.com` | TTL: 3600
5. Click **Save**

**Change nameservers to Cloudflare:**
1. Domain Portfolio → **DNS** → **Nameservers** → **Change Nameservers**
2. Select **I'll use my own nameservers**
3. Enter Cloudflare's NS hostnames → **Save**

Apex supported: **No** — use a subdomain.
Note: 123-reg is owned by GoDaddy Group. Some accounts may show a GoDaddy-style interface.

---

### One.com

**Add CNAME:**
1. Log in to One.com Control Panel → **Advanced settings** → **DNS settings**
2. Click **DNS records** tab → under **Create new record**, click **CNAME**
3. **Hostname**: subdomain (e.g. `www`) | **Domain name (alias of)**: `sites.woco-net.com`
4. Click **Create record**

**Change nameservers to Cloudflare:**
1. Control Panel → **Advanced settings** → **DNS settings** → **Name servers** tab
2. Select **Change to custom name servers**
3. Enter Cloudflare's NS hostnames → **Save**

Apex supported: **No** — use a subdomain.

---

### Strato (Germany/Europe)

**Add CNAME:**
1. Log in at strato.de → **Domains** → **Domain management**
2. Click the cogwheel next to your domain → **DNS** tab
3. Find the row for your subdomain → click **manage** in the CNAME column
4. Enter `sites.woco-net.com.` ← **trailing dot required**
5. Tick the confirmation checkbox (warns CNAME replaces all other records for that subdomain)
6. Click **Accept settings**

**Change nameservers to Cloudflare:**
1. Log in → **Domains** → your domain → **Nameservers** section
2. Switch to **External nameservers**
3. Enter Cloudflare's NS hostnames → **Save**

Apex supported: **No** — use a subdomain.
Gotcha: **Trailing dot required.** Enabling a CNAME removes all Strato-managed services (email, FTP) for that subdomain — this is expected and correct. Strato UI is primarily German; use translate if needed.

---

### Fasthosts (UK)

**Add CNAME:**
1. Log in to Fasthosts account → **Domain Names** in left menu
2. Click the **DNS** icon next to your domain
3. Scroll to **CNAME Records** → **Add CNAME Record**
4. **Host Name**: subdomain (e.g. `www`) | **Points To**: `sites.woco-net.com`
5. Click **Save**

**Change nameservers to Cloudflare:**
1. Log in → **Domain Names** → select domain
2. Click **Nameservers and glue records**
3. Select custom/external nameservers option
4. Enter Cloudflare's NS hostnames → **Save**

Apex supported: **No** — no ALIAS/ANAME, use a subdomain.
Note: Fasthosts UI has been redesigned multiple times. The DNS section may be under "Advanced DNS" in older accounts. Allow up to 72 hours for NS propagation.

---

### Network Solutions

**Add CNAME:**
1. Log in → **My Account** → **Domains** → your domain
2. Scroll to **Advanced Tools** → **Manage** next to **Advanced DNS Records**
3. **Add Record** → Type: **CNAME (Alias)** | **Refers to**: **Other Host**
4. **Alias**: subdomain (e.g. `www`) | **Host Name**: `sites.woco-net.com`
5. Click **Continue** → **Save Changes**

**Change nameservers to Cloudflare:**
1. My Account → **Domains** → your domain
2. **Advanced Tools** → **Manage** next to **Nameservers (DNS)**
3. Delete existing NS entries, enter Cloudflare's NS hostnames → **Save**

Apex supported: **No** — use a subdomain.
Gotcha: Network Solutions calls CNAME records "Alias" — the **Refers to** field must be set to **Other Host** for an external target. UI is dated and terminology differs from standard DNS.

---

### DreamHost

**Add CNAME:**
1. Log in to panel.dreamhost.com → **Domains** → **Manage Domains**
2. Click **DNS** below your domain → **Add Record**
3. Hover over **CNAME Record** section → click **ADD**
4. **Host**: subdomain (e.g. `www`) | **Points to**: `sites.woco-net.com`
5. Click **Add Record**

**Change nameservers to Cloudflare:**
1. Panel → **Manage Websites** → three-dot menu → **DNS Settings**
2. **Nameservers** section → **Change** → **I'll use my own nameservers**
3. Enter Cloudflare's NS hostnames → **Save**

Apex supported: **No** — use a subdomain.
Gotcha: "You already have a record for this name" error means a conflicting A or CNAME exists — delete it first.

---

### Bluehost / HostGator (cPanel)

**Add CNAME (Bluehost):**
1. Log in → **Hosting** → your domain → **Manage** → **DNS** tab
2. Under CNAME section → **Add record**
3. **Host Record**: subdomain (e.g. `www`) | **Type**: CNAME | **Points To**: `sites.woco-net.com`
4. Click **Add Record**

**Add CNAME (HostGator via cPanel):**
1. Log in to cPanel (yourdomain.com/cpanel) → **Domains** → **Zone Editor**
2. **Manage** next to your domain → **Add Record**
3. **Type**: CNAME | **Name**: subdomain.yourdomain.com | **Record**: `sites.woco-net.com`
4. Click **Add Record**

**Change nameservers (Bluehost):**
1. Dashboard → **Domains** → **Manage** → **DNS** tab → **Nameservers**
2. Switch to **Custom Nameservers** → enter Cloudflare's NS → **Save**

Apex supported: **No** — use a subdomain.
Gotcha: Bluehost has two DNS paths — the simplified Domains panel and full cPanel Zone Editor. Either works; cPanel Zone Editor gives more control.

---

### Heart Internet (UK)

**Add CNAME:**
1. Log in to Heart Internet Control Panel
2. **Domain names** (right-hand menu under Manage) → select domain → **Manage Now**
3. Click **DNS Management**
4. Under **Create New A/AAAA/CNAME Records**:
5. **Subdomain**: your subdomain (e.g. `www`) | **Address**: `sites.woco-net.com.` ← **trailing dot required**
6. Click **Update DNS**

**Change nameservers to Cloudflare:**
1. Control Panel → **Domain names** → your domain → **Manage Now** → click **nameservers**
2. Replace existing entries with Cloudflare's NS hostnames → **Save**

Apex supported: **No** — use a subdomain.
Gotcha: **Trailing dot is required** on the CNAME target. CNAME section is combined with A/AAAA records in a single form — look for the Address field.

---

### Hetzner DNS

**Add CNAME:**
1. Log in to console.hetzner.com → **DNS** → click your zone
2. Click **Records** tab → **Type**: CNAME
3. **Name**: subdomain (e.g. `www`) | **Value**: `sites.woco-net.com.` ← **trailing dot required**
4. Set TTL → click **Add record**

**Change nameservers to Cloudflare:**
1. Go to your domain registrar (Hetzner DNS ≠ your registrar unless you registered there)
2. Change NS to Cloudflare's two NS hostnames
3. Hetzner DNS zone can then be deleted or left unused

Apex supported: **No** — use a subdomain.
Gotcha: **Trailing dot is mandatory** — without it, Hetzner appends the current zone name, making the target `sites.woco-net.com.yourdomain.com`.

---

### Generic (unknown provider)

When NS records don't match any known pattern, show:

> Add a **CNAME record** at your DNS provider with:
> - **Type**: CNAME (sometimes called "Alias")
> - **Name / Host**: your subdomain (e.g. `www` — not the full domain)
> - **Target / Value / Points to**: `sites.woco-net.com`
>
> We recommend using a subdomain like `www.yourdomain.com` or `events.yourdomain.com`
> rather than your bare domain. Save the record and click Verify below once done.

---

## Apex domain — what to tell users

For users who type their bare domain (`mybar.com` not `www.mybar.com`):

- If on **Cloudflare DNS**: "Great news — add a CNAME for `@` and it works perfectly."
- If on **any other provider**: "Most DNS providers don't support linking a bare domain
  directly. Use `www.mybar.com` or `events.mybar.com` instead — these work everywhere.
  (Or move your DNS to Cloudflare for free, which unlocks bare domain support.)"

---

## Backend changes needed

### `apps/server/src/lib/domains/service.ts`
- Add optional `siteId?: string` to `DomainEntry` (alongside existing `eventId?: string`)
- Add `getDomainsForSite(siteId)` function
- Add `updateDomainsForSite(siteId, contentHash, feedManifestHash)` — called on redeploy

### `apps/server/src/routes/domains.ts`
- POST `/` — accept `siteId` instead of (or in addition to) `eventId`
- For siteId path: ownership = authenticated parentAddress (no event lookup needed)
- Add `GET /api/domains/site/:siteId` public endpoint
- Add NS detection on register: return `{ onCloudflare: boolean, provider: string }` in response
- Add Cloudflare Custom Hostnames API call (Option B paid path)

### `apps/server/src/routes/sites.ts`
- After successful deploy: call `updateDomainsForSite(siteId, contentHash, feedManifestHash)`
  so existing registered domains auto-update to new contentHash

### `apps/server/src/lib/domains/poller.ts` (new file)
- Background job: check unverified domains every 15 minutes
- If CNAME resolves correctly → mark verified, send "your domain is live" email
- If grace period expired and no CF DNS + no subscription → deactivate

### `packages/edge-proxy/wrangler.toml`
- Fix SWARM_GATEWAY to `https://gateway.woco-net.com`
- Uncomment route binding for `sites.woco-net.com/*`
- Add KV namespace binding once created

### `apps/web/src/lib/api/domains.ts`
- Add `registerSiteDomain(hostname, siteId, contentHash, feedManifestHash?)`
- Add `getSiteDomains(siteId)`

### `apps/web/src/lib/creator/builder/MultiSiteBuilder.svelte`
- Add domain state + handlers (mirror SiteBuilder.svelte pattern)
- Add domain UI section after deploy banner:
  - ENS hash (feedManifestHash) + copy
  - Custom domain input
  - After submission: show detected provider + personalised CNAME instructions
  - Show which option applies (CF green path / Option A free / Option B $2/mo)
  - "We're checking DNS in the background — we'll email you when it's live"
  - Verify button for impatient manual check

---

## Files to know

```
packages/edge-proxy/src/worker.ts            # Cloudflare Worker — proxies custom domains → Swarm
packages/edge-proxy/wrangler.toml            # Worker config (SWARM_GATEWAY bug is here)
apps/server/src/lib/domains/service.ts       # Domain registry (file-backed .data/domains.json)
apps/server/src/routes/domains.ts            # Domain API routes
apps/web/src/lib/api/domains.ts              # Frontend domain API client
apps/web/src/lib/creator/SiteBuilder.svelte  # Event site builder — existing domain UI (reference)
apps/web/src/lib/creator/builder/MultiSiteBuilder.svelte  # Site builder — needs domain UI added
apps/server/src/routes/sites.ts              # Site deploy endpoint — needs auto-update hook
```

---

## Testing checklist (once Worker is deployed)

1. `curl https://sites.woco-net.com/_health` → `{ ok: true }`
2. Register a test domain via the UI, check:
   `curl https://events-api.woco-net.com/api/domains/resolve/yourdomain.com`
3. Add CNAME at your DNS provider, wait propagation
4. Background poller picks it up within 15 minutes (or hit Verify button)
5. Visit `https://yourdomain.com` → should serve site content via gateway.woco-net.com
6. Redeploy the site in the builder → verify contentHash auto-updates, domain still works
7. Test the NS detection: use domains on GoDaddy, Namecheap, Cloudflare — confirm correct
   provider is identified and correct instructions shown

---

## Not in scope for this sprint

- Stripe subscription for Option B ($2/month) — stub the paid path, build billing later
- WHOIS lookup for personalised registrar instructions — NS detection is sufficient for routing
- Enforcement of subdomain-only for non-CF providers — warn but don't hard-block apex yet
