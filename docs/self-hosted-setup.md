# WoCo Events Server — Self-Hosted Setup

This guide covers deploying the WoCo Events Server on your own infrastructure.
The server is a stateless Hono/Node.js process that acts as a relay between
your frontend and a Swarm Bee node. No database. No WoCo dependency at runtime.

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Docker + Docker Compose** | v24+ recommended (or Node.js 20+ for native run) |
| **Bee node** | Your own node or a hosted Bee API endpoint |
| **Postage batch** | Bought against your Bee node — see Swarm docs |
| **Domain / tunnel** | HTTPS endpoint for the server (Cloudflare Tunnel, Nginx, etc.) |

---

## 1. Clone the repository

```bash
git clone https://github.com/yea-80y/WoCo-Event-App.git
cd WoCo-Event-App
```

---

## 2. Generate a feed private key

This key owns all event and ticket feeds on Swarm. Back it up securely —
losing it means losing write access to all feeds created with it.

```bash
openssl rand -hex 32
# e.g. a3f8c1d2e5b4...  (64 hex characters)
```

---

## 3. Buy a postage batch

You need a valid postage batch to upload data to Swarm. Purchase one via your
Bee node (adjust `amount` and `depth` to your expected storage needs):

```bash
curl -s -X POST "http://<your-bee-url>:1633/stamps/<amount>/<depth>"
# Returns: {"batchID": "abc123..."}
```

A depth of 20 and amount of 100000000 is a reasonable starting point for
a small event. See the [Swarm docs](https://docs.ethswarm.org/docs/develop/access-the-swarm/buy-a-stamp-batch) for sizing guidance.

---

## 4. Configure the environment

```bash
cp apps/server/.env.example apps/server/.env
```

Edit `apps/server/.env`:

```env
BEE_URL=http://localhost:1633          # your Bee node API URL
POSTAGE_BATCH_ID=abc123...             # 64-char batch ID from step 3
FEED_PRIVATE_KEY=a3f8c1d2e5b4...      # 64-char key from step 2
ALLOWED_HOSTS=events.devcon.org        # frontend hostname(s), comma-separated
PORT=3001
```

**ALLOWED_HOSTS** is critical: it must include every hostname your frontend
is served from, exactly as the browser sees it (no protocol, no trailing slash).
If you add a new frontend domain later, add it here and restart the server.

---

## 5. Run with Docker Compose (recommended)

```bash
docker compose up -d
```

This builds the image locally (embedding the embed widget), starts the server,
and restarts it automatically on failure.

Check it's healthy:

```bash
curl http://localhost:3001/api/health
# {"ok":true}
```

View logs:

```bash
docker compose logs -f
```

Stop:

```bash
docker compose down
```

---

## 5b. Alternative: run with Node.js directly

If you prefer native Node.js (no Docker):

```bash
npm install
npm run build:embed          # build the embed widget once
cd apps/server
node --import tsx src/index.ts
```

Or via the root workspace:

```bash
npm run dev:server
```

---

## 6. Expose over HTTPS

The frontend performs session delegation which requires a public HTTPS URL.

**Cloudflare Tunnel** (simplest):

```bash
cloudflared tunnel --url http://localhost:3001
# Gives you a URL like https://random-name.trycloudflare.com
```

For a permanent setup, configure a named tunnel pointing to `localhost:3001`
and set up a DNS CNAME in your Cloudflare dashboard.

**Nginx reverse proxy** (alternative):

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

## 7. Note your API URL

Once the server is publicly accessible, note the base URL — you will need it
when generating your event frontend:

```
https://events-api.yourdomain.org
```

This URL goes into the WoCo site builder (next step) and is baked into the
generated frontend as `VITE_API_URL`. Your frontend and server are then
fully coupled — no WoCo infrastructure involved.

---

## Environment variable reference

| Variable | Required | Description |
|----------|----------|-------------|
| `BEE_URL` | Yes | Swarm Bee node API URL |
| `POSTAGE_BATCH_ID` | Yes | 64-char hex batch ID |
| `FEED_PRIVATE_KEY` | Yes | 64-char hex secp256k1 private key |
| `ALLOWED_HOSTS` | Yes | Comma-separated frontend hostnames |
| `PORT` | No | HTTP port (default: 3001) |

---

## Troubleshooting

**403 on authenticated requests**
: `ALLOWED_HOSTS` does not include the frontend hostname. Add it and restart.

**`POSTAGE_BATCH_ID not configured`**
: The `.env` file is missing or the variable is empty. Check `docker compose logs`.

**Embed widget not served (`/embed/woco-embed.js` returns 404)**
: The image was built before `packages/embed/dist/` existed. Rebuild:
  `docker compose build --no-cache && docker compose up -d`

**Bee connection refused**
: Verify `BEE_URL` is reachable from inside the container.
  For a local Bee node on the host machine, use `http://host.docker.internal:1633`
  instead of `http://localhost:1633`.
