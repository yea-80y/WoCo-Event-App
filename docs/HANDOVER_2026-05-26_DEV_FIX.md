# Handover — local dev fix + CSW auth (2026-05-26)

## Context

Spent the session unblocking local dev (`npm run dev`) after the Hetzner migration
(2026-05-19) had left `apps/server/.env` pointing at the dead laptop bee
(192.168.0.144). Coinbase Smart Wallet (CSW) auth landed in the same session and is
working. Production server on Hetzner was NOT touched.

## What changed (committed 2026-05-26)

### 1. Dev bee now tunnels to Hetzner
- `apps/server/.env` → `BEE_URL=http://localhost:1633` (was the dead laptop bee).
- New wrapper: `apps/server/scripts/dev-with-tunnel.mjs`. Opens SSH port-forward to
  the `bee-node` container as a child process; cleans up on exit. Resolves the
  container IP dynamically (`docker inspect bee-node`) so it survives `docker
  compose down/up` on the VM.
- `apps/server/package.json` `dev` script now invokes the wrapper.
  `dev:notunnel` kept for the rare case you want bare tsx watch.
- **Local dev writes now hit the production Hetzner bee.** Be careful — anything
  you publish from `npm run dev` shows up on real platform feeds.

### 2. Removed legacy global-directory fallback in `/api/events/mine`
The handler was reading the entire 67-entry global event directory whenever the
caller's per-creator index was empty — taking 30-44 seconds over the tunnel for
brand-new users with zero events. The fallback was for "legacy users whose events
predate the per-creator index" but that migration is long done and the index is
written automatically on every event creation. Removed.

If a real legacy user surfaces (creator index empty but global directory has
their events), they'll see an empty list and need a one-shot migration.

### 3. CSW auth (carried over from earlier in session)
- `apps/server/src/lib/auth/verify-delegation.ts` — viem `verifyTypedData` handles
  EOA + ERC-1271 + ERC-6492 in one call (no recover-and-compare; CSW sigs aren't
  EOA-recoverable). Diagnostic `dbg()` logging removed.
- `apps/server/src/lib/auth/smart-wallet-client.ts` (new) — base-sepolia / base
  PublicClient, gated by `SMART_WALLET_VERIFY_CHAIN`.
- `apps/server/.env` — `SMART_WALLET_VERIFY_CHAIN=base-sepolia` added.
- `apps/web/src/lib/auth/coinbase-account.ts` + `signers/coinbase-signer.ts` (new)
  — wraps `@coinbase/wallet-sdk` v4.3.7, `appChainIds: [421614, 42161]` (Arbitrum
  Sepolia + One), `smartWalletOnly: true`.
- `apps/web/src/lib/components/auth/CoinbaseLogin.svelte` (new) — **two-step UI**:
  Step 1 "Connect", Step 2 "Authorize". The split exists because chaining
  `connect → sign` in the same click hit CSW SDK v4's "Communicator rejects
  in-flight listeners on popup unload" race (4001 with no toast).
- `apps/web/src/lib/auth/auth-store.svelte.ts` — `loginCoinbase()`,
  `prefetchCoinbaseSdk()` (warm the dynamic-import chunk on mount/hover/focus so
  the click handler can synchronously call `eth_requestAccounts`).
- `apps/web/src/lib/components/auth/LoginModal.svelte` — wires CoinbaseLogin in.
- `packages/shared/src/auth/types.ts`, `apps/web/src/lib/auth/session-delegation.ts`,
  `apps/server/src/middleware/auth.ts`, `apps/server/src/routes/claims.ts`,
  `apps/server/src/routes/stripe.ts` — incidental edits along the auth path.

## Outstanding popup-blocked behaviour (known, not a bug we own)

Chrome can still pop a "Popup was blocked. Try again." toast on the first connect
in some sessions. That toast is from the CSW SDK itself — it's their graceful
fallback when the browser blocks `window.open`. Clicking Retry inherits a fresh
user gesture and the popup opens. Behaviour expected in any popup-based wallet
flow.

For dev, eliminate it by clicking the address-bar popup-blocked icon and "Always
allow popups from localhost:5173".

## Commits landed

Three commits, top to bottom on `main`:

1. `feat(wallet): Coinbase Smart Wallet auth method` — viem `verifyTypedData`
   for EOA + ERC-1271 + ERC-6492, two-step CoinbaseLogin UI, SDK prefetch,
   `SMART_WALLET_VERIFY_CHAIN` env knob, new files for the smart-wallet client
   and Coinbase signer.
2. `chore(dev): SSH tunnel to Hetzner bee for local dev` — `dev-with-tunnel.mjs`
   wrapper + `npm run dev:server` rewiring + CLAUDE.md doc.
3. `perf(events): drop legacy global-directory fallback in /api/events/mine`
   — eliminates the 30-44s wait for fresh users with empty creator index.

One-off CSW + viem probe scripts (`test-csw-*.mjs`, `test-viem-*.mjs`,
`check-csw-deploy.mjs`, `debug-csw-verify.mjs`) deleted — not needed going
forward.

The `apps/server/.env` changes (`BEE_URL=http://localhost:1633` for dev,
`SMART_WALLET_VERIFY_CHAIN=base-sepolia`) are gitignored. The production
copy on Hetzner needs `SMART_WALLET_VERIFY_CHAIN=base-sepolia` added via
STEP 2 of the deploy procedure (BEE_URL is sed-rewritten on the VM as
always, so no change needed there).

## Production deploy

`.env` has `SMART_WALLET_VERIFY_CHAIN=base-sepolia` added. Deploy with STEP 2 to
push the env to Hetzner. The dev-tunnel changes don't need to be deployed.

## Image upload status

Image upload path goes through `uploadToBytes()` →
`bee.uploadData(POSTAGE_BATCH_ID, bytes, { deferred: true })`. Now writes to the
Hetzner bee via tunnel, which has a valid postage batch. The "broken image" the
user saw earlier was from publishing while BEE_URL pointed at the dead laptop bee
— writes silently failed. After the tunnel fix, new publishes should work end to
end. Re-test by creating an event in `npm run dev`.

## What's next (the user is starting a fresh chat for this)

Next stage of the build — direction TBD. The user has a clean local dev env now:
auth works (MetaMask + CSW), reads work (sites + events), writes should work
(verify by creating a test event), and the popup-blocked Retry click is the only
remaining UX scrape in the CSW flow.
