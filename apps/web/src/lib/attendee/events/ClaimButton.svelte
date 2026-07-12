<script lang="ts">
  import type { OrderField, SealedBox, ClaimMode, PaymentConfig, PaymentChainId, PaymentProof, ClaimedTicket } from "@woco/shared";
  import { sealJson, USDC_ADDRESSES } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { claimTicket, claimTicketByEmail, getClaimStatus } from "../../api/events.js";
  import { createCheckoutSession } from "../../api/stripe.js";
  import type { SeriesClaimStatus } from "@woco/shared";
  import { cacheGet, cacheSet, cacheDel, cacheKey, TTL } from "../../cache/cache.js";
  import { onMount } from "svelte";
  import ConnectWalletModal from "../../components/profile/ConnectWalletModal.svelte";
  import {
    CURRENCY_SYMBOLS,
    getEmailFromForm as getEmailFromFormPure,
    effectiveMethod as effectiveMethodPure,
    buildOrderSnapshot as buildOrderSnapshotPure,
  } from "./claim/helpers.js";
  import { calculateBuyerFees } from "./claim/fees.js";
  import StripeSuccessCard from "./claim/StripeSuccessCard.svelte";
  import ShortfallReceipt from "./claim/ShortfallReceipt.svelte";
  import ReservationPill from "./claim/ReservationPill.svelte";
  import ChainSelector from "./claim/ChainSelector.svelte";
  import StripePayPanel from "./claim/StripePayPanel.svelte";
  import OrderForm from "./claim/OrderForm.svelte";
  import { useReservation } from "./claim/useReservation.svelte.js";
  import { useOrderPrefetch } from "./claim/useOrderPrefetch.svelte.js";
  import { useShortfall } from "./claim/useShortfall.svelte.js";
  import { useStripeSuccess } from "./claim/useStripeSuccess.svelte.js";

  interface Props {
    eventId: string;
    seriesId: string;
    totalSupply: number;
    /** Organizer's X25519 public key — present when event collects info */
    encryptionKey?: string;
    /** Order form fields — present when event collects info */
    orderFields?: OrderField[];
    /** How attendees can claim (default: "wallet") */
    claimMode?: ClaimMode;
    /** When true, claiming creates a pending request instead of instant ticket */
    approvalRequired?: boolean;
    /** Override API base URL — used when event is hosted on an organiser's own server */
    apiUrl?: string;
    /** Crypto payment config — present for paid events */
    payment?: PaymentConfig;
    /** Event end date ISO string — used to set escrow release time (end + 48h) */
    eventEndDate?: string;
    /** Number of tickets requested (default 1) */
    quantity?: number;
    /**
     * Pre-arm the reservation trigger on mount. Use this when the user has
     * already committed to checkout before ClaimButton renders (e.g. tapped
     * "Get tickets" on EventPage). Without `eager`, the reservation pill only
     * appears once they click a payment button inside the claim panel — which
     * is too late, because the seat hold is most valuable BEFORE they start
     * filling out the form.
     */
    eager?: boolean;
    /** Called when a claim succeeds — parent can show the TicketSuccess modal */
    onclaim?: (data: { edition: number | null; claimedVia: "wallet" | "email" | null; ticket?: ClaimedTicket; claimerEmail?: string; editions?: Array<{ edition: number; ticket?: ClaimedTicket }> }) => void;
  }

  let { eventId, seriesId, totalSupply, encryptionKey, orderFields, claimMode = "wallet", approvalRequired = false, apiUrl, payment, eventEndDate, quantity = 1, eager = false, onclaim }: Props = $props();

  console.log(`[ClaimButton] seriesId=${seriesId} payment:`, payment ?? "FREE");

  // ──────────────────────────────────────────────────────────────
  // Payment + crypto-pay state
  // ──────────────────────────────────────────────────────────────
  const isPaid = $derived(!!payment && parseFloat(payment.price) > 0);
  const hasCrypto = $derived(!!payment?.cryptoEnabled && (payment?.acceptedChains?.length ?? 0) > 0);
  const hasStripe = $derived(!!payment?.stripeEnabled);
  let stripeLoading = $state(false);
  let stripeEmail = $state("");
  /** Last successfully claimed ticket (available for wallet/email direct claims, not Stripe webhook) */
  let lastClaimedTicket = $state<ClaimedTicket | undefined>(undefined);
  const stripeSuccess = useStripeSuccess({ eventId, seriesId });
  let showChainSelector = $state(false);
  let selectedChain = $state<PaymentChainId | null>(null);
  let paymentProofResult = $state<PaymentProof | null>(null);
  /** ETH equivalent for fiat-priced events (fetched when chain selector opens) */
  let ethEquivalent = $state<string | null>(null);
  let ethPriceLoading = $state(false);
  /** User's chosen payment method — ETH or USDC */
  let selectedPayMethod = $state<"ETH" | "USDC">("ETH");
  // Safety net: any time the selected chain has no USDC, force ETH. Covers the
  // auto-select-single-chain path at line ~549 and any other setter that
  // bypasses the onclick handler at the chain card.
  $effect(() => {
    if (selectedChain && !USDC_ADDRESSES[selectedChain] && selectedPayMethod === "USDC") {
      selectedPayMethod = "ETH";
    }
  });
  /** Card-first users: passkey (no crypto wallet upfront). Crypto-first: web3. */
  const isCardFirst = $derived(auth.kind === "passkey" || !auth.kind);

  const buyerFees = $derived(calculateBuyerFees(payment, quantity));

  const priceLabel = $derived(
    payment
      ? `${CURRENCY_SYMBOLS[payment.currency] || ""}${payment.price}`
      : "",
  );
  /** Whether USDC is available on the selected chain */
  const usdcAvailableOnChain = $derived(
    selectedChain ? !!USDC_ADDRESSES[selectedChain] : false,
  );
  /** Whether the user can choose between ETH and USDC (fiat-priced + chain supports USDC) */
  const showPayMethodChoice = $derived(
    isPaid && usdcAvailableOnChain,
  );
  // ──────────────────────────────────────────────────────────────
  // Status + claim outcome state
  // Synchronous cache init — runs before first render so the claim button
  // shows the correct state (claimed / pending / available) immediately.
  // ──────────────────────────────────────────────────────────────
  const _addr = auth.parent?.toLowerCase();

  // 1. Permanent claimed cache — checked first (most valuable: zero network calls)
  const _permanentKey = _addr ? cacheKey.claimed(eventId, seriesId, _addr) : null;
  const _permanentClaimed = _permanentKey
    ? cacheGet<{ edition: number; via: "wallet" | "email" }>(_permanentKey)
    : null;

  // 2. Claim status cache (availability count, pending state)
  const _statusKey = cacheKey.claimStatus(eventId, seriesId, _addr);
  const _cachedStatus = _permanentClaimed
    ? null // no need — we already know the final state
    : cacheGet<SeriesClaimStatus>(_statusKey);

  let status = $state<SeriesClaimStatus | null>(_cachedStatus ?? null);
  let claiming = $state(false);
  let error = $state<string | null>(null);
  let step = $state("");
  // Tracks whether we've fetched claim-status with a real address.
  // Prevents double-fetch in the normal flow; enables re-fetch when auth
  // restores asynchronously after a hard page refresh.
  let _fetchedWithAddr = false;
  let claimed = $state(_permanentClaimed !== null);
  let claimedEdition = $state<number | null>(_permanentClaimed?.edition ?? null);
  /** Post-claim message shown instead of the badge subtitle */
  let claimedVia = $state<"wallet" | "email" | null>(_permanentClaimed?.via ?? null);
  /** True when the claim was submitted but awaiting organizer approval */
  let approvalPending = $state(
    !_permanentClaimed && (_cachedStatus?.userPendingId != null)
  );
  let pendingId = $state<string | null>(_cachedStatus?.userPendingId ?? null);

  // Order form state
  // ──────────────────────────────────────────────────────────────
  // Order form + claim-mode state
  // ──────────────────────────────────────────────────────────────
  const hasOrderForm = $derived(!!orderFields?.length && !!encryptionKey);
  let showOrderForm = $state(false);
  let formData = $state<Record<string, string>>({});
  /** When claimMode is "both", which method has the user picked? */
  let chosenMethod = $state<"wallet" | "email" | null>(null);
  /** When true, the order form was opened to collect data before Stripe checkout */
  let stripeAfterForm = $state(false);
  /** Show the connect wallet modal for passkey/local users wanting to pay crypto */
  let showWalletModal = $state(false);
  /** Inline email input for email claims when no email field in order form */
  let inlineEmail = $state("");
  /** Whether the order form already includes an email-type field */
  const hasEmailField = $derived(
    !!orderFields?.some((f) => f.type === "email" || f.id === "__email")
  );

  /** True while we refresh availability / Stripe status when the form opens. */
  let prefetching = $state(false);
  /** Bumped by hover/focus/touchstart on Pay to fire pre-upload immediately. */
  let payHoverTick = $state(0);
  /**
   * Guards the "mount trigger" reservation conditions below. Must be flipped
   * to true by an explicit user gesture (Pay / Claim button click) before the
   * email-only / card-first fee-sheet conditions can arm a reservation.
   *
   * Without this gate, EVERY ClaimButton on the page would immediately reserve
   * a slot on mount, creating phantom holds for series the buyer never touched.
   * showOrderForm and showChainSelector are already gated on user interaction
   * by definition; only the fee-sheet "early trigger" needs this extra guard.
   *
   * Parent components can pre-arm this via the `eager` prop when the user has
   * already committed to checkout before ClaimButton mounted (e.g. EventPage
   * mounts us only after "Get tickets" is clicked).
   */
  let intentToCheckout = $state(eager);

  // ──────────────────────────────────────────────────────────────
  // Validation + claim-input helpers
  // ──────────────────────────────────────────────────────────────
  const formValid = $derived(() => {
    if (!orderFields?.length) return true;
    return orderFields.every((f) =>
      !f.required || (formData[f.id] ?? "").trim().length > 0
    );
  });

  // Wallet claims skip the __email required check — email identity is only
  // mandatory for email-only mode. Wallet users should never be blocked by it.
  const walletFormValid = $derived(() => {
    if (!orderFields?.length) return true;
    return orderFields.every((f) =>
      f.id === "__email" || !f.required || (formData[f.id] ?? "").trim().length > 0
    );
  });

  const getEmailFromForm = (): string | null =>
    getEmailFromFormPure(formData, orderFields, inlineEmail);

  const effectiveMethod = (): "wallet" | "email" =>
    effectiveMethodPure(claimMode, chosenMethod, auth.isConnected);

  // ──────────────────────────────────────────────────────────────
  // Status lifecycle: applyStatus + mount/effect fetches
  // ──────────────────────────────────────────────────────────────
  /** Apply a fresh status response to local state. */
  function applyStatus(s: SeriesClaimStatus) {
    status = s;
    if (s.userEdition != null && !claimed) {
      claimed = true;
      claimedEdition = s.userEdition;
      claimedVia = "wallet";
    } else if (s.userPendingId && !approvalPending) {
      approvalPending = true;
      pendingId = s.userPendingId;
    }
  }

  // Reset transient checkout state if the page is restored from bfcache after
  // the buyer navigates back from Stripe. Without this, stripeLoading sticks
  // at true and the Pay button renders "Processing…" indefinitely.
  onMount(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        stripeLoading = false;
        error = null;
      }
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  });

  onMount(() => {
    // Stripe-return path: success modal was hydrated synchronously at script
    // init. Mark claimed so the order form doesn't render, scrub the URL hash
    // so a refresh doesn't re-fire detection, and fire one status refresh so
    // the stock counter eventually catches up. No polling — email is the
    // delivery channel, not the UI.
    if (stripeSuccess.wasReturn) {
      claimed = true;
      claimedVia = "email";
      stripeSuccess.consumeReturnHash();

      const addrForStatus = auth.parent?.toLowerCase();
      getClaimStatus(eventId, seriesId, addrForStatus || undefined, undefined, apiUrl)
        .then((fresh) => {
          if (fresh) {
            cacheSet(cacheKey.claimStatus(eventId, seriesId, addrForStatus), fresh, TTL.CLAIM_STATUS);
            applyStatus(fresh);
          }
        })
        .catch(() => { /* non-fatal */ });
      return;
    }

    // Permanent claimed from cache: no network call ever needed
    if (_permanentClaimed) return;

    // Re-read current address in case auth finished initialising after script init
    const addr = auth.parent?.toLowerCase();
    const statusKey = cacheKey.claimStatus(eventId, seriesId, addr);
    if (addr) _fetchedWithAddr = true;

    // Always fetch fresh — silently updates availability, picks up transitions
    getClaimStatus(eventId, seriesId, addr || undefined, undefined, apiUrl)
      .then((fresh) => {
        if (!fresh) return;
        cacheSet(statusKey, fresh, TTL.CLAIM_STATUS);

        // Server confirms claimed → write permanent cache
        if (fresh.userEdition != null && addr) {
          const via = claimedVia ?? "wallet";
          cacheSet(
            cacheKey.claimed(eventId, seriesId, addr),
            { edition: fresh.userEdition, via },
            TTL.PERMANENT,
          );
        }

        // Only patch UI if something changed vs what we already show
        const statusChanged = JSON.stringify(fresh) !== JSON.stringify(_cachedStatus);
        if (statusChanged) applyStatus(fresh);
      })
      .catch(() => {
        // Background fetch failed — cached data stays shown, no error
      });
  });

  // Re-fetch with address when auth restores asynchronously (page refresh scenario).
  // At onMount time, auth.parent may be null if IDB restore hasn't completed yet.
  // Without an address the server can't return userPendingId/userEdition.
  $effect(() => {
    const addr = auth.parent?.toLowerCase();
    if (!addr || _permanentClaimed || claimed || approvalPending || _fetchedWithAddr) return;
    _fetchedWithAddr = true;
    getClaimStatus(eventId, seriesId, addr, undefined, apiUrl)
      .then((fresh) => {
        if (!fresh) return;
        cacheSet(cacheKey.claimStatus(eventId, seriesId, addr), fresh, TTL.CLAIM_STATUS);
        if (fresh.userEdition != null) {
          cacheSet(
            cacheKey.claimed(eventId, seriesId, addr),
            { edition: fresh.userEdition, via: "wallet" as const },
            TTL.PERMANENT,
          );
        }
        applyStatus(fresh);
      })
      .catch(() => {});
  });

  /**
   * Refresh availability the moment the order form opens.
   *
   * Rationale: the shown `status` may be minutes stale (cache TTL). By the time
   * the user finishes typing and hits Pay, stock could have moved. Re-reading
   * here gives the user live "Only N left" / sold-out feedback WHILE typing —
   * cheaper than the alternative of paying, then seeing an auto-refund.
   */
  $effect(() => {
    if (!showOrderForm) return;
    if (claimed || _permanentClaimed) return;
    prefetching = true;
    const addr = auth.parent?.toLowerCase();
    getClaimStatus(eventId, seriesId, addr || undefined, undefined, apiUrl)
      .then((fresh) => {
        if (!fresh) return;
        cacheSet(cacheKey.claimStatus(eventId, seriesId, addr), fresh, TTL.CLAIM_STATUS);
        applyStatus(fresh);
      })
      .catch(() => { /* background fetch — silently ignore */ })
      .finally(() => { prefetching = false; });
  });

  /**
   * Pre-upload encrypted order to Swarm WHILE the user is filling the form.
   *
   * The Swarm upload is the slow link in the Pay click path (~3-10 s). By
   * firing it in the background as soon as the form is valid, the resulting
   * `orderRef` is already in hand when the user clicks Pay — making the
   * redirect feel near-instant.
   *
   * Debounced so edits mid-typing don't spawn a flurry of uploads. Every
   * debounced trigger produces a fresh upload; older orphan SealedBoxes are
   * encrypted and unreachable (no ref stored anywhere), so they're harmless.
   */
  // ──────────────────────────────────────────────────────────────
  // Pre-upload + reservation hooks
  // ──────────────────────────────────────────────────────────────
  const buildOrderSnapshot = (): string => buildOrderSnapshotPure(
    formData,
    getEmailFromForm() ?? (stripeAfterForm ? stripeEmail.trim() : ""),
    auth.parent?.toLowerCase() ?? "",
  );

  const orderPrefetch = useOrderPrefetch({
    seriesId,
    encryptionKey,
    getShouldPrefetch: () => showOrderForm && stripeAfterForm && !!encryptionKey && formValid(),
    getSnapshot: () => buildOrderSnapshot(),
    getFormData: () => formData,
    getEmail: () => getEmailFromForm() ?? (stripeAfterForm ? stripeEmail.trim() : ""),
    getAddress: () => auth.parent?.toLowerCase() ?? "",
    getQuantity: () => quantity,
    getPayHoverTick: () => payHoverTick,
  });

  /**
   * Server-side seat hold — fires whenever a paid-event buyer is actively in
   * the checkout flow, regardless of payment method. This gives wallet and
   * card payers equal standing: both get a hold the moment they engage with
   * the purchase UI, and both see a countdown timer.
   *
   * Trigger conditions (any one sufficient):
   * - Email-only or card-first events: reserve on mount (fee sheet visible)
   * - Order form open: user has clicked to fill in their info
   * - Crypto chain selector open: user is choosing network / about to pay
   *
   * Why wallet users need this too: the v2 crypto flow sends ETH in one tx
   * then calls claimFor in a second tx. If the event sells out between those
   * two steps the ETH is already on-chain and needs a manual refund. A seat
   * hold prevents that race entirely.
   *
   * Abuse is bounded by clientKey dedup (one hold per browser per series),
   * per-IP cap, 10-min TTL.
   */
  const reservationHook = useReservation({
    eventId,
    seriesId,
    getQuantity: () => quantity,
    getShouldHold: () => {
      const alreadyDone = claimed || _permanentClaimed !== null || approvalPending || stripeSuccess.visible;
      return isPaid && !alreadyDone && quantity >= 1 && (
        // Order form open (any payment method) — explicit user action opened it
        showOrderForm ||
        // Crypto payment sheet open — explicit user action
        showChainSelector ||
        // Email-only / card-first fee sheet: only after the buyer has explicitly
        // clicked a payment button. Without intentToCheckout, every ClaimButton
        // on the page would create a hold on mount (phantom reservations for
        // series the buyer never touched).
        (intentToCheckout && hasStripe && claimMode === "email") ||
        (intentToCheckout && hasStripe && (!hasCrypto || isCardFirst))
      );
    },
  });

  // Note: we deliberately do NOT release the reservation on pagehide or
  // component unmount. The 10-min TTL is the buyer's window; closing the
  // tab and reopening should resume the SAME hold with the SAME deadline
  // (server-side clientKey lookup returns the existing reservation
  // unchanged when qty matches). Releasing on unload would let a buyer
  // extend their lock indefinitely by closing+reopening the page.
  // Explicit releases still happen for: quantity decrement to 0 / form
  // closed (the $effect above), and successful checkout consumption.

  /** sessionStorage key for stashing form data across Stripe redirect */
  const STRIPE_FORM_KEY = `woco:stripe-form:${eventId}:${seriesId}`;

  /** Detect "already claimed" responses and transition to claimed state instead of error */
  // ──────────────────────────────────────────────────────────────
  // Outcome helpers: already-claimed detection, shortfall, success notify
  // ──────────────────────────────────────────────────────────────
  function handleAlreadyClaimed(msg: string): boolean {
    const lc = msg.toLowerCase();
    if (lc.includes("already claimed") || lc.includes("already have a ticket") || lc.includes("already requested")) {
      claimed = true;
      error = null;
      return true;
    }
    return false;
  }

  const shortfall = useShortfall({ eventId, seriesId });

  /** Apply server "Paid X, expected Y" response → shortfall receipt; clears `error` on hit. */
  function handleShortfall(msg: string, proof: PaymentProof): boolean {
    if (!shortfall.apply(msg, proof)) return false;
    error = null;
    return true;
  }

  /** Notify parent that a claim succeeded and the TicketSuccess modal should open. */
  function notifyClaimSuccess(via: "wallet" | "email" | null, edition: number | null, ticket?: ClaimedTicket, email?: string) {
    onclaim?.({ edition, claimedVia: via, ticket, claimerEmail: email });
  }

  // ──────────────────────────────────────────────────────────────
  // Claim flow handlers
  //   handleStripeCheckout    → card-pay redirect to Stripe
  //   handleClaimClick        → routes to crypto sheet / order form / direct claim
  //   handlePaymentAndClaim   → crypto: fetch quote, pay, then claim with proof
  //   handleClaimWithProof    → crypto: server-side claim using on-chain proof
  //   handleClaim             → free / non-crypto wallet+email claim
  // ──────────────────────────────────────────────────────────────
  async function handleStripeCheckout() {
    intentToCheckout = true;
    // If there's an order form and it hasn't been shown yet, show it first
    if (hasOrderForm && !showOrderForm) {
      stripeAfterForm = true;
      showOrderForm = true;
      return;
    }

    stripeLoading = true;
    error = null;
    try {
      const email = getEmailFromForm() || stripeEmail.trim() || undefined;
      const address = auth.parent?.toLowerCase() || undefined;
      if (!email && !address) {
        error = "Please enter an email address or sign in with a wallet.";
        return;
      }

      // Pre-upload encrypted order to Swarm BEFORE the Stripe redirect. Fast
      // path: the $effect above already did this while the user was typing and
      // we have the ref in hand — skip the upload entirely. Slow path (user
      // clicked Pay before the debounce fired, or the pre-upload failed): pass
      // the raw encryptedOrder to /create-checkout, which uploads it in
      // parallel with the Stripe session creation so latency is hidden behind
      // the Stripe API call we'd be doing anyway.
      let preparedOrderRef: string | undefined;
      let inlineEncryptedOrder: SealedBox | undefined;
      if (encryptionKey) {
        // Only reuse the pre-uploaded ref if it still matches the live form
        // snapshot. Otherwise the user kept typing after the upload finished
        // and the ref now points at a stale SealedBox — fall back to inline
        // upload, which seals the current formData.
        const liveSnapshot = buildOrderSnapshot();
        if (orderPrefetch.ref && orderPrefetch.refSnapshot === liveSnapshot) {
          preparedOrderRef = orderPrefetch.ref;
        } else if (orderPrefetch.inflight) {
          // A pre-upload is in flight — await it instead of starting a duplicate
          // inline upload. Bound the wait so a stuck Swarm upload can't hang
          // the Pay click indefinitely; on timeout we fall through to inline.
          try {
            const result = await Promise.race([
              orderPrefetch.inflight,
              new Promise<{ ref: null; snapshot: null }>((resolve) =>
                setTimeout(() => resolve({ ref: null, snapshot: null }), 2000)
              ),
            ]);
            if (result.ref && result.snapshot === liveSnapshot) {
              preparedOrderRef = result.ref;
            }
          } catch {
            // Awaiting the pre-upload threw — drop through to inline upload below.
          }
        }
        if (!preparedOrderRef) {
          try {
            inlineEncryptedOrder = await sealJson(encryptionKey, {
              fields: formData,
              seriesId,
              ...(address ? { claimerAddress: address } : {}),
              ...(email ? { claimerEmail: email } : {}),
            });
          } catch (err) {
            console.warn("[ClaimButton] seal failed, /create-checkout will run without order ref:", err);
          }
        }
      }

      // Persist email + quantity so the success card can render after the
      // Stripe redirect even before the webhook has confirmed the claim.
      // No form data — the webhook attaches the orderRef directly to every
      // ticket via session.metadata, so there's nothing for the client to
      // do on return beyond showing the confirmation.
      sessionStorage.setItem(STRIPE_FORM_KEY, JSON.stringify({
        claimerEmail: email,
        quantity,
      }));

      const { url } = await createCheckoutSession({
        eventId,
        seriesId,
        claimerEmail: email,
        quantity: quantity > 1 ? quantity : undefined,
        orderRef: preparedOrderRef,
        encryptedOrder: !preparedOrderRef ? inlineEncryptedOrder : undefined,
        reservationId: reservationHook.reservation?.reservationId,
      });
      // Server has stamped reservationId into Stripe metadata; webhook
      // consumes it. Clear local state (incl. sessionStorage) so back-nav
      // doesn't show a phantom countdown for a hold that's about to be
      // consumed by Stripe.
      reservationHook.clearForCheckout();
      // Remember which series we were buying so EventPage can auto-select on return
      try { sessionStorage.setItem(`woco:stripe-returning:${eventId}`, seriesId); } catch { /* ignore */ }
      // replace() so the dead Stripe checkout URL doesn't sit in the back-button
      // history. After Stripe's cancel redirect lands the buyer back on the
      // event page, Back goes to the events list, not into a stale Stripe session.
      window.location.replace(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start checkout";
      if (!handleAlreadyClaimed(msg)) error = msg;
    } finally {
      stripeLoading = false;
    }
  }

  function handleClaimClick(method?: "wallet" | "email") {
    intentToCheckout = true;
    if (method) chosenMethod = method;

    if (claimMode === "both" && !method && !showOrderForm) {
      showOrderForm = true;
      return;
    }

    if (hasOrderForm && !showOrderForm) {
      showOrderForm = true;
      return;
    }

    // For paid events with crypto: route through payment flow
    if (isPaid && hasCrypto && !paymentProofResult) {
      if (!showChainSelector) {
        if (payment!.acceptedChains.length === 1) {
          selectedChain = payment!.acceptedChains[0];
        }
        if (!ethEquivalent) {
          ethPriceLoading = true;
          import("../../payment/eth-price.js").then(({ fiatToETH }) =>
            fiatToETH(payment!.price, payment!.currency).then((eth) => { ethEquivalent = eth; ethPriceLoading = false; })
          ).catch(() => { ethPriceLoading = false; });
        }
        showChainSelector = true;
      }
      // Always return for paid events — Pay button triggers handlePaymentAndClaim
      return;
    }

    handleClaim();
  }

  async function handlePaymentAndClaim() {
    if (!payment || !selectedChain) return;
    claiming = true;
    error = null;

    // Lock wallet UI in the Profile tab — prevents the user from switching
    // wallets mid-payment, which could cause tx.from / claimer mismatch on
    // the server. Cleared in finally{}.
    try { window.localStorage.setItem("woco:payment-in-flight", "1"); } catch { /* storage unavailable */ }

    try {
      // Ensure wallet is connected for payment
      if (!auth.isConnected) {
        step = "Waiting for sign-in...";
        const ok = await loginRequest.request();
        if (!ok) { error = "Login cancelled"; return; }
      }

      // Ensure session BEFORE payment so all wallet signing is done upfront.
      // This avoids a third MetaMask round-trip after the transaction lands.
      if (!auth.hasSession) {
        step = "Approving session...";
        const ok = await auth.ensureSession();
        if (!ok) { error = "Session approval cancelled"; return; }
      }

      // Request a server-signed payment quote — server commits to the EXACT
      // wei the user must pay. No client-side oracle read, no slippage band.
      step = "Requesting payment quote...";
      const { fetchPaymentQuote } = await import("../../api/payment.js");
      const quoteCurrency: "ETH" | "USDC" = selectedPayMethod === "USDC" ? "USDC" : "ETH";
      const quote = await fetchPaymentQuote({
        eventId,
        seriesId,
        chainId: selectedChain,
        currency: quoteCurrency,
        ...(auth.parent ? { claimerAddress: auth.parent } : {}),
      });

      // Mirror the quote back into the UI so the displayed ETH amount matches
      // what the wallet will actually be asked to send.
      if (quoteCurrency === "ETH") {
        const { formatUnits } = await import("ethers");
        ethEquivalent = formatUnits(BigInt(quote.amountWei), 18)
          .replace(/0+$/, "")
          .replace(/\.$/, "");
      }

      step = "Switching chain...";
      const { executePayment } = await import("../../payment/pay.js");

      const sym = CURRENCY_SYMBOLS[payment.currency] || "";
      const displayAmount = quoteCurrency === "ETH"
        ? `${ethEquivalent} ETH (${sym}${payment.price})`
        : `${(Number(quote.amountWei) / 1_000_000).toFixed(2)} USDC (${sym}${payment.price})`;
      step = `Confirm ${displayAmount} payment...`;

      // Progress callback — translates pay-flow phases into user-visible steps.
      // The "waiting-confirmations" phase runs for ~10-40s depending on chain,
      // so it's critical the user sees live progress, not a frozen spinner.
      const onProgress = (ev: {
        phase: "switch-chain" | "approve-token" | "send-tx" | "waiting-confirmations" | "confirmed";
        current?: number;
        total?: number;
      }) => {
        switch (ev.phase) {
          case "switch-chain": step = "Switching chain..."; break;
          case "approve-token": step = "Approving token..."; break;
          case "send-tx": step = `Confirm ${displayAmount} payment...`; break;
          case "waiting-confirmations":
            step = `Waiting for confirmations (${ev.current ?? 0}/${ev.total ?? "?"})...`;
            break;
          case "confirmed": step = "Payment confirmed. Claiming ticket..."; break;
        }
      };

      const result = await executePayment({
        quote,
        payment,
        eventId,
        eventEndDate,
        signerAddress: auth.parent ?? undefined,
        onProgress,
      });
      paymentProofResult = result.proof;

      // Persist proof before claiming — if the claim fetch fails, the user's tx hash
      // is preserved and shown in the error so they can contact support or retry.
      try {
        sessionStorage.setItem(`woco-proof-${eventId}-${seriesId}`, JSON.stringify(result.proof));
      } catch { /* storage unavailable */ }

      showChainSelector = false;
      step = "Payment confirmed. Claiming ticket...";

      // Now proceed with the normal claim flow (proof is attached)
      await handleClaimWithProof(result.proof);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Payment failed";
      // If payment already landed (we have a proof), surface the tx hash in the error
      // so the user isn't left wondering whether they were charged.
      if (paymentProofResult && paymentProofResult.type === "tx") {
        error = `${msg} — your payment went through (tx: ${paymentProofResult.txHash}). Please try again or contact support.`;
      } else {
        error = msg;
      }
    } finally {
      claiming = false;
      try { window.localStorage.removeItem("woco:payment-in-flight"); } catch { /* storage unavailable */ }
    }
  }

  async function handleClaimWithProof(proof: PaymentProof) {
    const method = effectiveMethod();

    if (method === "email") {
      const email = getEmailFromForm();
      if (!email) { error = "Please enter a valid email address"; return; }

      let encryptedOrder: SealedBox | undefined;
      if (encryptionKey) {
        encryptedOrder = await sealJson(encryptionKey, {
          ...(Object.keys(formData).length > 0 ? { fields: formData } : {}),
          seriesId,
          claimerEmail: email,
        });
      }

      const result = await claimTicketByEmail(eventId, seriesId, email, encryptedOrder, apiUrl, proof);
      if (!result.ok) {
        const msg = result.error || "Failed to claim ticket";
        if (handleAlreadyClaimed(msg)) return;
        if (handleShortfall(msg, proof)) return;
        error = msg; return;
      }

      if (result.approvalPending) {
        approvalPending = true;
        pendingId = result.pendingId ?? null;
        showOrderForm = false;
        step = "";
        return;
      }

      claimed = true;
      claimedEdition = result.edition ?? null;
      claimedVia = "email";
      lastClaimedTicket = result.ticket;
      showOrderForm = false;
      step = "";
      cacheDel(cacheKey.claimStatus(eventId, seriesId, "anon"));
      notifyClaimSuccess("email", result.edition ?? null, result.ticket, email);
    } else {
      // Wallet — session ensured before payment in handlePaymentAndClaim
      if (!auth.hasSession) {
        step = "Approving session...";
        const ok = await auth.ensureSession();
        if (!ok) { error = "Session approval cancelled"; return; }
      }

      let encryptedOrder: SealedBox | undefined;
      if (encryptionKey) {
        encryptedOrder = await sealJson(encryptionKey, {
          ...(Object.keys(formData).length > 0 ? { fields: formData } : {}),
          seriesId,
          claimerAddress: auth.parent,
        });
      }

      // Retry on two classes of failure:
      //  1. Network throws — mobile connections drop during app-switching, a
      //     transient fetch failure shouldn't lose the ticket.
      //  2. Server returns { ok: false, error: "Need N confirmations, have M" }
      //     — the client already waited for minConfs+1, but the server's RPC
      //     may be 1 block behind the client's RPC (block propagation lag).
      //     Back off and retry; the tx is on-chain, confs will catch up.
      let result;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          result = await claimTicket(eventId, seriesId, auth.parent!, encryptedOrder, apiUrl, proof);
          // If server still sees too few confs, backoff and retry — the tx is
          // on-chain, it just hasn't propagated to the server's RPC yet.
          if (!result.ok && /Need \d+ confirmations/.test(result.error ?? "")) {
            if (attempt < 4) {
              step = `Waiting for confirmations to propagate (retry ${attempt + 1})...`;
              await new Promise(r => setTimeout(r, 4000 + attempt * 2000));
              result = undefined;
              continue;
            }
          }
          break;
        } catch (e) {
          if (attempt < 4) {
            step = `Claiming ticket (retry ${attempt + 1})...`;
            await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
          } else {
            throw e; // rethrow after 5 failures — caught by handlePaymentAndClaim
          }
        }
      }
      if (!result) return;
      if (!result.ok) {
        const msg = result.error || "Failed to claim ticket";
        if (handleAlreadyClaimed(msg)) return;
        if (handleShortfall(msg, proof)) return;
        error = msg; return;
      }

      if (result.approvalPending) {
        approvalPending = true;
        pendingId = result.pendingId ?? null;
        showOrderForm = false;
        step = "";
        if (auth.parent) {
          const addr = auth.parent.toLowerCase();
          const sk = cacheKey.claimStatus(eventId, seriesId, addr);
          const cur = cacheGet<SeriesClaimStatus>(sk);
          const base = cur ?? ({ seriesId, totalSupply, claimed: 0, available: totalSupply } as SeriesClaimStatus);
          cacheSet(sk, { ...base, userPendingId: pendingId ?? undefined }, TTL.CLAIM_STATUS);
        }
        return;
      }

      claimed = true;
      claimedEdition = result.edition ?? null;
      claimedVia = "wallet";
      lastClaimedTicket = result.ticket;
      showOrderForm = false;
      step = "";

      if (auth.parent) {
        const addr = auth.parent.toLowerCase();
        cacheSet(cacheKey.claimed(eventId, seriesId, addr), { edition: claimedEdition, via: "wallet" }, TTL.PERMANENT);
        cacheDel(cacheKey.claimStatus(eventId, seriesId, addr));
      }
      notifyClaimSuccess("wallet", result.edition ?? null, result.ticket);
    }
  }

  async function handleClaim() {
    if (claiming) return;

    // Hard gate: paid events with crypto MUST go through the payment flow
    if (isPaid && hasCrypto && !paymentProofResult) {
      if (!showChainSelector) {
        if (payment!.acceptedChains.length === 1) {
          selectedChain = payment!.acceptedChains[0];
        }
        if (!ethEquivalent) {
          ethPriceLoading = true;
          import("../../payment/eth-price.js").then(({ fiatToETH }) =>
            fiatToETH(payment!.price, payment!.currency).then((eth) => { ethEquivalent = eth; ethPriceLoading = false; })
          ).catch(() => { ethPriceLoading = false; });
        }
        showChainSelector = true;
        showOrderForm = false;
      }
      return;
    }

    claiming = true;
    error = null;

    try {
      const method = effectiveMethod();

      if (method === "email") {
        const email = getEmailFromForm();
        if (!email) {
          error = "Please enter a valid email address";
          return;
        }

        let encryptedOrder: SealedBox | undefined;
        if (encryptionKey) {
          step = "Encrypting your info...";
          encryptedOrder = await sealJson(encryptionKey, {
            ...(Object.keys(formData).length > 0 ? { fields: formData } : {}),
            seriesId,
            claimerEmail: email,
          });
        }

        step = "Claiming ticket...";
        const result = await claimTicketByEmail(eventId, seriesId, email, encryptedOrder, apiUrl);

        if (!result.ok) {
          const msg = result.error || "Failed to claim ticket";
          if (handleAlreadyClaimed(msg)) return;
          error = msg; return;
        }

        if (result.approvalPending) {
          approvalPending = true;
          pendingId = result.pendingId ?? null;
          showOrderForm = false;
          step = "";
          // Cache the pending state (short-lived — server is source of truth)
          const statusKey = cacheKey.claimStatus(eventId, seriesId, "anon");
          const current = cacheGet<SeriesClaimStatus>(statusKey);
          if (current) {
            cacheSet(statusKey, { ...current, userPendingId: pendingId ?? undefined }, TTL.CLAIM_STATUS);
          }
          return;
        }

        claimed = true;
        claimedEdition = result.edition ?? null;
        claimedVia = "email";
        lastClaimedTicket = result.ticket;
        showOrderForm = false;
        step = "";
        // Email claims: no address to key permanent cache on, but invalidate
        // status cache so availability count refreshes next visit
        cacheDel(cacheKey.claimStatus(eventId, seriesId, "anon"));
        notifyClaimSuccess("email", result.edition ?? null, result.ticket, getEmailFromForm() || undefined);
      } else {
        // Wallet claim
        if (!auth.isConnected) {
          step = "Waiting for sign-in...";
          const ok = await loginRequest.request();
          if (!ok) { error = "Login cancelled"; return; }
        }

        if (!auth.hasSession) {
          step = "Approving session...";
          const ok = await auth.ensureSession();
          if (!ok) { error = "Session approval cancelled"; return; }
        }

        let encryptedOrder: SealedBox | undefined;
        if (encryptionKey) {
          step = "Encrypting your info...";
          encryptedOrder = await sealJson(encryptionKey, {
            ...(Object.keys(formData).length > 0 ? { fields: formData } : {}),
            seriesId,
            claimerAddress: auth.parent,
          });
        }

        step = "Claiming ticket...";
        const result = await claimTicket(eventId, seriesId, auth.parent!, encryptedOrder, apiUrl);

        if (!result.ok) {
          const msg = result.error || "Failed to claim ticket";
          if (handleAlreadyClaimed(msg)) return;
          error = msg; return;
        }

        if (result.approvalPending) {
          approvalPending = true;
          pendingId = result.pendingId ?? null;
          showOrderForm = false;
          step = "";
          // Cache pending state — ensures refresh shows correct state immediately
          if (auth.parent) {
            const addr = auth.parent.toLowerCase();
            const sk = cacheKey.claimStatus(eventId, seriesId, addr);
            const cur = cacheGet<SeriesClaimStatus>(sk);
            const base = cur ?? ({ seriesId, totalSupply, claimed: 0, available: totalSupply } as SeriesClaimStatus);
            cacheSet(sk, { ...base, userPendingId: pendingId ?? undefined }, TTL.CLAIM_STATUS);
          }
          return;
        }

        claimed = true;
        claimedEdition = result.edition ?? null;
        claimedVia = "wallet";
        lastClaimedTicket = result.ticket;
        showOrderForm = false;
        step = "";

        // Write permanent claimed cache — this address has claimed this series
        if (auth.parent) {
          const addr = auth.parent.toLowerCase();
          cacheSet(
            cacheKey.claimed(eventId, seriesId, addr),
            { edition: claimedEdition, via: "wallet" },
            TTL.PERMANENT,
          );
          // Invalidate stale status cache so availability count reflects change
          cacheDel(cacheKey.claimStatus(eventId, seriesId, addr));
        }
        notifyClaimSuccess("wallet", result.edition ?? null, result.ticket);

        // Refresh status in background to update availability count
        const userAddr = auth.parent || undefined;
        getClaimStatus(eventId, seriesId, userAddr, undefined, apiUrl)
          .then((fresh) => {
            if (fresh) {
              const statusKey = cacheKey.claimStatus(eventId, seriesId, auth.parent?.toLowerCase());
              cacheSet(statusKey, fresh, TTL.CLAIM_STATUS);
              status = fresh;
            }
          })
          .catch(() => {});
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Unexpected error";
    } finally {
      claiming = false;
    }
  }
</script>

<div class="claim-area">
  <ReservationPill
    reservation={reservationHook.reservation}
    secsLeft={reservationHook.secsLeft}
    expired={reservationHook.expired}
    error={reservationHook.error}
    onretry={reservationHook.retry}
  />
  {#if claimed && isPaid}
    <!--
      Paid tickets support multi-purchase. Keep the buy UI available and
      surface ownership in a subtle chip above it — so a user who already
      holds an edition can still grab another without losing sight of it.
    -->
    <div class="own-chip" role="status">
      <span class="own-chip-dot" aria-hidden="true">&#10003;</span>
      <span class="own-chip-text">
        You own {#if claimedEdition != null}edition #{claimedEdition}{:else}this ticket{/if}
      </span>
      <span class="own-chip-hint">Buy another below</span>
    </div>
  {/if}
  {#if shortfall.data && !claimed}
    <ShortfallReceipt
      data={shortfall.data}
      onretry={() => { shortfall.dismiss(); showChainSelector = true; }}
      ondismiss={shortfall.dismiss}
    />
  {:else if approvalPending}
    <div class="pending-badge">
      <span class="live-dot"></span>
      Pending Approval
    </div>
    <p class="pending-note">Your request has been submitted. You'll receive your ticket once the organiser approves it.</p>
  {:else if claimed && !isPaid}
    <!-- Free tickets: one per user, so the claimed badge replaces the buy UI. -->
    <div class="claimed-badge">
      <span class="check">&#10003;</span>
      Claimed {#if claimedEdition != null}#{claimedEdition}{/if}
    </div>
    {#if claimedVia === "email"}
      <p class="claimed-note">Your ticket will be sent to your email by the organizer.</p>
    {:else if claimedVia === "wallet"}
      <p class="claimed-note">Ticket saved to your passport.</p>
    {/if}
  {:else if showOrderForm}
    <OrderForm
      {status}
      {quantity}
      {orderFields}
      {claimMode}
      {hasEmailField}
      {hasOrderForm}
      {stripeAfterForm}
      authConnected={auth.isConnected}
      {stripeLoading}
      {approvalRequired}
      {claiming}
      {step}
      {buyerFees}
      {priceLabel}
      payPreparing={orderPrefetch.uploading && !orderPrefetch.ref}
      {formValid}
      {walletFormValid}
      bind:formData
      bind:inlineEmail
      bind:stripeEmail
      onStripeCheckout={handleStripeCheckout}
      onPayHover={() => { payHoverTick++; }}
      onClaim={(method) => {
        if (method) chosenMethod = method;
        handleClaim();
      }}
      onCancel={() => { showOrderForm = false; chosenMethod = null; stripeAfterForm = false; }}
    />
  {:else if showChainSelector && isPaid && hasCrypto && payment}
    <ChainSelector
      {payment}
      {buyerFees}
      {priceLabel}
      {ethEquivalent}
      {ethPriceLoading}
      {selectedChain}
      {selectedPayMethod}
      {usdcAvailableOnChain}
      {claiming}
      {step}
      {hasStripe}
      {stripeLoading}
      {stripeEmail}
      showEmailInput={!auth.isConnected && !hasEmailField}
      onSelectChain={(chainId) => {
        selectedChain = chainId;
        if (selectedPayMethod === "USDC" && !USDC_ADDRESSES[chainId]) {
          selectedPayMethod = "ETH";
        }
      }}
      onSelectPayMethod={(m) => { selectedPayMethod = m; }}
      onPay={handlePaymentAndClaim}
      onCancel={() => { showChainSelector = false; selectedChain = null; selectedPayMethod = "ETH"; }}
      onStripeCheckout={handleStripeCheckout}
      onStripeEmailChange={(v) => { stripeEmail = v; }}
    />
  {:else if isPaid && hasStripe && (!hasCrypto || isCardFirst)}
    <!-- Card-first: passkey/local users, or Stripe-only events -->
    <StripePayPanel
      {buyerFees}
      {priceLabel}
      {stripeLoading}
      soldOut={status?.available === 0}
      {stripeEmail}
      showEmailInput={!auth.isConnected && !hasEmailField}
      onCheckout={handleStripeCheckout}
      onStripeEmailChange={(v) => { stripeEmail = v; }}
      cryptoFooter={hasCrypto ? {
        label: `Pay with crypto ${buyerFees?.cryptoTotal ? `— ${buyerFees.cryptoTotal}` : `— ${priceLabel}`}`,
        onclick: () => isCardFirst ? showWalletModal = true : handleClaimClick(),
      } : null}
    />
  {:else if isPaid && !hasCrypto && hasStripe}
    <!-- Stripe-only, no crypto at all -->
    <StripePayPanel
      {buyerFees}
      {priceLabel}
      {stripeLoading}
      soldOut={status?.available === 0}
      {stripeEmail}
      showEmailInput={!auth.isConnected && !hasEmailField}
      onCheckout={handleStripeCheckout}
      onStripeEmailChange={(v) => { stripeEmail = v; }}
    />
  {:else}
    <button
      class="claim-btn"
      class:claim-btn--paid={isPaid}
      onclick={() => handleClaimClick()}
      disabled={claiming || (status?.available === 0)}
    >
      {#if claiming}
        {step}
      {:else if status?.available === 0}
        Sold out
      {:else if approvalRequired}
        Request to attend
      {:else if isPaid && hasCrypto && hasStripe}
        Pay with crypto {buyerFees?.cryptoTotal ? `— ${buyerFees.cryptoTotal}` : `— ${priceLabel}`}
      {:else if isPaid}
        <span class="claim-btn-price">{priceLabel}</span>
        <span class="claim-btn-sep"></span>
        <span>Get ticket</span>
      {:else if claimMode === "email"}
        Claim with email
      {:else}
        Claim ticket
      {/if}
    </button>
    {#if isPaid && hasCrypto && hasStripe && !claiming && status?.available !== 0}
      <button
        class="stripe-btn"
        disabled={stripeLoading}
        onclick={handleStripeCheckout}
      >
        {#if stripeLoading}
          Redirecting to Stripe...
        {:else}
          Pay with card {buyerFees?.cardTotal ? `— ${buyerFees.cardTotal}` : `— ${priceLabel}`}
        {/if}
      </button>
    {/if}
  {/if}


  {#if error}
    <p class="error">{error}</p>
  {/if}
</div>

{#if showWalletModal}
  <ConnectWalletModal
    onConnect={(addr) => {
      showWalletModal = false;
      // Wallet connected — proceed to crypto payment flow
      handleClaimClick();
    }}
    onClose={() => showWalletModal = false}
  />
{/if}

<!--
  Stripe email-success modal — shown immediately on return from Stripe.
  Email is the hero; no QR/edition (webhook still writing to Swarm).
-->
{#if stripeSuccess.email !== null && stripeSuccess.visible}
  <StripeSuccessCard
    email={stripeSuccess.email}
    qty={stripeSuccess.qty}
    ondismiss={stripeSuccess.dismiss}
  />
{/if}

<style>
  .claim-area {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.375rem;
  }

  .claim-btn {
    padding: 0.5rem 1.25rem;
    font-size: 0.8125rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: var(--accent-ink);
    white-space: nowrap;
    transition: background var(--transition);
  }

  .claim-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .claim-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .claim-btn--paid {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }

  .claim-btn-price {
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
  }

  .claim-btn-sep {
    width: 1px;
    height: 14px;
    background: rgba(255, 255, 255, 0.25);
  }

  .stripe-processing {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--accent);
    background: var(--accent-subtle);
    border-radius: var(--radius-sm);
    max-width: 320px;
  }

  .stripe-processing-spinner {
    width: 18px;
    height: 18px;
    border: 2px solid var(--accent);
    border-top-color: transparent;
    border-radius: 50%;
    animation: stripe-processing-spin 0.8s linear infinite;
    flex-shrink: 0;
  }

  @keyframes stripe-processing-spin {
    to { transform: rotate(360deg); }
  }

  .stripe-processing-body {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .stripe-processing-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text);
  }

  .stripe-processing-sub {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  /* STRIPE EMAIL-SUCCESS MODAL — moved to ./claim/StripeSuccessCard.svelte */

  .pending-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--accent-text);
    background: var(--accent-subtle);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }


  .pending-note {
    font-size: 0.6875rem;
    color: var(--text-muted);
    margin: 0;
    text-align: right;
    max-width: 240px;
  }

  .claimed-badge {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--success);
    border: 1px solid var(--success);
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }

  .check {
    font-size: 0.875rem;
  }

  .claimed-note {
    font-size: 0.6875rem;
    color: var(--text-muted);
    margin: 0;
    text-align: right;
  }

  /* Multi-purchase paid tickets: subtle ownership chip above the buy UI. */
  .own-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.75rem;
    margin-bottom: 0.5rem;
    font-size: 0.75rem;
    line-height: 1.2;
    color: var(--success);
    background: color-mix(in srgb, var(--success) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--success) 35%, transparent);
    border-radius: var(--radius-sm);
    align-self: flex-end;
  }
  .own-chip-dot {
    font-size: 0.75rem;
    font-weight: 700;
  }
  .own-chip-text {
    font-weight: 600;
  }
  .own-chip-hint {
    color: var(--text-muted);
    font-weight: 400;
  }

  .error {
    color: var(--error);
    font-size: 0.75rem;
    margin: 0;
    text-align: right;
  }

  /* ── Stripe card payment ── */
  .stripe-btn {
    width: 100%;
    padding: 0.625rem 1rem;
    font-size: 0.8125rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: var(--accent-ink);
    white-space: nowrap;
    transition: background 0.2s ease, opacity 0.2s ease;
  }

  .stripe-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .stripe-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
