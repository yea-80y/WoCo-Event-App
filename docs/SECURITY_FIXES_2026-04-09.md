# Security Fixes — Crypto Audit Implementation (2026-04-09)

Full audit: `docs/CRYPTO_AUDIT_2026-04-08.md`

---

## New Files

| File | Purpose |
|---|---|
| `apps/server/src/lib/payment/tx-registry.ts` | P0 — txHash replay prevention. File-backed Set tracks consumed tx hashes → `.data/consumed-tx-hashes.json` |
| `apps/server/src/lib/auth/revocation.ts` | P1 — Session revocation. Nonce blacklist + per-address "revoke all before" timestamp → `.data/revoked-sessions.json` |
| `packages/shared/src/pod/verify.ts` | P2 — Shared ed25519 ticket signature verification using `@noble/curves/ed25519` |

---

## Modified Files

| File | Finding | Change |
|---|---|---|
| `apps/server/src/lib/payment/constants.ts` | P0 (5.2) | Replaced `MIN_CONFIRMATIONS=1` with per-chain config: mainnet=12, L2s=3, Sepolia=3. Added `getMinConfirmations(chainId)` |
| `apps/server/src/lib/payment/verify.ts` | P0 (5.2) | Uses `getMinConfirmations(proof.chainId)` |
| `apps/server/src/routes/claims.ts` | P0 (5.1) | `checkAndConsumeTxHash()` after payment verification — 409 on replay |
| `apps/server/src/routes/claims.ts` | P1 (9.2) | API key uses `crypto.timingSafeEqual()` with length pre-check |
| `apps/server/src/routes/claims.ts` | P1 (8) | Removed ~290 lines of dead mock payment code (GET mock-payment-page + POST mock-payment) + cleaned unused imports |
| `apps/server/src/routes/claims.ts` | P1 (9.1) | Wallet claim path verifies `sessionSig` against reconstructed body |
| `apps/server/src/routes/claims.ts` | P2 (9.3) | Email identifiers via `buildEmailIdentifier()` — HMAC hash + legacy fallback |
| `packages/shared/src/auth/constants.ts` | P1 (1.3) | `SESSION_EXPIRY_MS` 365 days → 30 days |
| `packages/shared/src/auth/eip712.ts` | P2 (1.1) | Added unique `salt` (bytes32) to `SESSION_DOMAIN` and `POD_IDENTITY_DOMAIN` |
| `packages/shared/src/index.ts` | P2 (9.4) | Re-exports `verifyTicketSignature` from `./pod/verify.js` |
| `apps/server/src/middleware/auth.ts` | P1 (9.1) | `requireAuth` verifies per-request `sessionSig` (EIP-191). Added `stripAuthFields()` helper |
| `apps/server/src/lib/auth/verify-delegation.ts` | P2 (1.2) | Verifies `sessionProof` — recovers signer from `"${host}:${nonce}"` and checks it matches `message.session` |
| `apps/server/src/lib/auth/verify-delegation.ts` | P1 (1.4) | Checks `isSessionRevoked(nonce, parent, issuedAt)` |
| `apps/server/src/index.ts` | P1 (1.4) | Added `POST /api/auth/revoke-session` and `POST /api/auth/revoke-all` |
| `apps/server/src/lib/event/claim-service.ts` | P2 (9.3) | `hashEmail()` is HMAC-SHA256 only — throws if `EMAIL_HASH_SECRET` unset. `hashEmailLegacy()` and `legacyEmailHash` dual-lookup removed in Round 3. `index.ts` fails fast at startup if env var missing |
| `apps/server/src/lib/event/claim-service.ts` | P2 (9.4) | `claimTicket()` calls `verifyTicketSignature()` before creating claimed ticket |
| `apps/web/src/lib/api/client.ts` | P1 (9.1) | `authPost` sends `sessionSig` in body; `authGet` sends `X-Session-Sig` header |
| `apps/web/src/lib/api/events.ts` | P1 (9.1) | `createEventStreaming` sends `sessionSig` in body |

---

## Required .env Addition

```
# HMAC key for email hashing (prevents rainbow table reversal of public Swarm hashes)
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
EMAIL_HASH_SECRET=<64-char-hex>
```

---

## Breaking Changes

| Change | Impact | Action |
|---|---|---|
| EIP-712 domain salt added | Existing session delegations invalid | Users re-delegate on next login (auto, transparent) |
| EIP-712 salt on POD identity domain | **Changes derived ed25519 key** | Only breaks if organisers have published events. Verify before deploying — see warning below |
| Session expiry 30 days | Existing 1-year sessions expire sooner | No action — natural expiry |
| HMAC email hashing (Round 3) | Legacy fallback + dual-lookup removed. Any old unsalted-SHA-256 claims become invisible | Confirm no legacy email claims exist, OR rotate `EMAIL_HASH_SECRET` to resurrect the unsalted case and rehash as HMAC (one-time migration) |
| `EMAIL_HASH_SECRET` mandatory (Round 3) | Server refuses to start without it | Set env var before deploying (generated hex, 32 bytes) |

### WARNING: POD Identity Salt

Adding `salt` to `POD_IDENTITY_DOMAIN` means any user who has **already** derived a POD identity (published an event, used the dashboard) will derive a **different** ed25519 keypair on next sign. Their published tickets reference the old public key.

**Before deploying:** confirm whether any organisers have active POD identities. If yes, either:
1. Delay the POD domain salt change until a migration path is ready, or
2. Remove the salt from `POD_IDENTITY_DOMAIN` only (keep it on `SESSION_DOMAIN`)

Session domain salt is safe to deploy immediately — sessions re-issue transparently.

---

## Deferred (P3 — not yet implemented)

- Dead `ENCRYPTION_DOMAIN`/`ENCRYPTION_TYPES`/`ENCRYPTION_NONCE` constants in `packages/shared/src/crypto/constants.ts` — remove when convenient
- AAD for device-key AES-GCM (`apps/web/src/lib/auth/storage/encryption.ts`)
- Escrow contract `ReentrancyGuard` (`contracts/src/WoCoEscrow.sol`) — before mainnet deploy
- `toUtf8Bytes` → `getBytes` in POD seed derivation — breaking change, only if no existing users
- Persistent file-backed rate limiting — current in-memory is fine until Devcon scale
- Token array length limit in escrow contract
