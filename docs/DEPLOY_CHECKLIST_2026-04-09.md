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

### Session revocation persistence
- [ ] `ls -la ~/woco-events-server/.data/` — confirm `revoked-sessions.json` and `consumed-tx-hashes.json` exist after first use
- [ ] Restart the server — confirm revoked sessions are still rejected after restart

---

## 6. Known unresolved items (NOT in scope for this deploy)

- `.data/` may not be in `.gitignore` — check before next commit. If the server ever runs inside the repo dir (it doesn't today, but the `scripts/` dir does), these state files could leak.
- `apps/web/src/lib/auth/pod-identity.ts` still uses `keccak256(toUtf8Bytes(signature))` — hashes the hex *string* of the signature instead of its bytes. Works, but not canonical. **Round 4 fix, breaking change** — will regenerate the ed25519 key for any previously-used POD identity.
- Dead `ENCRYPTION_DOMAIN`/`ENCRYPTION_TYPES`/`ENCRYPTION_NONCE` constants still present in `packages/shared/src/crypto/constants.ts` — Round 4 cleanup.
- `apps/web/src/lib/auth/storage/encryption.ts` device-key AES-GCM has no AAD — Round 4 defense in depth.
- Passkey / wallet-signed claim still uses EIP-191 `personal_sign` — migrating to EIP-712 typed data is a planned Round 4 improvement.
- Session revocation file grows unbounded until server restart — prune expired nonces periodically (Round 4).
- WoCoEscrow.sol not yet deployed to mainnet/Base — needs `ReentrancyGuard` + token array cap before mainnet.

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
git revert 69e312e d262a81 a448cc9   # revert the three audit commits
# or, nuclear option (discards uncommitted work too):
# git reset --hard 1003689
# (only do this if you're SURE)
```

Then redeploy the older build. `EMAIL_HASH_SECRET` and `ALLOWED_HOSTS` can stay in `.env` — the older server ignores them gracefully.
