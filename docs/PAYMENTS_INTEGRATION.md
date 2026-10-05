# Payments Integration — mechanics

Moved out of `CLAUDE.md` (2026-07-27) to keep the always-loaded context small.

**Verified against `main` (94364b56) on 2026-10-05.** Pre-launch: Stripe test keys.

This is the integration detail. Two other docs are authoritative for their own areas
and win over anything here if they disagree:

- **Payouts** → `docs/PAYOUTS.md`
- **Fee arithmetic** (processing rates, Connect platform fees, who pays what) →
  `docs/PRICING_AND_EMAIL.md` §7 / §15–§17

---

## Unified pricing model

- Organiser sets ONE fiat price (GBP/USD/EUR) per tier. Today every tier is card
  (`stripeEnabled`): crypto and free events are off, and the price must be at least
  `MIN_TICKET_PRICE` (1, #694) - checked in the editor and on the server (`routes/events.ts`).
- PaymentConfig (`packages/shared/src/event/types.ts`): `{ price, currency(FiatCurrency),
  recipientAddress, acceptedChains, escrow, cryptoEnabled, stripeEnabled, feePassedToCustomer?,
  buyerFeePercent? }`. The buyer-pays option and its floor are fee arithmetic - see
  PRICING_AND_EMAIL.md.
- The price currency must match the organiser's Stripe payout currency, or Stripe converts every
  sale and bills the organiser the FX fee (#84, `lib/stripe/currency-policy.ts`; fails open while
  the account default is unknown).
- (Crypto rail, off) crypto amounts converted from fiat at quote time (forex → USD → ETH via
  CoinGecko)

---

## Crypto payments — OFF AT LAUNCH

`FEATURES.cryptoPaymentsAllowed = false` in `packages/shared/src/features.ts`. The flag
gates UI *and* server validation in lockstep, so an old client cannot offer crypto past
the API. Deferred to #41.

**Status (2026-10-05): the event-ticket half of this rail is gone, not just unreachable.** The
crypto claim path (tx verification + `claimerProof` binding for a ticket) went with the v1
Swarm claim rail (#207); `routes/claims.ts` now serves only `claim-status`. What survives:
`POST /api/payment/quote` (answers 403 while the flag is off), `lib/payment/*` (verification is
used only by the shop rail, also off) and the `PaymentProof` / `claimerProof` types. Turning
crypto back on needs an onchain mint path for crypto buyers - the flag's own comment, which
predates #207, says the same in older terms (real `priceBaseUnits`, a client
`payAndClaimWithPermit` flow).

The rest of this section records the rail as it was built (history). ETH + USDC on
Base/Optimism/Mainnet/Sepolia:

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
- Platform fee: `application_fee_amount`, computed in `lib/stripe/checkout-fees.ts` from
  `PLATFORM_FEE_BP` (`packages/shared`). Rates: PRICING_AND_EMAIL.md only. A fee that rounds to
  nothing is refused (`MIN_APPLICATION_FEE_MINOR`), which is one reason for `MIN_TICKET_PRICE`.
- **Organisers need a passkey account (#768).** `/connect`, `/onboarding-link` and
  `/account-session` refuse any parent that is not a smart account, because attendee data is
  sealed to a key from the account's seed and only a passkey roots it outside every email and
  wallet key. Passkey and email smart accounts look alike to the server; the app enforces the
  email half.
- Account store: `.data/stripe-accounts.json` (file-backed, same pattern as tx-registry)
- PAYOUTS ARE MANUAL + RELEASED AFTER THE EVENT (2026-07-27). Accounts are created
  `interval: "manual"`; a per-sale ledger + hourly sweep release only what is DUE — a
  connected account has ONE pooled balance across all its events, so never pay out the raw
  balance. Load-bearing limit: funds cannot be held >90 days (UK; per CHARGE, so
  early-bird money releases before its event). On manual, only the platform can initiate
  payouts (confirmed 2026-07-29). Never call it escrow. **Authority: `docs/PAYOUTS.md`.**
- Webhook: `checkout.session.completed` runs `fulfilPaidSession()` (`lib/stripe/fulfilment.ts`).
  A session altered after creation is refunded, never fulfilled; an organiser's own Stripe sale
  (not created by us) is never touched (#645). Ticket sessions arrive on the connected-accounts
  endpoint.
- Onboarding opens in NEW TAB during event creation to preserve form data
- Frontend modal checks auth, prompts WoCo login if needed before Stripe API calls
- Anyone can pay by card; a guest pays with just an email and needs no account.
- The `<woco-tickets>` embed is card-only guest checkout (#141): it holds seats with a countdown
  when the buy panel opens (#570) and returns the buyer to the organiser's page, which confirms
  the order through `GET /api/stripe/checkout-status` (#567, #593).
- `STRIPE_WEBHOOK_SECRET` must be set for production signature verification
- Dual webhook secret: both the platform webhook (`checkout.session.completed`) and the
  connected-accounts webhook (`account.updated` + `checkout.session.completed`) point to the
  same URL. `STRIPE_WEBHOOK_SECRET_PLATFORM` is the platform signing secret;
  `STRIPE_WEBHOOK_SECRET` is the connect-account signing secret. Route tries both.
  `constructEvent` tolerance is 3600s (1 hour) so Stripe retries succeed even if the first
  delivery timed out. Session ID replay prevention (`.data/consumed-stripe-sessions.json`)
  ensures each `checkout.session.completed` is processed exactly once.
- Production rejects unsigned webhooks (prevents forged free-ticket claims)
- Pre-flight on `/api/stripe/create-checkout`: refuses BEFORE creating a session (409) when the
  series is sold out, the event is cancelled, the series is not registered onchain, the sales
  window is closed (server clock or the chain's end), or the order box was already used by
  another sale (#661); 503 while no attendee batch can take the order (#546). Charging for
  something we cannot mint is the failure this prevents.
- `/api/stripe/create-checkout` is rate limited per client IP — 30/min + 300/hour, checked
  after validation and before the first spend, 429 + `Retry-After: 60` (#463)
- Paying by card never opens a wallet. The checkout is signed, and the purchase bound to the
  account, only when a session key is already on the device (`auth.isAuthenticated`, decided
  once per Pay click in `ClaimButton`); otherwise it is the guest path with the form's email.
  The two rare re-mint paths that can still prompt are tracked in #711.
- Fulfilment (paid session → mint → email) lives in `lib/stripe/fulfilment.ts` behind an
  injected-deps seam (#314). Any stop (mint revert, sales closed, unregistered series,
  unreadable event feed) auto-refunds the unfilled part; an issued ticket whose email
  cannot go out is always in the undelivered ledger (`email-failures.json`), whether the
  mailer or the renderer failed. `test/fulfilment.test.ts` makes every collaborator throw
  and asserts that property. An auto-refund that Stripe refuses to create is recorded in
  `.data/pending-refunds.json` and retried every 10 min under the same idempotency key
  (`lib/stripe/pending-refunds.ts`, #367); `/api/health` `pendingRefunds` alarms until it
  lands, and `/api/ops/pending-refunds` lists / retries / resolves.
- Refunds made OUTSIDE fulfilment void the tickets (#645 part C). `.data/ticket-sales.json`
  (`lib/stripe/ticket-sales.ts`) records each paid session's payment intent, the slots each
  mint chunk produced, and what fulfilment refunded itself. `charge.refunded` /
  `refund.updated` / `refund.failed` (`lib/stripe/sale-refunds.ts`) re-read the charge's refunds
  and apply the total, one event per payment intent at a time: refunded in full → every slot
  void; a partial refund above our own → nothing void,
  flagged + `/api/health` `ticketSales` alarm until `/api/ops/ticket-sales/:id/acknowledge-partial-refund`.
  The `charge.dispute.*` events land in the same handler: a chargeback (`needs_response`,
  `under_review`, `lost`) voids every slot, a won dispute lifts it, an inquiry voids nothing;
  anything needing a response alarms (`disputesNeedingResponse`). Payouts hold a sale while
  its dispute is open (docs/PAYOUTS.md).
  Voids key on (onChainEventId, slot), never the orderRef (#661). The handlers never refund.
- **Cancel an event and refund everyone (#644).** `POST /api/events/:id/cancel` (organiser,
  typed-title confirm, refused `ORGANISER_CANCEL_WINDOW_DAYS` = 2 days after the event ends -
  owner decision 2026-09-26; no later than the payout release for dates unchanged since the
  sale. A sale's release date is pinned at fulfilment and the window reads the CURRENT feed, so
  a postponed event stays cancellable after its original-date takings were paid out - those
  refunds then wait for funds) and
  `POST /api/ops/events/:id/cancel` (no window) share one core
  (`lib/event/cancel-event.ts`): persist `.data/event-cancellations.json` FIRST (from then
  on checkout, `/reserve`, `/list`, register-on-chain and site adds refuse; claim-status reads
  `available: 0, cancelled: true`; checkout-status says `cancelled`), unlist, expire open
  checkouts. `lib/stripe/cancellation-refunds.ts` refunds every sale (sale record ∪ payout
  ledger, re-read every pass) for exactly the unrefunded remainder, `reason:
  requested_by_customer`, our fee per `CANCELLATION_RETURNS_PLATFORM_FEE` (off — terms §6),
  then voids the tickets. A sale paid after the cancel is handed to that job by fulfilment.
  Payouts hold a cancelled event's takings until every refund settles, past the ceiling too,
  and a journalled payout intent holding one of its sales is not replayed.
  A refund Stripe holds for `insufficient_funds` alarms (`waitingForFunds`): whole-gross
  refunds with our fee kept leave the event's balance short by the fees, so the organiser
  may need to top up (whether Stripe instead recovers a negative balance from the organiser's
  bank under `losses.payments = stripe` is unverified — do not read the alarm as permanent).
  A state that cannot be written (file unreadable, disk full) answers 500 so Stripe redelivers
  (~3 days). A sale made while the file was unreadable is in memory only: after a restore it
  surfaces as `refundEvents.stuck`, never as an automatic void.

---

## Stripe UX — latency, reservations, composite card (Phases 2–3)

Rationale in git history + the `project_stripe_ux` memory. Load-bearing facts only:

- Order pre-upload: the X-Wing sealed box (v2, at most 16 KB of JSON, #642) goes to
  `/prepare-order`, which returns `orderRef` + an `orderRefToken`; `/create-checkout` accepts the
  ref only with that token (#661), else takes the box inline. **Nothing is stored on Swarm
  before payment (#546):** the box is held in memory at prepare, persisted to
  `.data/held-orders/` when its checkout is created, and stored on the attendee batch once the
  sale is paid, so every order stays erasable.
- Success card on Stripe return: the platform page (`EventPurchased.svelte`) paints from the
  form stash ClaimButton wrote before the redirect, and still asks
  `GET /api/stripe/checkout-status`, the only source for "the event was cancelled while you were
  at Stripe" (#644) and for checkouts that started on another origin (#567).
- Slot reservations: `POST /api/events/:eventId/series/:seriesId/reserve` (+ `/reserve/release`,
  `GET .../held`; 10-min TTL, `.data/reservations.json`, per-series mutex, no Swarm writes).
  `X-Client-Key` header (CORS-allowed) dedups a browser's holds; seats held per IP per event are
  capped by `perIpSeatCapForEvent()` (`lib/event/seat-cap.ts`, scales with declared supply,
  ceiling 30, #223), plus 30 reserve calls/min/IP.
  Webhook late-consumes AFTER all batch claims commit (else heldFor→0 mid-batch lets others
  grab the slots). Partial refund = unfilled portion pro-rata.
  Same-clientKey re-reserve returns existing hold (TTL preserved — can't extend a lock by
  reopening). Server returns `available` (effective) + `physicalAvailable` so UI splits
  "sold out" vs "held by others". No release on tab close (TTL is the window).
- Ticket card: the email attaches a composite PNG (`cid:woco-card-N`), rendered by
  `lib/ticket/render-card.ts` (SVG→800×1100 PNG via `@resvg/resvg-js`, QR as a `<rect>` matrix).
  The emailed link opens a **static** page on the app origin,
  `{appBase}/ticket.html#{eventId}/{seriesId}/{edition}/{sig}?…` (`packages/shared/src/ticket/link.ts`):
  the signature sits in the URL fragment, so it reaches no server. The display fields after `?`
  are unauthenticated; the door decides by the QR alone. The old server route `GET /t/...` now
  answers 410 for links in older emails (`routes/ticket-page.ts`).

---

## Key files

```
apps/server/src/routes/stripe.ts                # Connect: onboarding, checkout, webhook
apps/server/src/lib/stripe/fulfilment.ts        # paid session → mint → refund/email (deps seam, #314)
apps/server/src/lib/stripe/fulfilment-live.ts   # production wiring of that seam
apps/server/src/routes/reservations.ts          # slot reserve/release (Phase 3)
apps/server/src/routes/ticket-page.ts           # /t/* - retired, 410 for old email links
apps/server/src/routes/tickets.ts               # ticket email builder (PNG + ticket.html link)
apps/server/src/lib/stripe/checkout-fees.ts     # application fee + buyer-pays arithmetic
apps/server/src/lib/stripe/checkout-status.ts   # what a returning buyer is told (#567)
apps/server/src/lib/event/seat-cap.ts           # per-IP held-seat cap (#223)
packages/shared/src/ticket/link.ts              # the emailed ticket link format
apps/server/src/lib/event/reservation-store.ts  # .data/reservations.json
apps/server/src/lib/ticket/render-card.ts       # SVG → 800×1100 PNG via resvg-js
apps/server/src/lib/payment/verify.ts           # (crypto, off) onchain ETH + USDC verification - shop rail only
apps/server/src/lib/payment/eth-price.ts        # (crypto, off) fiat→USD→ETH (forex + CoinGecko)
apps/server/src/lib/payment/tx-registry.ts      # (crypto, off) txHash replay prevention
apps/server/src/lib/payment/quote.ts            # (crypto, off) HMAC-signed PaymentQuote
apps/server/src/lib/payment/constants.ts        # (crypto, off) per-chain confirmation thresholds
apps/server/src/lib/stripe/client.ts            # Stripe SDK singleton
apps/server/src/lib/stripe/accounts.ts          # organiser↔Stripe account mapping
apps/web/src/lib/api/stripe.ts                  # Stripe API client
apps/web/src/lib/api/payment.ts                 # (crypto, off) fetchPaymentQuote
apps/web/src/lib/api/reservations.ts            # reserve/release + countdown helpers
apps/web/src/lib/payment/{pay,chains,eth-price}.ts   # (crypto, off)
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
- Unsigned webhooks are refused only when `NODE_ENV=production`; dev accepts them
- The fee constant is `PLATFORM_FEE_BP` in `packages/shared/src/event/types.ts`, shared with
  the escrow contract's figure - change both together
