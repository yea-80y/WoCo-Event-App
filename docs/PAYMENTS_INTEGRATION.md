# Payments Integration — mechanics

Moved out of `CLAUDE.md` (2026-07-27) to keep the always-loaded context small.
This is the integration detail. Two other docs are authoritative for their own areas
and win over anything here if they disagree:

- **Payouts** → `docs/PAYOUTS.md`
- **Fee arithmetic** (processing rates, Connect platform fees, who pays what) →
  `docs/PRICING_AND_EMAIL.md` §7 / §15–§17

---

## Unified pricing model

- Organiser sets ONE fiat price (GBP/USD/EUR) + toggles cryptoEnabled/stripeEnabled
- PaymentConfig: `{ price, currency(FiatCurrency), recipientAddress, acceptedChains,
  escrow, cryptoEnabled, stripeEnabled }`
- Crypto amounts converted from fiat at claim time (forex → USD → ETH via CoinGecko)

---

## Crypto payments — OFF AT LAUNCH

`FEATURES.cryptoPaymentsAllowed = false` in `packages/shared/src/features.ts`. The flag
gates UI *and* server validation in lockstep, so an old client cannot offer crypto past
the API. Everything below is built but unreachable. Deferred to #41, not deleted.

Why it is off (from the flag's own comment): the rail is half-built — payment verifies
on-chain but the ticket mints Swarm-only (`claims.ts` has no on-chain branch), so crypto
buyers would get a weaker "ledger" verdict at the door and stay platform-signed.
De-platforming it needs events registered with a real `priceBaseUnits` (today `0n`) plus
a client-side `payAndClaimWithPermit` flow.

ETH + USDC on Base/Optimism/Mainnet/Sepolia:

- Escrow (`WoCoEscrow.sol`, time-locked) or direct transfer
- SIGNED QUOTE FLOW (Phase 1, 2026-04-18 — canonical): client MUST fetch
  `POST /api/payment/quote` first. Server returns HMAC-SHA256-signed `PaymentQuote`
  committing to exact `amountWei`. Client pays EXACTLY that wei; server verifies by
  exact-match against `tx.value`. Eliminates the client/server oracle race that caused
  slippage failures.
- Quote TTL: 180s, one-shot (consumed on successful claim via `.data/consumed-quotes.json`).
  `PAYMENT_QUOTE_SECRET` env required.
- Server verifies on-chain: tx hash + chain + amount (exact) + recipient + confirmations + `tx.from`
- Per-chain confirmation thresholds: mainnet=12, L2s=3
- Confirmation wait uses `provider.waitForTransaction()` (not receipt math — RPC head-skew
  caused false rejections)
- txHash replay prevention: file-backed Set in `.data/consumed-tx-hashes.json`
- Payment→claimer binding: `tx.from` MUST match the authenticated claimer.
  Wallet mode: bound to verified `parentAddress`.
  Email/passkey: client must include `claimerProof` — EIP-191 sig by the paying wallet over
  `woco-payment-v1:{txHash}:{eventId}:{seriesId}:{identifier}`. Without this, an attacker
  could front-run any pending payment from the mempool.
- Payment proof saved to `sessionStorage` before claim (recovery if claim fetch fails)
- Phase 2 (future): atomic mint contract — single tx reverts payment + mint together.
  Recommended design: Option A (on-chain quote commitment + self-serve refund);
  Option B/NFT mint is the end-state.

---

## Stripe payments (card via Stripe Connect) — the only live rail

- Managed Risk accounts (issue #90): created with controller properties
  (`stripe_dashboard.type=express · fees.payer=account · losses.payments=stripe ·
  requirement_collection=stripe`), hosted onboarding (Account Links). NEVER `type:
  "express"` — that shape is permanently platform-liable and cannot be converted.
- DIRECT charges on the connected account (`{stripeAccount}`, no `transfer_data`): the
  ORGANISER is merchant of record — their name on checkout + the buyer's statement, their
  dispute liability first-line. Platform takes `application_fee_amount`. NOT destination
  charges (corrected 2026-07-26). Unrecoverable negative balances fall on STRIPE under
  Managed Risk. See `docs/legal/DATA_INVENTORY.md` §5.1–5.2.
- Platform fee: 1.5% (`application_fee_amount`) — matches escrow contract (150 bp).
- Account store: `.data/stripe-accounts.json` (file-backed, same pattern as tx-registry)
- PAYOUTS ARE MANUAL + RELEASED AFTER THE EVENT (2026-07-27). Accounts are created
  `interval: "manual"`; a per-sale ledger + hourly sweep release only what is DUE — a
  connected account has ONE pooled balance across all its events, so never pay out the raw
  balance. Load-bearing limit: funds cannot be held >90 days (UK; per CHARGE, so
  early-bird money releases before its event). On manual, only the platform can initiate
  payouts (confirmed 2026-07-29). Never call it escrow. **Authority: `docs/PAYOUTS.md`.**
- Webhook: `checkout.session.completed` auto-claims ticket via `claimTicket()`.
  Webhook source: "Connected and v2 accounts" (NOT "Your account")
- Onboarding opens in NEW TAB during event creation to preserve form data
- Frontend modal checks auth, prompts WoCo login if needed before Stripe API calls
- Passkey/any user can pay by card; wallet users can also choose card
- `STRIPE_WEBHOOK_SECRET` must be set for production signature verification
- Dual webhook secret: both the platform webhook (`checkout.session.completed`) and the
  connected-accounts webhook (`account.updated` + `checkout.session.completed`) point to the
  same URL. `STRIPE_WEBHOOK_SECRET_PLATFORM` is the platform signing secret;
  `STRIPE_WEBHOOK_SECRET` is the connect-account signing secret. Route tries both.
  `constructEvent` tolerance is 3600s (1 hour) so Stripe retries succeed even if the first
  delivery timed out. Session ID replay prevention (`.data/consumed-stripe-sessions.json`)
  ensures each `checkout.session.completed` is processed exactly once.
- Production rejects unsigned webhooks (prevents forged free-ticket claims)
- Pre-flight check on `/api/stripe/create-checkout`: returns 409 if sold out or user already
  has a ticket (prevents charge-without-ticket race)
- Auto-refund on claim failure for unrecoverable reasons (Already claimed, No tickets
  available, Series not found); transient failures skipped

---

## Stripe UX — latency, reservations, composite card (Phases 2–3)

Rationale in git history + the `project_stripe_ux` memory. Load-bearing facts only:

- Order pre-upload: SealedBox pushed to `/prepare-order` on idle (Pay passes
  `pendingOrderRef` → near-instant redirect); `/create-checkout` falls back to inline upload
  (parallel with getEvent/getClaimStatus). Orphan refs harmless.
- Optimistic success card on Stripe return (email-only events): "ticket on its way to X"
  immediately, no polling/QR/MyTickets; persisted to sessionStorage.
- Slot reservations: `/api/reservations/reserve` (~10min TTL, `.data/reservations.json`,
  per-series mutex, no Swarm writes). `X-Client-Key` header (CORS-allowed) dedups a browser's
  holds; `RESERVATION_MAX_SEATS_PER_IP=30` + 30/min/IP rate limit.
  Webhook late-consumes AFTER all batch claims commit (else heldFor→0 mid-batch lets others
  grab the slots). Partial refund = unfilled portion pro-rata.
  Same-clientKey re-reserve returns existing hold (TTL preserved — can't extend a lock by
  reopening). Server returns `available` (effective) + `physicalAvailable` so UI splits
  "sold out" vs "held by others". No release on tab close (TTL is the window).
- Composite ticket card: user-facing `GET /t/{eventId}/{seriesId}/{edition}/{sig}[.png]`
  (no `/api` prefix). PNG regex route `:sig{.+\\.png}` MUST precede the HTML catch-all;
  `?n=`/`?e=` display-only, path sig is the crypto guarantee. Renderer
  `lib/ticket/render-card.ts` = SVG→800×1100 PNG via `@resvg/resvg-js` (QR as `<rect>`
  matrix). Email attaches PNG `cid:woco-card-N`. `PUBLIC_API_BASE` env required.

---

## Key files

```
apps/server/src/routes/stripe.ts                # Connect: onboarding, checkout, webhook
apps/server/src/routes/reservations.ts          # slot reserve/release (Phase 3)
apps/server/src/routes/ticket-page.ts           # /t/{...} HTML page + composite PNG
apps/server/src/lib/event/reservation-store.ts  # .data/reservations.json
apps/server/src/lib/ticket/render-card.ts       # SVG → 800×1100 PNG via resvg-js
apps/server/src/lib/payment/verify.ts           # on-chain ETH + USDC verification
apps/server/src/lib/payment/eth-price.ts        # fiat→USD→ETH (forex + CoinGecko)
apps/server/src/lib/payment/tx-registry.ts      # txHash replay prevention
apps/server/src/lib/payment/quote.ts            # HMAC-signed PaymentQuote (Phase 1)
apps/server/src/lib/payment/constants.ts        # per-chain confirmation thresholds
apps/server/src/lib/stripe/client.ts            # Stripe SDK singleton
apps/server/src/lib/stripe/accounts.ts          # organiser↔Stripe account mapping
apps/web/src/lib/api/stripe.ts                  # Stripe API client
apps/web/src/lib/api/payment.ts                 # fetchPaymentQuote (Phase 1)
apps/web/src/lib/api/reservations.ts            # reserve/release + countdown helpers
apps/web/src/lib/payment/{pay,chains,eth-price}.ts
apps/web/src/lib/creator/dashboard/StripeConnect.svelte
apps/web/src/lib/creator/dashboard/StripeConnectModal.svelte
```

## Gotchas

- `.data/stripe-accounts.json` MUST survive server restarts (same as tx-hashes,
  revoked-sessions)
- Same for `.data/stripe-payout-ledger.json` — losing it either strands organiser funds in a
  frozen balance or releases them with no record of which event they belong to. After
  deploying payout changes run `npx tsx scripts/payout-schedule-audit.ts` (add `--fix`) —
  accounts created before manual payouts shipped are on Stripe's automatic schedule and are
  NOT being held
- Stripe onboarding redirects go back to the Origin host — `ALLOWED_HOSTS` must include it
- Onboarding opens in new tab during event creation (preserves form state)
- Webhook endpoint: `POST /api/stripe/webhook` — needs raw body for signature verification
- Platform fee hardcoded in `stripe.ts` `application_fee_amount` — keep in sync with the
  escrow contract
