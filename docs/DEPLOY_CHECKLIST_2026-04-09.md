# Deploy Checklist — Crypto Audit Rollout (2026-04-09)

**Status**: NOT YET DEPLOYED. None of the audit work has been tested end-to-end against the live backend. Every item below is either a config change you must make, a test you must run, or a breaking change you must confirm is safe.

**Author**: captured during the audit rounds — keep this up to date as items are completed. Delete the file after a successful deploy.

Full context: `docs/CRYPTO_AUDIT_2026-04-08.md`, `docs/SECURITY_FIXES_2026-04-09.md`.

---

## 1. Pre-deploy config changes (laptop master `apps/server/.env`)

These MUST be set before the server will boot after this deploy. The laptop `.env` is synced to the server on every rsync — edit it locally first.

- [ ] **`EMAIL_HASH_SECRET`** — mandatory. Server refuses to start without it.
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
  Copy the output into `apps/server/.env` as `EMAIL_HASH_SECRET=<hex>`.

- [ ] **`ALLOWED_HOSTS`** — verify it includes every frontend host currently in production:
  - `gateway.woco-net.com`
  - `woco.eth.limo`
  - any site-builder-generated ENS subdomains you want to keep working
  - add `localhost:5173,localhost:3001` ONLY if you want dev access through the same server (prod usually doesn't need it)

  Production `NODE_ENV=production` + missing `ALLOWED_HOSTS` = server refuses to boot (this is the fail-fast added in Round 1).

- [ ] **`NODE_ENV=production`** — confirm it's set on the server. The fail-fast only triggers with this.

- [ ] Confirm `FEED_PRIVATE_KEY`, `POSTAGE_BATCH_ID`, `BEE_URL`, `PORT` are all still correct (unchanged by this work, but verify before redeploying).

---

## 2. Pre-deploy local builds

Run every build locally and confirm clean output:

- [ ] `npm run build:server`
- [ ] `npm run build:web`
- [ ] `npm run build:embed`
- [ ] `npm run build:site` (only if you plan to regenerate any site-builder bundles)

---

## 3. Breaking changes — confirm safe to ship

You've told me there are no real users, so all of these are fine to ship as-is. Noting them here in case anything comes back up:

- [x] **POD_IDENTITY_DOMAIN salt** — changes the derived ed25519 keypair for any user who has previously signed `DerivePodIdentity`. Any tickets they published reference the OLD key and will fail `verifyTicketSignature()`.
  - Confirmed acceptable: no real users, test data only.

- [x] **HMAC email hashing + legacy path removed** — any old unsalted-SHA-256 email claims become invisible to dedup lookups and `claimers` feed reads.
  - Confirmed acceptable: no real users, test data only.

- [x] **`SESSION_EXPIRY_MS` 365 days → 30 days** — existing long-lived sessions still work until their natural expiry.
  - Zero action required.

- [x] **Canonical request signing** — every existing client-side session cache is incompatible with the new format. Users will re-sign on next interaction (transparent via `ensureSession`).
  - Zero action required.

- [x] **`/api/events/discover` cross-server delegation forwarding removed** — if you're running the discover endpoint against an external server that hosts unlisted events, they won't appear. Discover now always falls through to the public directory. Listed events still work normally.
  - Confirmed acceptable: no production use of cross-server discovery today.

- [x] **Payment `tx.from` binding** — any cached/stored payment proofs from before this change lack the `from` field. Server will reject them with "Transaction signed by ..., expected ...".
  - Confirmed acceptable: no live pending payments.

### Round 4 (commit `ecbe127`, 2026-04-09)

- [x] **Passkey / embed wallet claims now EIP-712** — old EIP-191 `woco:claim:<eventId>:<seriesId>:<timestamp>` signatures are rejected. Embed IIFE bundle must be rebuilt AND redeployed (`npm run build:embed` → rsync → server serves it at `/embed/woco-embed.js`). Any page that loaded the old embed within the last hour may retry the claim with a stale `woco-embed.js` and get "Invalid signature"; hard-refresh fixes it.
  - Confirmed acceptable: no real users, test data only.

- [x] **POD seed byte fix (`toUtf8Bytes` → `getBytes`)** — any user who derived a POD identity before this commit gets a *different* ed25519 key on next derivation. Tickets signed under the old key fail `verifyTicketSignature`. Same breakage surface as the POD domain salt change, same mitigation (none — just re-derive).
  - Confirmed acceptable: no active POD identities.

- [x] **AES-GCM AAD on device-key ciphertexts** — any IndexedDB blob encrypted before this commit (local-account key, session key, session delegation, POD seed) becomes undecryptable. Users transparently re-login / re-derive. Only affects people who had the app open before the deploy.
  - Zero action required beyond the expected re-login flow.

- [x] **Revocation file format v1** — `.data/revoked-sessions.json` auto-migrates on first load (legacy `string[]` → `{nonce, expiresAt}[]`, assuming worst-case expiry of now + 30 days). Look for `[revocation] Migrated N legacy revoked nonces` in `server.log` after first boot — expected if the file existed before.
  - Zero action required, just watch for the log line.

---

## 4. Deploy procedure

Follow the standard deploy from `CLAUDE.md`:

```bash
# Rsync source to server
rsync -avz --exclude='node_modules' --exclude='.git' --exclude='dist' \
  apps/server/ ntl-dev@192.168.0.144:~/woco-events-server/apps/server/
rsync -avz --exclude='node_modules' \
  packages/shared/ ntl-dev@192.168.0.144:~/woco-events-server/packages/shared/
rsync -avz packages/embed/dist/ \
  ntl-dev@192.168.0.144:~/woco-events-server/packages/embed/dist/

# Build on server
ssh ntl-dev@192.168.0.144 'cd ~/woco-events-server && npm run build'

# Stop existing processes (CRITICAL — avoid duplicates)
ssh ntl-dev@192.168.0.144 "ps aux | grep -E 'node|tsx' | grep -v grep"
# Kill every matching PID:
ssh ntl-dev@192.168.0.144 "kill <pid1> <pid2> ..."
# Wait and verify no processes remain:
sleep 2
ssh ntl-dev@192.168.0.144 "ps aux | grep -E 'node|tsx' | grep -v grep"
# (expect empty output)

# Start fresh
ssh ntl-dev@192.168.0.144 "cd ~/woco-events-server && nohup npm run start > server.log 2>&1 & disown"
sleep 3
curl http://localhost:3001/api/health  # from local if tunnel is up, or via ssh
```

- [ ] Server starts without fatal startup errors (check `server.log` for "FATAL" — should be none)
- [ ] Exactly one `node|tsx` process running on the server
- [ ] `curl https://events-api.woco-net.com/api/health` returns `{ok:true}`

---

## 5. Post-deploy smoke tests

### Auth
- [ ] Sign in with a web3 wallet (MetaMask) — should create a new delegation via EIP-712 (new salt means it re-signs)
- [ ] Call any authenticated endpoint (e.g. `/api/events/mine`) — should succeed
- [ ] `POST /api/auth/revoke-session` — should invalidate the current session (next call returns 403)
- [ ] `POST /api/auth/revoke-all` — should invalidate every session for the parent

### Event creation
- [ ] Create an event with a paid series (ETH or USDC)
- [ ] Verify the event shows up in the global directory
- [ ] Verify it shows in the organiser's `/api/events/mine`

### Ticket claim — wallet
- [ ] Claim a free ticket via the main app
- [ ] Claim a paid ticket (ETH): pay via MetaMask, confirm claim succeeds
- [ ] **Critical**: confirm the server logs show `tx.from` matching the claimer address (no "Transaction signed by X, expected Y" errors)

### Ticket claim — email (embed widget)
- [ ] Submit an email claim via the embed widget on a test event
- [ ] Confirm a claimed entry appears in the organiser dashboard
- [ ] Verify the email hash in the claimers feed is 64 hex chars (HMAC-SHA256 output — same length as unsalted, but different value)

### Payment front-running binding (NEW in Round 2)
- [ ] Send a payment tx with Wallet A, then try to claim with Wallet B using the same txHash — should 402 "Transaction signed by A, expected B"
- [ ] Wallet A claims the same txHash — should succeed
- [ ] Wallet A tries to claim a second ticket with the same txHash — should 409 "already used"

### EIP-712 claim signatures (NEW in Round 4)
- [ ] Embed widget + MetaMask: click "Connect Wallet & Claim". Wallet should render a structured typed-data prompt showing `eventId / seriesId / claimer / timestamp`, NOT an opaque `woco:claim:...` string.
- [ ] Embed widget + passkey: authenticate via passkey and claim. Server accepts the signature (exercises the hand-rolled noble digest → `verifyTypedData` round trip).
- [ ] Server logs show no "Invalid signature" 403s on either path.

### Session revocation persistence
- [ ] `ls -la ~/woco-events-server/.data/` — confirm `revoked-sessions.json` and `consumed-tx-hashes.json` exist after first use
- [ ] Restart the server — confirm revoked sessions are still rejected after restart

---

## 6. Known unresolved items (NOT in scope for this deploy)

All Round 4 items landed in commit `ecbe127`. Remaining work:

- **WoCoEscrow.sol hardening** — before mainnet/Base deploy, add:
  - `ReentrancyGuard` on `deposit()` / `claim()` / `refund()`
  - Token array length cap (`require(tokens.length <= 20)` or similar)
  - Per-claimer deposit binding so an attacker can't claim someone else's escrow slot with their own address
- **Rate limiting persistence** — current in-memory rate limiter resets on every restart. Fine for Devcon scale, revisit if it becomes a problem.

---

## 7. If something breaks

1. **Server won't start** — check `server.log` for the exact fatal message. Most likely cause: `EMAIL_HASH_SECRET` or `ALLOWED_HOSTS` missing. Fix `.env`, re-rsync, restart.
2. **Every authenticated request 403s** — likely `ALLOWED_HOSTS` doesn't include the caller's host. Check the 403 response body — it'll name the offending host.
3. **Every payment claim 402s with "Transaction signed by"** — client is sending a payment proof without `from`, or with the wrong `from`. Verify the client build includes the Round 2 `pay.ts` changes. Rebuild the frontend and redeploy to Swarm.
4. **Dashboard can't decrypt orders** — POD_IDENTITY_DOMAIN salt regenerated the ed25519 key; the organiser needs to re-derive their POD identity (sign again). Orders encrypted with the OLD key are unrecoverable (again: confirmed OK since no real users).

---

## 8. Rollback

If the deploy goes sideways and you need to revert:

```bash
git log --oneline -10   # find the pre-audit commit (1003689 or earlier)
# Revert the audit commits in reverse order:
git revert ecbe127 8ad0a4b 69e312e d262a81 a448cc9
# or, nuclear option (discards uncommitted work too):
# git reset --hard 1003689
# (only do this if you're SURE)
```

Then redeploy the older build. `EMAIL_HASH_SECRET` and `ALLOWED_HOSTS` can stay in `.env` — the older server ignores them gracefully.
