# Hetzner Single-VM Deploy — Server + Bee (light) + Bee Proxy

> **LIVE STATUS (2026-05-19): MIGRATION COMPLETE.** WoCo server + Bee + bee-proxy are running on Hetzner CPX22 at `46.225.174.72`. Laptop-server (192.168.0.144) Bee + WoCo server are STOPPED (containers exist, status Exited) — kept cold as 2-week rollback insurance. Do NOT restart laptop Bee under any circumstance until formal decommission.
>
> **Daily ops cheatsheet at the bottom of this doc.**

Goal: move WoCo server + Bee node + Bee whitelist proxy off the laptop-server (192.168.0.144) onto one Hetzner Cloud VM. ~€7.99/mo (CPX22) + ~€0.50 IPv4 + optional ~€0.90 snapshots = **~€9.40/mo (~$10.30)**. Same Bee identity preserved (postage batches stay valid). Cloudflare Tunnel preserved so the Hetzner public IP is never exposed.

This doc is paste-ready and is written as a **two-phase migration**:

- **Phase A — Dry run** with a *fresh* Bee identity on a test hostname. Proves the stack boots end-to-end. Zero risk to live infra.
- **Phase B — Cutover.** Stop laptop Bee, migrate keystore + `.data/`, point Cloudflare Tunnel routes at Hetzner.

Sections marked **YOU** require manual action from the user (account signup, DNS panel clicks, etc). Everything else is paste-and-run.

---

## Why these choices

- **Hetzner CPX22 (€7.99/mo, 3 vCPU AMD EPYC, 4GB RAM, 80GB SSD)** — what we actually provisioned in Nuremberg (Falkenstein was sold out). AMD EPYC is ~20–40% faster per core than the Intel CX line, plus 50% more cores and 2× disk for the same price as the originally-planned CX22 (which was €4.51 in old pricing — Hetzner bumped prices in 2026). Comfortable headroom for Bee chunk cache + Docker builds.
- **Light Bee node** — no xBZZ stake, postage batches handle uploads. Bee does NOT sync the Gnosis chain locally; it talks to an external RPC (we use a private Chainstack endpoint). So no special memory/storage requirement for chain history.
- **Cloudflare Tunnel kept** — already wired, gives DDoS protection, hides VM IP, avoids a DNS change. Caddy + DNS-01 dropped from the original plan because the tunnel already terminates TLS at Cloudflare's edge.
- **Bee whitelist proxy kept** — the live setup has a custom Node proxy (`bee-slam-proxy`) in front of Bee on :3323 that enforces a content-hash whitelist. Without it, anyone who finds the gateway URL can push chunks to our postage batch. Must come along.

## Alternatives considered (and rejected)

- **DO / Linode / Vultr**: ~2× the price for the same RAM.
- **Oracle Free**: ruled out — account-termination risk for stateful workloads.
- **Direct DNS + Caddy (the original plan)**: would expose the VM IP and require a DNS cutover. Cloudflare Tunnel sidesteps both.
- **Stay on laptop-server**: single point of failure (sleep / power / ISP / hardware). Status quo is the actual risk.

---

## Pre-reqs checklist (collect/confirm before Phase A)

**YOU:**

- [ ] Hetzner Cloud account + project + payment method (sign up at https://accounts.hetzner.com/signUp — takes ~5 min, needs card or PayPal; one-time ID verification can take an hour).
- [ ] Local SSH key. Check with `ls ~/.ssh/id_ed25519.pub` (or `id_rsa.pub`). If missing, generate: `ssh-keygen -t ed25519 -C "woco-hetzner"`. We'll upload it to Hetzner in Phase A.
- [ ] Cloudflare account access (already have — the tunnel runs there).
- [ ] **Triple-backup** the live keystore before we touch anything (Phase B step 0 below). Loss = your feed-signing identity is gone forever and every existing event's feed becomes unwritable.
- [ ] Confirm postage batch is healthy and not near expiry: `ssh ntl-dev@192.168.0.144 'docker exec bee-node curl -s localhost:1633/stamps | jq'`. If close to expiry, top up *before* the migration so you're not debugging two things at once.

---

## PHASE A — Dry run with a fresh Bee identity

Goal: prove the Hetzner stack boots, can issue postage, can serve a chunk via the proxy. **No live keystore involved.** Laptop Bee keeps running normally the entire time.

### A1. Create the VM — YOU

1. Log into Hetzner Cloud Console → **+ New Project** → name it `woco`.
2. **Security** tab → **SSH Keys** → **Add SSH Key** → paste contents of `~/.ssh/id_ed25519.pub` (run `cat ~/.ssh/id_ed25519.pub` on laptop). Name it `ntl-laptop`.
3. **Servers** tab → **Add Server**:
   - **Location**: Falkenstein (Helsinki is also fine; pick whichever has capacity)
   - **Image**: Ubuntu 24.04
   - **Type**: **CX22** (Standard tab, 4GB RAM, 40GB SSD, €4.51/mo)
   - **Networking**: IPv4 + IPv6 both on (default)
   - **SSH Keys**: tick `ntl-laptop`
   - **Firewalls**: create a new firewall `woco-fw` allowing inbound TCP 22 only (Cloudflare Tunnel makes outbound connections, so no ports 80/443 needed). Apply to this server.
   - **Name**: `woco-prod`
4. Click **Create & Buy now**. Wait ~30s for provisioning.
5. Copy the IPv4 address from the server detail page and paste it back to me.

### A2. Base setup — paste-ready

Once you've given me the IP I'll run the rest, but the commands are:

```bash
ssh root@<IP>

# Base packages + Docker
apt update && apt upgrade -y
apt install -y docker.io docker-compose-v2 rsync jq curl ca-certificates

# cloudflared (for Cloudflare Tunnel)
mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared noble main" > /etc/apt/sources.list.d/cloudflared.list
apt update && apt install -y cloudflared

systemctl enable --now docker

# Working tree
mkdir -p /opt/woco/{repo,bee-data,proxy-data,woco-data}
```

### A3. Compose stack — `/opt/woco/docker-compose.yml`

```yaml
services:
  bee:
    image: ethersphere/bee:stable
    container_name: bee-node
    restart: unless-stopped
    environment:
      - BEE_PASSWORD=${BEE_PASSWORD}
    volumes:
      - ./bee-data:/home/bee/.bee
    networks: [bee-internal]
    # P2P port exposed to host for inbound peers
    ports: ["1634:1634"]
    command: >
      start
      --api-addr=:1633
      --p2p-addr=:1634
      --verbosity=info
      --cors-allowed-origins=*
      --full-node=false
      --swap-enable=true
      --mainnet=true
      --blockchain-rpc-endpoint=${GNOSIS_RPC_ENDPOINT}

  bee-proxy:
    build:
      context: ./repo-bee-proxy
      dockerfile: Dockerfile
    container_name: bee-proxy
    restart: unless-stopped
    environment:
      - PORT=3000
      - BEE_API_URL=http://bee-node:1633
      - WHITELIST_PATH=/data/whitelist.json
    volumes:
      - ./proxy-data:/data
    networks: [bee-internal]
    depends_on: [bee]

  server:
    build:
      context: ./repo
      dockerfile: apps/server/Dockerfile
    container_name: woco-server
    restart: unless-stopped
    env_file: ./server.env
    environment:
      - BEE_URL=http://bee-node:1633
    volumes:
      - ./woco-data:/app/apps/server/.data
    networks: [bee-internal]
    depends_on: [bee]

networks:
  bee-internal:
    driver: bridge
```

Notes:
- `bee-data` is a **bind-mount** (host directory), not a named volume. Makes keystore migration trivial — just rsync the directory.
- `proxy-data` likewise — keeps the whitelist file portable.
- No host port published for `bee:1633` or `server:3001`. cloudflared talks to them over the `bee-internal` Docker network.

### A4. Secrets — `/opt/woco/.env`

```
BEE_PASSWORD=<generate fresh for Phase A; replace with laptop password in Phase B>
GNOSIS_RPC_ENDPOINT=https://gnosis-mainnet.core.chainstack.com/<key>
```

Generate the Phase-A Bee password: `openssl rand -hex 24`. The Gnosis RPC URL is the same Chainstack endpoint the laptop Bee uses — pull it from the laptop's docker-compose at `~/bee_gateway/bee-slam/docker-compose.yml`.

### A5. Server `.env` — `/opt/woco/server.env`

Copy `apps/server/.env` from laptop:

```bash
# From laptop
scp ~/projects/woco_app/apps/server/.env root@<IP>:/opt/woco/server.env
```

Then on the VM, override `BEE_URL`:

```
BEE_URL=http://bee-node:1633
```

For Phase A, also temporarily add a test allowed-host so we can hit the API without disturbing live DNS:
```
ALLOWED_HOSTS=<existing list>,test-api.woco-net.com
```

### A6. Ship the code — paste-ready

```bash
# From laptop — rsync repo + bee-proxy source
rsync -avz --exclude=node_modules --exclude=.git --exclude=dist \
  ~/projects/woco_app/ root@<IP>:/opt/woco/repo/

rsync -avz --exclude=node_modules \
  /home/ntl/projects/bee_gateway/bee-slam/proxy/ root@<IP>:/opt/woco/repo-bee-proxy/
```

### A7. Cloudflare Tunnel — test hostnames

**YOU** (Cloudflare dashboard → Zero Trust → Networks → Tunnels):

1. Click **Create a tunnel** → connector **cloudflared** → name `woco-hetzner` → **Save**.
2. On the install page, copy the **token** (looks like `eyJh...`). Paste back to me; I'll install the tunnel service on the VM with that token.
3. Add **public hostname**:
   - Subdomain: `test-api` · Domain: `woco-net.com` · Type: `HTTP` · URL: `woco-server:3001`
   - Subdomain: `test-gateway` · Domain: `woco-net.com` · Type: `HTTP` · URL: `bee-proxy:3000`
4. Save. Cloudflare auto-creates the DNS CNAMEs.

Tunnel install on VM (I'll do this once I have the token):
```bash
cloudflared service install <TOKEN>
systemctl status cloudflared
```

Because cloudflared and Docker share the host network, the tunnel resolves container names via the Docker bridge — actually no, it can't out-of-the-box. To make the tunnel reach Docker services, either:
- (a) run cloudflared **inside** the compose stack on the `bee-internal` network, or
- (b) publish `server:3001` and `bee-proxy:3000` to `127.0.0.1` only and point the tunnel at `http://127.0.0.1:3001` / `http://127.0.0.1:3000`.

Option (a) is cleaner. I'll add a `cloudflared` service to docker-compose.yml using the same tunnel token, so its sidecars run on the `bee-internal` net and `woco-server:3001` / `bee-proxy:3000` resolve via Docker DNS.

### A8. Boot Phase A

```bash
cd /opt/woco
docker compose up -d --build

# Watch Bee come up (~30–60s; new node bootstrapping peers)
docker compose logs -f bee
# Look for: "node is ready"

# Server
docker compose logs -f server
# Look for: "Server listening on :3001"
```

### A9. Smoke tests — Phase A pass criteria

```bash
# Health endpoint via tunnel
curl https://test-api.woco-net.com/api/health
# → {"ok":true,...}

# Bee through proxy via tunnel
curl https://test-gateway.woco-net.com/health   # whichever endpoint your proxy exposes
```

If both green, Phase A is done. **Do NOT proceed to Phase B until both work.**

---

## PHASE B — Cutover (the careful part)

**Time budget**: ~30 min total. **Downtime window**: ~10 min during step B4–B7.

### B0. Triple-backup the live keystore — YOU + me

This is the one step where loss is unrecoverable. Do all three:

```bash
# 1. Dump the live bee-data volume to a tar on the server
ssh ntl-dev@192.168.0.144
cd ~/bee_gateway/bee-slam
docker run --rm -v bee-slam_bee-data:/src -v $PWD:/backup alpine \
  tar czf /backup/bee-data-$(date +%Y%m%d).tar.gz -C /src .

# 2. Copy to laptop
exit
scp ntl-dev@192.168.0.144:~/bee_gateway/bee-slam/bee-data-*.tar.gz ~/backups/woco/

# 3. Copy to encrypted offline storage (USB / password manager / cloud)
# Verify integrity before continuing:
tar tzf ~/backups/woco/bee-data-*.tar.gz | head
# Should list keys/ statestore/ localstore/ etc.
```

Confirm with me when all three copies exist. Until then, **do not run B1**.

### B1. Stop laptop Bee — YOU

```bash
ssh ntl-dev@192.168.0.144
cd ~/bee_gateway/bee-slam
docker compose stop bee
# Verify nothing's running with the bee image:
docker ps | grep bee
# Should show nothing (or only bee-proxy, which is fine — it can sit idle)
```

**At this point laptop Bee is OFF and Hetzner Bee (Phase A) is running with a fresh identity. Zero collision risk.**

### B2. Stop laptop WoCo server — YOU

```bash
ssh ntl-dev@192.168.0.144
pkill -f "tsx src/index.ts"
sleep 2
ps aux | grep -E 'node|tsx' | grep -v grep
# Confirm no woco-server / tsx process. (mf8-server may exist — leave it alone.)
```

### B3. Migrate keystore + `.data/` to Hetzner — me

```bash
# Stop the Phase-A Bee + server so we can swap state cleanly
ssh root@<IP> 'cd /opt/woco && docker compose stop bee server'

# Wipe the Phase-A fresh bee-data and replace with the real one
ssh root@<IP> 'rm -rf /opt/woco/bee-data && mkdir /opt/woco/bee-data'

# Restore from the live tar (copy tar up first if not already)
scp ~/backups/woco/bee-data-<date>.tar.gz root@<IP>:/tmp/
ssh root@<IP> 'tar xzf /tmp/bee-data-*.tar.gz -C /opt/woco/bee-data/'

# Server .data/
rsync -avz ntl-dev@192.168.0.144:~/woco-events-server/apps/server/.data/ \
  root@<IP>:/opt/woco/woco-data/

# Whitelist for the proxy
rsync -avz ntl-dev@192.168.0.144:~/bee_gateway/bee-slam/proxy-data/ \
  root@<IP>:/opt/woco/proxy-data/   # may need to docker-extract similarly if it's a named volume
```

### B4. Swap to the real `BEE_PASSWORD`

Edit `/opt/woco/.env` on the VM, replace the Phase-A test password with the real `BEE_PASSWORD` from laptop's `~/bee_gateway/bee-slam/.env`.

### B5. Restart Hetzner stack with real identity

```bash
ssh root@<IP> 'cd /opt/woco && docker compose up -d bee server bee-proxy'
ssh root@<IP> 'cd /opt/woco && docker compose logs -f bee'
# Look for: same overlay address as the laptop Bee had (compare to backup tar)
# Look for postage batches: docker exec bee-node curl -s localhost:1633/stamps | jq
```

If overlay address or postage batch ID doesn't match what laptop Bee had → **STOP**, do not flip DNS. Something went wrong with the keystore migration. Rollback path: restart laptop Bee (see B8 rollback).

### B6. Flip Cloudflare Tunnel routes — YOU

In Cloudflare Zero Trust → Tunnels → `woco-hetzner` → **Public Hostname** tab:

- Edit `test-api` → change subdomain to `events-api`. Save.
- Edit `test-gateway` → change subdomain to `gateway`. Save.

Cloudflare flips the CNAMEs instantly. Old laptop tunnel still exists but no hostnames route to it — harmless.

Also remove the temporary `test-api.woco-net.com` from `ALLOWED_HOSTS` in `/opt/woco/server.env` and `docker compose restart server`.

### B7. Live smoke test — YOU + me

- [ ] `curl https://events-api.woco-net.com/api/health` → ok
- [ ] Open the live app — does it load events?
- [ ] Publish a tiny test event end-to-end
- [ ] Claim a free ticket on a test series
- [ ] Stripe webhook delivery: Stripe Dashboard → Developers → Webhooks → check recent attempts to `events-api.woco-net.com/api/stripe/webhook`
- [ ] MyTickets loads + decrypts
- [ ] Dashboard loads + decrypts an order

If all green → cutover complete.

### B8. Rollback path (if any of B5/B6/B7 fails)

```bash
# 1. Stop Hetzner Bee + server (so they can't talk to Swarm with the migrated identity)
ssh root@<IP> 'cd /opt/woco && docker compose stop bee server bee-proxy'

# 2. Restart laptop Bee + server
ssh ntl-dev@192.168.0.144
cd ~/bee_gateway/bee-slam && docker compose start bee
cd ~/woco-events-server && nohup npm run start > server.log 2>&1 & disown

# 3. Cloudflare: flip the two public hostnames back to the OLD tunnel
#    (Zero Trust → Tunnels → [old laptop tunnel] → Add public hostname)
```

**Critical**: at step 1, Hetzner Bee MUST be stopped before laptop Bee starts. Two Bees with the same keystore = duplicate postage stamps + feed sequence forks (corrupt feeds, irreversible).

---

## Post-cutover

### Within 24h

- [ ] Hetzner Console → server `woco-prod` → **Backups** tab → enable weekly snapshots (~€0.83/mo)
- [ ] UptimeRobot (free) → monitor `https://events-api.woco-net.com/api/health` every 5 min → email on failure
- [ ] Document SSH access in your password manager (`root@<IP>`, key location)

### Within 1 week

- [ ] Final round of smoke tests after a couple of real claims have happened
- [ ] If clean: archive laptop `~/woco-events-server/` somewhere safe, then it's fine to wind down the laptop services permanently

### Decommission laptop (after 2 weeks of clean Hetzner logs)

1. Final encrypted offline backup of `bee-data` tar (the one from B0 — still good, but take a fresh post-migration one too)
2. Disable laptop tunnel: `systemctl disable --now cloudflared` on 192.168.0.144
3. Remove the laptop tunnel from Cloudflare dashboard (Zero Trust → Tunnels → delete)
4. Keep the laptop Bee compose dir + .env on disk for one more month, then archive

---

## Recurring cost (actual, post-migration)

- Hetzner CPX22: €7.99/mo
- Hetzner IPv4: €0.50/mo
- Weekly snapshots (optional, recommended): ~€0.90/mo
- Postage batches: unchanged
- Cloudflare / DNS: free
- **Total: ~€9.40/mo (~$10.30)**

---

## Pitfalls — read before each session on this migration

- **Never run laptop Bee and Hetzner Bee simultaneously** with the same keystore. Duplicate postage stamps + feed sequence forks = corrupt feeds, irrecoverable.
- The keystore lives in a **Docker volume** `bee-slam_bee-data`, not `~/.bee/`. Extract with `docker run --rm -v bee-slam_bee-data:/src -v $HOME:/backup alpine tar czf /backup/bee-data.tar.gz -C /src .`. Apply same pattern to `bee-slam_proxy-data` for the whitelist.
- The **bee whitelist proxy** must come along — without it, the gateway accepts unrestricted chunk uploads and burns your postage batch. The compose **service name is `proxy`** in the laptop-server stack but the **container name is `bee-proxy`** — stop by container name to avoid confusion.
- `.data/` files (consumed-tx-hashes, consumed-stripe-sessions, revoked-sessions, reservations, **etherna-batches**, stripe-accounts) MUST migrate intact — they prevent replay attacks. Loss = double-claims possible.
- Gnosis RPC: we use a private **Chainstack** endpoint, not the public node. Carry the URL across in `/opt/woco/.env`.
- `apps/server/.env` on laptop is master. Any change must be made there and re-deployed to `/opt/woco/server.env`.
- After Bee restart, wait ~20s for peer warmup before deploying frontend / pushing chunks.
- Cloudflare Tunnel keeps the Hetzner IP private — do NOT add 80/443 to the Hetzner firewall, do NOT switch hostnames to A records.
- **Cloudflared apt repo had no Ubuntu 26.04 ("resolute") release** at the time of migration. Install via the direct `.deb`: `curl -fsSL -o /tmp/cf.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && dpkg -i /tmp/cf.deb`.
- **Host-side cloudflared (not in compose)**: container ports MUST bind to `127.0.0.1` (e.g. `"127.0.0.1:3001:3001"`) so cloudflared on the host can reach them at `localhost:3001` without exposing them to the public IP. Never bind to `0.0.0.0`.
- **chown after restore**: `bee-data` must be owned by uid `999` (Bee container user); `proxy-data` and `woco-data` by uid `1000` (node user in our images). Forgetting this = `permission denied` on first boot.
- **Cloudflare DNS cutover gotcha**: when swapping hostnames between two tunnels, you'll hit "An A, AAAA, or CNAME record with that host already exists." Delete the old CNAME(s) in CF DNS panel first (they're auto-managed by the old tunnel), then save the new tunnel route — CF auto-creates a fresh CNAME pointing at the new tunnel.

---

## HARDENING (applied 2026-05-19)

Snapshot of the VM's security posture and what's been done. All reversible.

### Done

- **SSH key-only**: `PasswordAuthentication no` + `KbdInteractiveAuthentication no` + `PermitRootLogin prohibit-password` via `/etc/ssh/sshd_config.d/10-hardening.conf`. Delete file + `systemctl reload sshd` to revert. Verify with `sshd -T | grep -E '^(passwordauth|permitrootlogin)'`.
- **fail2ban**: installed + enabled. Default `sshd` jail (5 fails / 10min → 10min ban). Status: `fail2ban-client status sshd`.
- **Docker log rotation**: `/etc/docker/daemon.json` → `{ "log-driver": "json-file", "log-opts": { "max-size": "50m", "max-file": "5" } }`. Caps each container at ~250MB total. Applies only to containers recreated AFTER the file was written — existing containers keep old (unbounded) logs until next `docker compose up -d --force-recreate`.
- **unattended-upgrades**: enabled by default on Ubuntu 26.04 — security patches install automatically.

### Already true (pre-hardening)

- Bee/proxy/server bind to `127.0.0.1:PORT` — only `:22` (SSH) and `:1634` (Bee P2P) are publicly reachable.
- Only one SSH key authorized for root (laptop's ed25519). Public IPv4 will get continuously scanned regardless — that's normal; security is in the auth config, not IP secrecy.

### Open items (need Console / external service — not doable from VM)

- **Hetzner snapshot backups**: enable in Console → Server → Backups (~€0.90/mo). Daily snapshots, 7-day retention. Cheapest disaster-recovery insurance in the stack.
- **UptimeRobot** (or similar): free tier, monitor `https://events-api.woco-net.com/api/health` every 5min, email/SMS on failure.
- **Verify Hetzner Cloud Firewall is attached**: Console → Firewalls → confirm the firewall has `Inbound: 22/TCP, 1634/TCP, 1634/UDP` and is attached to the `woco-prod` VM. If it gets detached, the on-VM defenses (key-only SSH + 127.0.0.1 binds) still hold, but defence in depth is gone.

### Bee node hardening (applied 2026-05-19 PM)

Audited the bee config against `docs.ethswarm.org` and applied four changes. The live `/opt/woco/docker-compose.yml` reflects the post-hardening state; old copies kept as `docker-compose.yml.bak.*`.

- **Image pinned**: `ethersphere/bee:2.7.1` (was `:stable`). Stops a future floating-tag release rolling on `up --build`. Verified version matches what `:stable` resolved to so it's a no-op functionally.
- **Password via `--password-file`** instead of `BEE_PASSWORD` env var. File at `/opt/woco/secrets/bee-password`, owned `999:999` (the in-container `bee` user, host UID 999 = `dnsmasq:systemd-journal` due to NSS mapping — that's normal), mode `400`. Mounted read-only at `/run/secrets/bee-password`. Removes the plaintext leak via `docker inspect` and the host `.env`.
- **Explicit NAT address**: `--nat-addr=46.225.174.72:1634`. Bee advertises the public host:port to peers immediately on boot instead of waiting on AutoNAT discovery (which was non-deterministic — sometimes took hours, sometimes never flipped `isReachable` to `true` after a restart). Verified: `/addresses` now includes `/ip4/46.225.174.72/tcp/1634/p2p/Qm…` and `/status` reports `isReachable: true` within 20s of restart.
- **Image identity preserved**: overlay address before + after = `ca354053…`. Keystore, swap state, chequebook untouched.

Compliance against docs.ethswarm.org light-node guidance: all required flags present (`--full-node=false --swap-enable=true --mainnet=true --blockchain-rpc-endpoint=…`). Optional deviations consciously kept: `--cors-allowed-origins=*` is fine because port 1633 isn't host-published (bee-proxy is the security boundary).

**Rollback** (only if needed):
```bash
ssh root@46.225.174.72 'cd /opt/woco && cp docker-compose.yml.bak.<timestamp> docker-compose.yml && docker compose up -d bee'
```

### Recovery one-liners

```bash
# Roll back SSH hardening (reopens password auth):
ssh root@<IP> 'rm /etc/ssh/sshd_config.d/10-hardening.conf && systemctl reload sshd'

# Disable fail2ban temporarily:
ssh root@<IP> 'systemctl stop fail2ban'

# Unban an IP that got auto-banned (e.g. yours after fumbling a key):
ssh root@<IP> 'fail2ban-client set sshd unbanip <IP>'

# See banned IPs:
ssh root@<IP> 'fail2ban-client status sshd'
```

---

## DAILY OPS CHEATSHEET (post-migration)

### Connect to Hetzner

```bash
ssh root@46.225.174.72
cd /opt/woco
```

(SSH key: `~/.ssh/id_ed25519` on the laptop — Hetzner has the public half registered as `ntl@ntl-20n5s4xa00`.)

### Layout on the VM

```
/opt/woco/
├── docker-compose.yml      # 3 services: bee, bee-proxy, server
├── .env                    # BEE_PASSWORD, GNOSIS_RPC_ENDPOINT (root 600)
├── server.env              # mirrors apps/server/.env from laptop
├── bee-data/               # Bee state (uid 999) — keystore, postage, chequebook
├── proxy-data/             # whitelist.json (uid 1000)
├── woco-data/              # server .data/ (uid 1000) — anti-replay state
├── repo/                   # rsynced copy of woco_app (source for server build)
└── repo-bee-proxy/         # rsynced copy of bee-slam/proxy (source for proxy build)

/root/backups/              # 339MB bee-data tar + proxy + server tars (post-migration)
```

### Check status

```bash
docker compose ps

# Bee internal API — bee-node has no curl, query via bee-proxy (which has wget)
docker exec bee-proxy wget -qO- http://bee-node:1633/health
docker exec bee-proxy wget -qO- http://bee-node:1633/status      # mode, peers, reachable, sync
docker exec bee-proxy wget -qO- http://bee-node:1633/addresses   # underlays advertised
docker exec bee-proxy wget -qO- http://bee-node:1633/stamps      # postage batches
docker exec bee-proxy wget -qO- http://bee-node:1633/topology    # full neighborhood map

# Connected peer count (one number)
docker exec bee-proxy wget -qO- http://bee-node:1633/status | grep -oE '"connectedPeers":[0-9]+'

# Whitelist size
curl -s http://127.0.0.1:3000/health
```

### Logs

All container logs go to Docker's json-file driver. Anything below works from `/opt/woco` on the VM,
or wrapped in `ssh root@46.225.174.72 '...'` from the laptop.

```bash
# Live tail one service (Ctrl-C to exit)
docker compose logs -f bee
docker compose logs -f bee-proxy
docker compose logs -f server
docker compose logs -f                           # all three interleaved

# Recent history without following
docker compose logs --tail 200 bee
docker compose logs --since 1h bee               # last hour
docker compose logs --since 2026-05-19T01:00 bee # from a timestamp

# Errors / warnings only
docker compose logs --tail 500 bee 2>&1 | grep -iE 'error|warn|fatal'

# Per-container (no compose context) — same output, different verb
docker logs --tail 100 -f bee-node

# Log file location on disk (if you need to grep raw or copy off-box):
docker inspect bee-node --format '{{.LogPath}}'
# → /var/lib/docker/containers/<id>/<id>-json.log
```

**Hot one-liners from the laptop (no SSH session needed):**

```bash
# Tail bee logs live from anywhere
ssh root@46.225.174.72 'cd /opt/woco && docker compose logs -f --tail 50 bee'

# Quick error scan across all services for the last hour
ssh root@46.225.174.72 "cd /opt/woco && docker compose logs --since 1h 2>&1 | grep -iE 'error|warn|fatal' | tail -50"

# Peer count + health snapshot (from laptop, one-shot)
ssh root@46.225.174.72 'docker exec bee-proxy wget -qO- http://bee-node:1633/status' | grep -oE '"connectedPeers":[0-9]+|"isReachable":(true|false)|"beeMode":"[a-z]+"'
```

**Log rotation:** Docker's default json-file driver has no size cap, so logs grow forever. If you want
to bound disk usage, add this to `/etc/docker/daemon.json` and `systemctl restart docker`:

```json
{ "log-driver": "json-file", "log-opts": { "max-size": "50m", "max-file": "5" } }
```

Applies to **new** containers only — re-create with `docker compose up -d --force-recreate` to pick up.

### Restart services

```bash
cd /opt/woco
docker compose restart server          # picks up server.env changes
docker compose restart bee-proxy
docker compose restart bee             # ~20s warmup, peer reconnect
```

### Update server code (after changes pushed to the repo on the laptop)

```bash
# From laptop:
rsync -az --exclude=node_modules --exclude=.git --exclude=dist \
  --exclude=apps/web/dist-site --exclude=apps/web/dist-multisite \
  --exclude=packages/embed/dist \
  ~/projects/woco_app/ root@46.225.174.72:/opt/woco/repo/

# From VM:
ssh root@46.225.174.72 'cd /opt/woco && docker compose up -d --build server'
```

### Update `apps/server/.env`

```bash
# 1. Edit ~/projects/woco_app/apps/server/.env on the laptop (master source)
# 2. Copy + restart:
scp ~/projects/woco_app/apps/server/.env root@46.225.174.72:/opt/woco/server.env
ssh root@46.225.174.72 'sed -i "s|^BEE_URL=.*|BEE_URL=http://bee-node:1633|" /opt/woco/server.env && cd /opt/woco && docker compose restart server'
```

(The `sed` keeps BEE_URL pointed at the in-network Bee, since the laptop master has the LAN IP.)

### Update bee-proxy code

```bash
# From laptop, push the proxy source from laptop-server cache:
ssh ntl-dev@192.168.0.144 'cd ~/bee_gateway/bee-slam && tar --exclude=proxy/node_modules --exclude=proxy/dist -czf /tmp/bee-proxy-src.tar.gz proxy'
scp ntl-dev@192.168.0.144:/tmp/bee-proxy-src.tar.gz /tmp/
scp /tmp/bee-proxy-src.tar.gz root@46.225.174.72:/tmp/

# On VM:
ssh root@46.225.174.72 'cd /opt/woco && rm -rf repo-bee-proxy && tar xzf /tmp/bee-proxy-src.tar.gz && mv proxy repo-bee-proxy && docker compose up -d --build bee-proxy'
```

### Top up postage batch (extend TTL)

```bash
# Check current state first (TTL is in seconds). bee-node has no curl; use bee-proxy's wget:
docker exec bee-proxy wget -qO- http://bee-node:1633/stamps | jq '.stamps[] | {batchID, batchTTL, usable, depth, amount}'

# Get current per-block price + current block:
docker exec bee-proxy wget -qO- http://bee-node:1633/chainstate | jq '{block, currentPrice}'

# Topup: amount is per-chunk, paid in PLUR (1 BZZ = 1e16 PLUR). To extend by ~N seconds:
#   extraAmount = ceil(N * currentPrice / blockTime)   (Gnosis blockTime ≈ 5s)
#
# Easy rule of thumb: doubling current amount roughly doubles remaining TTL.
#
# IMPORTANT: Bee v2.x uses PATCH (not POST) for topup/dilute. POST returns 405.
# Funding source: the node's WALLET balance, NOT the chequebook. Endpoint debits wallet directly.
# wget needs --method=PATCH and --body-data='' for an empty-body PATCH:
docker exec bee-proxy wget -qO- --method=PATCH --body-data='' http://bee-node:1633/stamps/topup/<BATCH_ID>/<EXTRA_AMOUNT> | jq

# Verify:
docker exec bee-proxy wget -qO- http://bee-node:1633/stamps | jq '.stamps[] | {batchID, batchTTL}'
```

### System updates (OS patches)

```bash
ssh root@46.225.174.72
apt update && apt upgrade -y
# Reboot only if a kernel update was installed:
[ -f /var/run/reboot-required ] && reboot
```

A reboot brings the whole stack down for ~30s; docker-compose `restart: unless-stopped` auto-restarts everything. Schedule for low-traffic windows. Bee re-warms peers in ~20s.

### Cloudflare Tunnel logs / restart

```bash
systemctl status cloudflared
journalctl -u cloudflared -f --since "10 minutes ago"
systemctl restart cloudflared      # rarely needed
```

### Renew certs

Cloudflare handles TLS at its edge (orange-cloud) — there are no certs on the VM. Nothing to renew.

### Bee funding

The migrated chequebook is `0xd68d3898Ac77F1D16d0B3E023b2A2609e8a24e67`, owned by `0x58D90b1D68C7d4E96756671A4660D49eAcF8CfE3`. Top up xDAI for gas: send to the Ethereum address. Top up xBZZ for stamps: same address (cash out from chequebook first if needed).

### Snapshot backup (one-off, on demand)

```bash
ssh root@46.225.174.72 'docker compose stop bee   # quiesce
cd /opt/woco && tar czf /root/backups/bee-data-$(date +%Y%m%d-%H%M%S).tar.gz bee-data/
docker compose start bee'

# Pull to laptop:
scp root@46.225.174.72:/root/backups/bee-data-<date>.tar.gz ~/backups/woco/
```

(For unattended weekly backups, enable Hetzner Console → Server → Backups, ~€0.90/mo.)

### Decommission laptop (after 2 weeks of clean Hetzner logs)

```bash
ssh ntl-dev@192.168.0.144
# Disable cloudflared (laptop tunnel)
sudo systemctl disable --now cloudflared
# Keep ~/bee_gateway/bee-slam/ and ~/woco-events-server/ on disk for one more month, then archive
```

In the Cloudflare dashboard, delete the old laptop tunnel (Zero Trust → Networks → Tunnels → delete the original woco tunnel).
