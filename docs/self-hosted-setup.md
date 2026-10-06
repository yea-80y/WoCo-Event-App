# WoCo Events Server — Self-Hosted Setup

This guide covers running the WoCo Events Server (`apps/server`) on your own infrastructure.

**Verified against `main` (94364b56) on 2026-10-05.** Written 2026-02; most of the original was
stale and has been corrected. Read the status block first.

> **Status (2026-10-05) - what self-hosting gets you today.**
>
> - **The server is not stateless.** It has no database, but `.data/` holds ledgers that must
>   survive restarts (payouts, refunds, cancellations, attendee batch slots, consumed Stripe
>   sessions, and more - the list is in `CLAUDE.md` under "`.data/` files that must survive
>   restarts"). Losing some of them stops all sales or emails unsubscribers.
> - **It is not free of WoCo infrastructure.** Deployed sites and event pages may only name the
>   WoCo gateway or the Etherna gateway (`allowedGatewayUrls()` in
>   `apps/server/src/lib/site/deploy-config.ts`). The WoCo web app talks to whichever API it was
>   built against (`VITE_API_URL`), so pointing organisers at your server means building and
>   hosting your own copy of `apps/web`.
> - **Selling tickets needs much more than the original four variables:** Stripe Connect, an
>   email provider, an attendee order batch, a ticket sponsor key and an onchain ticket ledger
>   that authorises that sponsor (step 4).
>
> A minimal read/relay server (steps 1-6) works. A server that sells tickets is an operator
> project, not a quick start.

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Docker + Docker Compose**, or **Node.js 24+** | `.nvmrc` pins 24; the server image is `node:24-alpine`. |
| **Bee node** | Your own node, reachable from the server. |
| **Postage batch** | Bought against your Bee node — see Swarm docs. |
| **Domain / tunnel** | HTTPS endpoint for the server (Cloudflare Tunnel, Nginx, etc.). |

---

## 1. Clone the repository

```bash
git clone https://github.com/yea-80y/WoCo-Event-App.git
cd WoCo-Event-App
```

---

## 2. Generate a feed private key

`FEED_PRIVATE_KEY` owns the **platform** feeds (event directory, site events index, creator site
directory and similar). User content feeds are owned by each user's own signer, not by this key.
Back it up — losing it means losing write access to every platform feed created with it.

```bash
openssl rand -hex 32
# e.g. a3f8c1d2e5b4...  (64 hex characters)
```

---

## 3. Buy a postage batch

You need a valid postage batch to upload data to Swarm. Purchase one via your Bee node (adjust
`amount` and `depth` to your expected storage needs):

```bash
curl -s -X POST "http://<your-bee-url>:1633/stamps/<amount>/<depth>"
# Returns: {"batchID": "abc123..."}
```

Purchases cannot be undone. See the
[Swarm docs](https://docs.ethswarm.org/docs/develop/access-the-swarm/buy-a-stamp-batch) for
sizing.

---

## 4. Configure the environment

```bash
cp apps/server/.env.example apps/server/.env
```

`.env.example` documents most keys with their reasoning. Read it; the tables below are the
summary.

### Refused at boot if missing

| Variable | When |
|----------|------|
| `EMAIL_HASH_SECRET` | Always. HMAC key for email hashes. Rotating it orphans every existing hash. |
| `ALLOWED_HOSTS` | When `NODE_ENV=production`. Every frontend hostname, no protocol. |
| `PAYMENT_QUOTE_SECRET` | When `NODE_ENV=production`. |
| `STRIPE_WEBHOOK_SECRET` + `STRIPE_WEBHOOK_SECRET_PLATFORM` | When `NODE_ENV=production` and `STRIPE_SECRET_KEY` is set. |
| `UPLOAD_SECRET` | When `PROXY_URL` is set (gateway whitelist calls). |
| distinct sponsor keys | Boot refuses if `SUB_ENS_SPONSOR_PRIVATE_KEY` equals `WOCO_SPONSOR_PRIVATE_KEY`. |

Set `NODE_ENV=production` yourself: neither the Dockerfile nor the compose file sets it, and
without it the production checks above, and the refusal of unsigned Stripe webhooks, are off.

### Needed for the basics

| Variable | Notes |
|----------|-------|
| `BEE_URL` | Your Bee API URL. |
| `POSTAGE_BATCH_ID` | 64-hex batch ID from step 3. |
| `FEED_PRIVATE_KEY` | From step 2. |
| `PUBLIC_API_BASE` | This server's public URL. Site deploys stamp it as the site's API (the client's value is discarded), and email links use it. |
| `PORT` | Default 3001. |

### Needed to sell tickets

| Variable | Notes |
|----------|-------|
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, both webhook secrets | Card is the only live payment method. |
| `ATTENDEE_STAMPER_PRIVATE_KEY` + an active batch | Checkout refuses (503) until a batch it owns is registered and activated (`/api/ops/attendee-batch/register`, `/activate`, bearer `OPS_TOKEN`). Never register a batch another server already uses. |
| `WOCO_SPONSOR_PRIVATE_KEY` | Sends the mints. No entry of its own in `.env.example`. |
| `WOCO_EVENT_CHAIN_ID`, `WOCO_EVENT_VERSION_{chainId}`, `WOCO_EVENT_ADDRESS_LEDGER_{chainId}` | No entry in `.env.example`. Unset = Base Sepolia `v1`. The ledger accepts mints only from sponsors it authorises, so you need your own deployment or an authorisation. |
| `EMAIL_PROVIDER` + SES (`AWS_*`) or Resend (`RESEND_API_KEY`), `EMAIL_FROM` | Tickets are emailed. |
| `CHECKIN_PASS_SECRET` | Door check-in. No entry in `.env.example`. |

Sites and event pages are stored on Etherna (`ETHERNA_ENABLED`, `ETHERNA_API_KEY`,
`ETHERNA_PLATFORM_BATCH`); see [ETHERNA_INTEGRATION.md](./ETHERNA_INTEGRATION.md).

**ALLOWED_HOSTS** is critical: it must include every hostname your frontend is served from,
exactly as the browser sees it. If you add a frontend domain later, add it and recreate the
container (`docker compose up -d`, not `restart` - `restart` keeps the old env).

---

## 5. Run with Docker Compose

```bash
docker compose up -d --build
```

This builds `apps/server/Dockerfile` (which also builds the embed widget) and binds the server to
**`127.0.0.1:3001` only**. That is deliberate: rate limits trust `cf-connecting-ip`, which is safe
only when the tunnel is the sole way in (`apps/server/src/lib/http/client-ip.ts`). Override the
file rather than editing it if you need LAN access.

> **Add a volume for `.data/` before you rely on it.** The root `docker-compose.yml` mounts none,
> so recreating the container (every `up -d --build`) discards `/app/.data`. Mount a host
> directory at `/app/.data` and back it up.

Check it is answering:

```bash
curl http://localhost:3001/api/health          # always 200; a JSON report of every subsystem
curl http://localhost:3001/api/health/alarms   # 503 when a watched section is red
```

Point an uptime monitor at `/api/health/alarms`, not `/api/health`.

```bash
docker compose logs -f
docker compose down
```

---

## 5b. Alternative: run with Node.js directly

```bash
npm install
npm run build:embed          # the server serves packages/embed/dist/
npm run start -w @woco/server   # node --import tsx src/index.ts, from apps/server
```

Do **not** use `npm run dev:server` for this: it opens an SSH tunnel to WoCo's own production
Bee before starting.

---

## 6. Expose over HTTPS

The frontend performs session delegation, which requires a public HTTPS URL.

**Cloudflare Tunnel** (simplest, and what the loopback binding above assumes):

```bash
cloudflared tunnel --url http://localhost:3001
# Gives you a URL like https://random-name.trycloudflare.com
```

For a permanent setup, configure a named tunnel pointing to `localhost:3001` and set up a DNS
CNAME in your Cloudflare dashboard.

**Nginx reverse proxy** (alternative). Rate limits key on `cf-connecting-ip`; behind Nginx alone
that header is caller-supplied, so read `client-ip.ts` before choosing this.

```nginx
server {
    listen 443 ssl;
    server_name events-api.yourdomain.org;

    location / {
        proxy_pass http://localhost:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

---

## 7. Your API URL

~~This URL goes into the WoCo site builder and is baked into the generated frontend as
`VITE_API_URL`.~~ **Stale.** The site builder has no API URL field. Today:

- A site or event page deployed **through your server** gets your `PUBLIC_API_BASE` baked in.
- The builder itself runs in the WoCo web app, which calls the API it was built with. To have
  organisers publish through your server, build `apps/web` with `VITE_API_URL` (and
  `VITE_GATEWAY_URL`) set to yours and host that build.

---

## Troubleshooting

**403 on authenticated requests**
: `ALLOWED_HOSTS` does not include the frontend hostname. Add it and recreate the container.

**`POSTAGE_BATCH_ID not configured`**
: The `.env` file is missing or the variable is empty. Check `docker compose logs`.

**Checkout answers "Ticket sales are paused for a moment" (503)**
: No usable attendee batch. See `ATTENDEE_STAMPER_PRIVATE_KEY` above.

**Embed widget not served (`/embed/woco-embed.js` returns 404, "Embed widget not built")**
: `packages/embed/dist/` is missing. Run `npm run build:embed` (native), or rebuild the image:
  `docker compose build --no-cache && docker compose up -d`

**Bee connection refused**
: Verify `BEE_URL` is reachable from inside the container. For a local Bee node on the host
  machine, use `http://host.docker.internal:1633` instead of `http://localhost:1633`.
