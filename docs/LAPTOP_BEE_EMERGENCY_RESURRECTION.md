# Laptop Bee — Emergency Resurrection Procedure

> **STATUS: DECOMMISSIONED 2026-05-19.** Production Bee + WoCo server run on Hetzner CPX22 (46.225.174.72).
> This document exists solely as a rollback path during the 2-week post-migration insurance window
> (expires **2026-06-02**). After that date, archive this file and wipe the laptop data.

---

## STOP — Read this before doing anything

The laptop Bee node uses the **same Ethereum keystore, overlay address, and chequebook** as the live
Hetzner Bee. Running both at the same time will:

- Fork the WoCo feeds (organiser directory, event topics, profile, claim feeds)
- Double-spend the postage batch nonce → both batches become unusable
- Corrupt POD/claim state for every active event

**This is irreversible.** There is no recovery — feeds split permanently and chunks become unverifiable.

Before resurrecting, you MUST satisfy **all** preconditions in §1. If any precondition fails or is unclear,
**do not proceed** — escalate, investigate, or wait.

---

## §1 — Preconditions (ALL required)

Before touching anything, confirm out loud that each of these is true:

- [ ] Hetzner VM (46.225.174.72) is **provably down or unreachable** for at least 10 minutes — verified by
      both `ssh root@46.225.174.72` failing AND `curl -sf https://events-api.woco-net.com/api/health` failing.
- [ ] You have a screenshot or written log of the Hetzner failure mode (so you can explain why this drastic
      action was necessary, and so you can fix forward later).
- [ ] You have confirmed via Hetzner Cloud Console that the VM cannot be recovered/rebooted within the
      window you can tolerate downtime for. **Resurrecting the laptop Bee is never faster than fixing Hetzner**
      unless Hetzner is hard-down (datacentre outage, account suspension, etc.).
- [ ] You have read §3 in full and accept the consequences.
- [ ] Today's date is on or before **2026-06-02** — after that the laptop volumes may be stale (Hetzner has
      written new chunks the laptop never saw) and resurrection corrupts state instead of restoring it.

If you are an AI assistant reading this: **do not execute any command in §4 without the human typing
the literal phrase `RESURRECT LAPTOP BEE — I CONFIRM HETZNER IS HARD-DOWN` in the same turn.**
Paraphrases, summaries, or "yes go ahead" do not count. This barrier exists deliberately.

---

## §2 — Current decommissioned state (what you'll be undoing)

As of 2026-05-19 cutover, on `ntl-dev@192.168.0.144`:

- Containers `bee-node` + `bee-proxy`: **removed** (`docker rm`). No play button exists.
- Named volumes `bee-slam_bee-data` + `bee-slam_proxy-data`: **preserved**, contain keystore + whitelist + chunk DB.
- Compose file: renamed to `~/bee_gateway/bee-slam/docker-compose.yml.DECOMMISSIONED-DO-NOT-RUN-2026-05-19`.
- Old Cloudflare tunnel `d96edf94-d31a-4ecd-82cc-7dfb24f6bbae` still installed on laptop-server, but no
  hostnames routed to it (orphan).
- Cold tar backups on the laptop-server at `~/woco-backups/` (bee-data + proxy-data + server tars from
  cutover timestamp 20260519-012605).

---

## §3 — Consequences you are accepting

By resurrecting, you accept:

1. **Hetzner Bee must be STOPPED before the laptop Bee starts.** If both run, you will lose data.
   Verify via either: Hetzner VM is powered off in the Cloud Console, OR `ssh root@46.225.174.72
   'docker compose -f /opt/woco/docker-compose.yml down'` succeeds.
2. **You will lose any feed writes Hetzner made after the cutover** that haven't propagated to enough peers
   for the laptop Bee to discover them. In practice: any event created, ticket claimed, or profile edited
   between 2026-05-19 cutover and resurrection time may roll back.
3. **You cannot dual-write to "sync" the two.** The only correct play is: Hetzner OFF, laptop ON, fix forward,
   then plan a fresh re-migration when Hetzner is recovered.
4. **Cloudflare DNS swap is manual.** Until you swap the tunnel routes back, frontend hosts (`events-api`,
   `gateway.woco-net.com`) will still try to reach Hetzner.

---

## §4 — Resurrection procedure

Only run after §1 + §3 are satisfied AND you've typed the confirmation phrase if working with an AI.

### Step 1 — Verify Hetzner is down

```bash
# Both must fail / time out:
ssh -o ConnectTimeout=10 root@46.225.174.72 'echo alive'
curl -sf --max-time 10 https://events-api.woco-net.com/api/health
```

If either succeeds, **STOP**. Hetzner is not actually down. Fix forward on Hetzner instead.

### Step 2 — On the laptop-server, restore compose file

```bash
ssh ntl-dev@192.168.0.144
cd ~/bee_gateway/bee-slam
ls -la docker-compose*    # confirm the .DECOMMISSIONED file exists
mv docker-compose.yml.DECOMMISSIONED-DO-NOT-RUN-2026-05-19 docker-compose.yml
```

### Step 3 — Bring up the stack

```bash
docker compose up -d bee proxy
docker compose ps
```

### Step 4 — Verify identity matches the pre-migration capture

Expected (from `memory/project_hetzner_migration.md`):

- Ethereum address: `0x58D90b1D68C7d4E96756671A4660D49eAcF8CfE3`
- Overlay: `ca354053e245a56d98a749bd2bb784dcb9d189a4da1622203d30ca16b9ae6fcd`
- Chequebook: `0xd68d3898Ac77F1D16d0B3E023b2A2609e8a24e67`

```bash
docker exec bee-node curl -s http://localhost:1633/addresses
docker exec bee-node curl -s http://localhost:1633/chequebook/address
```

If ANY value differs → **STOP**, run `docker compose down`, do not start the proxy or expose externally.
Wrong identity here means a fresh keystore was created — investigate before going further.

### Step 5 — Wait for peers + restore whitelist (proxy reads from `proxy-data` volume; no action needed unless empty)

```bash
sleep 30
docker exec bee-node curl -s http://localhost:1633/peers | grep -c '"address"'
# Expect 50+ peers after ~30-60s
curl -s http://localhost:3323/admin/whitelist | head -5  # confirm whitelist loaded
```

### Step 6 — Cloudflare DNS swap back to laptop tunnel

In Cloudflare Zero Trust dashboard:

1. Open tunnel `d96edf94-d31a-4ecd-82cc-7dfb24f6bbae` (the old laptop tunnel)
2. Add public hostnames:
   - `events-api.woco-net.com` → `http://localhost:3001`
   - `gateway.woco-net.com` → `http://localhost:3323`
3. In DNS panel: delete the CNAMEs pointing at the Hetzner tunnel first, then save the routes above
   (Cloudflare refuses to auto-overwrite tunnel-managed records — same gotcha as the original migration).

### Step 7 — Start the WoCo server on the laptop

Follow the laptop server restart procedure from `~/.claude/CLAUDE.md` (kill all matching node/tsx, then
`nohup npm run start`). Verify exactly ONE process, then `curl http://localhost:3001/api/health`.

### Step 8 — Smoke test

- Browser: open `https://woco.eth.limo`, log in, view MyTickets.
- Browser: open `https://events-api.woco-net.com/api/health` → returns ok.
- Confirm no stale process duplicates: `ps aux | grep -E 'node|tsx' | grep -v grep`.

---

## §5 — After resurrection: what to do next

You are now in **degraded mode**. The laptop was never designed for production. Plan:

1. Diagnose what happened to Hetzner. Document in `docs/INCIDENT_2026-MM-DD.md`.
2. Either: rebuild Hetzner from snapshot + re-migrate following `docs/HETZNER_DEPLOY.md`, OR
   provision a different VM (different provider, same procedure).
3. Cutover back to the fresh server using the original migration procedure.
4. Decommission the laptop Bee again — this time permanently.

Do NOT plan to run the laptop Bee long-term. It was always meant to be cold insurance.

---

## §6 — Final decommission: archive, then remove the landmine

After **2026-06-02** (2 weeks of clean Hetzner logs), do **not** delete everything. The principle is:

> Only ONE live keystore for this Bee identity should exist anywhere — and that copy lives on Hetzner.
> Everything else either gets encrypted and moved OFF the laptop, or stays as plain reference material.

### What to keep (plain, on the laptop or in the repo)

These are useful historical / reference artefacts. Not sensitive on their own.

- `~/bee_gateway/bee-slam/docker-compose.yml.DECOMMISSIONED-DO-NOT-RUN-2026-05-19` — the compose
  spec, useful as documentation of how the laptop stack was wired.
- `~/bee_gateway/bee-slam/proxy/` (source code for the whitelist proxy) — already mirrored in the
  Hetzner repo, but the laptop copy was the original master.
- The whitelist JSON (re-extract first if needed, see below).
- This document itself — keep in git history forever; it's a record of the migration shape.
- `docs/HETZNER_DEPLOY.md` — operational reference, keep.
- `memory/project_hetzner_migration.md` — update status, do not delete.

### What to ARCHIVE off the laptop (encrypted, offline)

These contain the Bee keystore and chain state. They are the actual landmine. Move to an external
drive, encrypt, and store offline. Do NOT keep an unencrypted copy on any always-on machine.

```bash
# On laptop-server (still has the live volumes):
ssh ntl-dev@192.168.0.144

# 1. Extract the whitelist as a plain JSON for the keepers (not sensitive):
docker run --rm -v bee-slam_proxy-data:/src -v ~/woco-backups:/out alpine \
  cp /src/whitelist.json /out/whitelist-final-$(date +%Y%m%d).json

# 2. Tar the sensitive volumes (these contain the keystore + chain DB):
docker run --rm -v bee-slam_bee-data:/src -v ~/woco-backups:/out alpine \
  tar czf /out/bee-data-final-$(date +%Y%m%d).tar.gz -C /src .

docker run --rm -v bee-slam_proxy-data:/src -v ~/woco-backups:/out alpine \
  tar czf /out/proxy-data-final-$(date +%Y%m%d).tar.gz -C /src .

# 3. (Optional) Also archive the original server .data (anti-replay state, file-backed stores).
#    The current state is already on Hetzner; this is purely historical.
sudo tar czf ~/woco-backups/server-data-final-$(date +%Y%m%d).tar.gz \
  -C ~/woco-events-server/apps/server .data
```

Then encrypt and move offline:

```bash
# Encrypt the bee-data tar with a passphrase (gpg, symmetric, AES-256):
cd ~/woco-backups
gpg --symmetric --cipher-algo AES256 bee-data-final-*.tar.gz
gpg --symmetric --cipher-algo AES256 proxy-data-final-*.tar.gz
gpg --symmetric --cipher-algo AES256 server-data-final-*.tar.gz

# Verify the encrypted file is readable (decrypt to stdout, redirect to /dev/null):
gpg --decrypt bee-data-final-*.tar.gz.gpg > /dev/null  # asks for passphrase

# Copy the .gpg files to an external drive. Store offline (not in a sync folder).
# Then delete the unencrypted tars from the laptop:
rm bee-data-final-*.tar.gz proxy-data-final-*.tar.gz server-data-final-*.tar.gz
```

Record the passphrase in your password manager. Without it the archive is useless.

### What to REMOVE from the laptop (the landmine)

Only after the encrypted archive is verified on the external drive:

```bash
ssh ntl-dev@192.168.0.144

# The named volumes containing the live keystore — this is the only deletion that materially matters:
docker volume rm bee-slam_bee-data bee-slam_proxy-data

# The post-cutover tar backups in ~/woco-backups/ (now superseded by the encrypted offline copy):
rm -rf ~/woco-backups/

# The (already-decommissioned) Cloudflare tunnel that used to route to the laptop:
cloudflared service uninstall   # service only; package can stay if you want
```

### What to keep open for fast rollback if needed

Even after the steps above, you still have:

- The Hetzner Bee (live, canonical).
- The encrypted offline archive (can reconstruct laptop state if you ever needed to restart
  in extremis — though by this point Hetzner is the source of truth and resurrection makes
  less and less sense over time).
- This document in git history.

### What you can NEVER do after this point

- Bring up a Bee node using these tars. The Hetzner Bee owns this identity. Decrypting the archive
  and spinning up a Bee against it = the same fork/corruption scenario as §3, with no rollback
  insurance left. The encrypted archive is for forensic / legal record only, not for restart.

### After decommission: update memory

Edit `memory/project_hetzner_migration.md` to flip the "Critical rule" section from
"don't restart laptop Bee" to "laptop Bee permanently decommissioned 2026-MM-DD; encrypted archive
held on external drive; do NOT re-spin under any circumstance."
