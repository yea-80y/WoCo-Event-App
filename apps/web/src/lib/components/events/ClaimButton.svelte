<script lang="ts">
  import type { OrderField, SealedBox, ClaimMode, PaymentConfig, PaymentChainId, PaymentProof, ClaimedTicket } from "@woco/shared";
  import { sealJson, CHAIN_NAMES, USDC_ADDRESSES, PLATFORM_FEE_BP } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { claimTicket, claimTicketByEmail, getClaimStatus } from "../../api/events.js";
  import { createCheckoutSession } from "../../api/stripe.js";
  import { CHAIN_INFO } from "../../payment/chains.js";
  import type { SeriesClaimStatus } from "@woco/shared";
  import { cacheGet, cacheSet, cacheDel, cacheKey, TTL } from "../../cache/cache.js";
  import { onMount } from "svelte";
  import ConnectWalletModal from "../profile/ConnectWalletModal.svelte";

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
    /** Called when a claim succeeds — parent can show the TicketSuccess modal */
    onclaim?: (data: { edition: number | null; claimedVia: "wallet" | "email" | null; ticket?: ClaimedTicket; claimerEmail?: string; editions?: Array<{ edition: number; ticket?: ClaimedTicket }> }) => void;
  }

  let { eventId, seriesId, totalSupply, encryptionKey, orderFields, claimMode = "wallet", approvalRequired = false, apiUrl, payment, eventEndDate, quantity = 1, onclaim }: Props = $props();

  console.log(`[ClaimButton] seriesId=${seriesId} payment:`, payment ?? "FREE");

  // Payment state
  const isPaid = $derived(!!payment && parseFloat(payment.price) > 0);
  const hasCrypto = $derived(!!payment?.cryptoEnabled && (payment?.acceptedChains?.length ?? 0) > 0);
  const hasStripe = $derived(!!payment?.stripeEnabled);
  let stripeLoading = $state(false);
  let stripeEmail = $state("");
  /** Last successfully claimed ticket (available for wallet/email direct claims, not Stripe webhook) */
  let lastClaimedTicket = $state<ClaimedTicket | undefined>(undefined);
  /** Email the tickets were sent to — drives the optimistic success card shown
   *  immediately on Stripe return. Null until we detect the return. */
  let stripeSuccessEmail = $state<string | null>(null);
  /** Count of tickets purchased in this Stripe session (for pluralisation). */
  let stripeSuccessQty = $state<number>(1);
  /**
   * On-chain payment succeeded but the amount was short of what the server
   * requires (price moved beyond the slippage tolerance between quote and
   * verification). The tx is confirmed on-chain but the ticket was NOT issued.
   * Surfaces a dedicated receipt card so the user sees exactly what happened.
   */
  let paymentShortfall = $state<{
    txHash: string;
    chainId: PaymentChainId;
    paid: string;
    expected: string;
    currency: string;
    at: string;
  } | null>(null);
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
  /** Card-first users: passkey, local (no crypto wallet). Crypto-first: web3, para. */
  const isCardFirst = $derived(auth.kind === "passkey" || auth.kind === "local" || !auth.kind);

  /** Stripe processing fee estimates (UK/EU domestic) */
  const STRIPE_PERCENT = 0.029;
  const STRIPE_FIXED: Record<string, number> = { GBP: 0.20, USD: 0.30, EUR: 0.25 };

  /** Whether fees are passed to the buyer */
  const feePassedToCustomer = $derived(!!payment?.feePassedToCustomer);

  /** Fee breakdown for buyer display — multiplied by quantity so multi-ticket
   * totals match what Stripe actually charges. Platform fee scales linearly;
   * Stripe's fixed fee is per charge (not per unit), so it's added once. */
  const buyerFees = $derived.by(() => {
    if (!payment || !feePassedToCustomer) return null;
    const unit = parseFloat(payment.price);
    if (!unit || unit <= 0) return null;
    const qty = Math.max(1, quantity);
    const subtotal = unit * qty;
    const sym = CURRENCY_SYMBOLS[payment.currency] ?? "";
    const fmt = (n: number) => `${sym}${n.toFixed(2)}`;
    const platformFee = subtotal * PLATFORM_FEE_BP / 10_000;
    const stripeFee = payment.stripeEnabled
      ? subtotal * STRIPE_PERCENT + (STRIPE_FIXED[payment.currency] ?? 0.20)
      : 0;
    return {
      qty,
      baseLabel: qty > 1 ? `Tickets (×${qty})` : "Ticket",
      base: fmt(subtotal),
      unit: fmt(unit),
      platform: fmt(platformFee),
      stripe: payment.stripeEnabled ? `~${fmt(stripeFee)}` : null,
      cardTotal: payment.stripeEnabled ? `~${fmt(subtotal + platformFee + stripeFee)}` : null,
      cryptoTotal: payment.cryptoEnabled ? fmt(subtotal + platformFee) : null,
    };
  });

  const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", GBP: "\u00a3", EUR: "\u20ac" };
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
  /** Chain indicator colors for visual identity */
  const CHAIN_COLORS: Record<number, string> = {
    1: "#627eea",     // Ethereum blue
    8453: "#0052ff",  // Base blue
    10: "#ff0420",    // Optimism red
    11155111: "#888",  // Sepolia grey
  };

  // ---------------------------------------------------------------------------
  // Synchronous cache init — runs before first render so the claim button
  // shows the correct state (claimed / pending / available) immediately.
  // ---------------------------------------------------------------------------
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
  /** Pre-uploaded encrypted-order ref — set by the typing-debounce effect so
   *  handleStripeCheckout can skip the server-side upload step on Pay click. */
  let pendingOrderRef = $state<string | null>(null);
  /** True while the pre-upload is mid-flight (drives the ambient shimmer on Pay). */
  let orderRefUploading = $state(false);

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

  /** Get the email from form fields or inline input */
  function getEmailFromForm(): string | null {
    const email = formData["__email"]?.trim();
    if (email && email.includes("@")) return email;
    if (orderFields) {
      for (const f of orderFields) {
        if (f.type === "email") {
          const val = formData[f.id]?.trim();
          if (val && val.includes("@")) return val;
        }
      }
    }
    const inline = inlineEmail.trim();
    if (inline && inline.includes("@")) return inline;
    return null;
  }

  /** Determine the effective claim method for this click */
  function effectiveMethod(): "wallet" | "email" {
    if (claimMode === "wallet") return "wallet";
    if (claimMode === "email") return "email";
    if (chosenMethod) return chosenMethod;
    return auth.isConnected ? "wallet" : "email";
  }

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

  onMount(() => {
    // Restore a persisted payment-shortfall receipt if present (session-scoped
    // so it doesn't linger forever — user sees it until they dismiss or close tab).
    try {
      const raw = sessionStorage.getItem(SHORTFALL_KEY);
      if (raw) paymentShortfall = JSON.parse(raw);
    } catch { /* ignore */ }

    // Restore a persisted Stripe-success card if the user refreshed after paying.
    // Session-scoped so it vanishes when the tab closes — by then the email
    // has certainly arrived.
    try {
      const raw = sessionStorage.getItem(STRIPE_SUCCESS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { email?: string; qty?: number };
        stripeSuccessEmail = parsed.email ?? null;
        stripeSuccessQty = parsed.qty && Number.isInteger(parsed.qty) ? parsed.qty : 1;
        claimed = true;
        claimedVia = "email";
      }
    } catch { /* ignore */ }

    // Detect Stripe success redirect — save stashed order data + show success card
    const hash = window.location.hash;
    const isStripeReturn = hash.includes("stripe=success");
    if (isStripeReturn) {
      if (sessionStorage.getItem(STRIPE_FORM_KEY)) {
        saveStashedOrderData();
      }
      handleStripeSuccessReturn();
      return;
    }

    // If a prior saveStashedOrderData() failed (server-side claim was still in
    // flight), the key is kept in sessionStorage. Retry silently on every mount
    // until it succeeds — the server will find the claimer entry once the
    // background claim has finished writing to Swarm.
    if (sessionStorage.getItem(STRIPE_FORM_KEY)) {
      saveStashedOrderData();
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

  /**
   * Handle returning from a successful Stripe checkout.
   *
   * Optimistic: the Stripe webhook has fired (or is about to) and the
   * confirmation email is queued server-side. Rather than block the UI on a
   * 28-second poll loop, we show a success card immediately — the ticket
   * arrives by email, which is the channel this flow is designed around.
   *
   *  1. Strip the stripe=success query so refreshes don't re-run this
   *  2. Read the claimer email from sessionStorage (stashed pre-redirect)
   *  3. Show the optimistic success card immediately (no spinner, no poll)
   *  4. Fire ONE background status refresh so the stock counter catches up
   */
  async function handleStripeSuccessReturn() {
    // Strip query string first so any early return still clears it.
    try {
      const url = new URL(window.location.href);
      const newHash = window.location.hash
        .replace(/[?&]stripe=success/, "")
        .replace(/[?&]session_id=[^&]*/, "");
      window.history.replaceState(null, "", url.pathname + url.search + newHash);
    } catch { /* ignore */ }

    // Read stashed form context (email, quantity) from sessionStorage.
    let stashedEmail: string | undefined;
    let stashedQty = 1;
    try {
      const raw = sessionStorage.getItem(STRIPE_FORM_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { claimerEmail?: string; quantity?: number };
        stashedEmail = parsed.claimerEmail;
        if (parsed.quantity && Number.isInteger(parsed.quantity)) stashedQty = parsed.quantity;
      }
    } catch { /* ignore */ }
    const email = stashedEmail || stripeEmail.trim() || undefined;

    // Render the success card immediately — no polling, no artificial delay.
    stripeSuccessEmail = email ?? null;
    stripeSuccessQty = Math.max(1, stashedQty);
    claimed = true;
    claimedVia = "email";

    // Persist so a page refresh within this session keeps the success card
    // visible. Cleared when the tab closes.
    try {
      sessionStorage.setItem(
        STRIPE_SUCCESS_KEY,
        JSON.stringify({ email: stripeSuccessEmail, qty: stripeSuccessQty }),
      );
    } catch { /* ignore quota */ }

    // Background: refresh availability once so the stock counter catches up.
    // We don't block the UI on this; failures are silent.
    const addr = auth.parent?.toLowerCase();
    cacheDel(cacheKey.claimStatus(eventId, seriesId, addr));
    cacheDel(cacheKey.claimStatus(eventId, seriesId, "anon"));
    cacheDel(cacheKey.claimStatus(eventId, seriesId, undefined));
    getClaimStatus(eventId, seriesId, addr || undefined, undefined, apiUrl)
      .then((fresh) => {
        if (!fresh) return;
        cacheSet(cacheKey.claimStatus(eventId, seriesId, addr), fresh, TTL.CLAIM_STATUS);
        applyStatus(fresh);
      })
      .catch(() => { /* background — silently ignore */ });
  }

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
  let _preUploadTimer: ReturnType<typeof setTimeout> | null = null;
  let _preUploadSeq = 0;
  $effect(() => {
    // Capture reactive dependencies at the top so Svelte tracks them.
    const open = showOrderForm;
    const willStripe = stripeAfterForm;
    const isValid = formValid();
    const email = getEmailFromForm() ?? (stripeAfterForm ? stripeEmail.trim() : "");
    const address = auth.parent?.toLowerCase();
    // Referencing formData/quantity here makes the effect re-run on any change.
    const _dataSnapshot = JSON.stringify(formData);
    const _q = quantity;
    void _dataSnapshot; void _q;

    if (!open || !willStripe || !encryptionKey || !isValid) {
      pendingOrderRef = null;
      return;
    }
    if (!email && !address) return;

    if (_preUploadTimer) clearTimeout(_preUploadTimer);
    const mySeq = ++_preUploadSeq;
    _preUploadTimer = setTimeout(async () => {
      orderRefUploading = true;
      try {
        const sealed = await sealJson(encryptionKey, {
          fields: formData,
          seriesId,
          ...(address ? { claimerAddress: address } : {}),
          ...(email ? { claimerEmail: email } : {}),
        });
        const { prepareStripeOrder } = await import("../../api/stripe.js");
        const ref = await prepareStripeOrder(sealed);
        // A later trigger may have superseded us — drop stale result silently.
        if (mySeq === _preUploadSeq) pendingOrderRef = ref;
      } catch (err) {
        console.warn("[ClaimButton] pre-upload failed, will fall back on Pay click:", err);
        if (mySeq === _preUploadSeq) pendingOrderRef = null;
      } finally {
        if (mySeq === _preUploadSeq) orderRefUploading = false;
      }
    }, 700);
  });

  /** sessionStorage key for stashing form data across Stripe redirect */
  const STRIPE_FORM_KEY = `woco:stripe-form:${eventId}:${seriesId}`;
  /** sessionStorage key for persisting the optimistic success card across page refresh */
  const STRIPE_SUCCESS_KEY = `woco:stripe-success:${eventId}:${seriesId}`;

  /** Detect "already claimed" responses and transition to claimed state instead of error */
  function handleAlreadyClaimed(msg: string): boolean {
    const lc = msg.toLowerCase();
    if (lc.includes("already claimed") || lc.includes("already have a ticket") || lc.includes("already requested")) {
      claimed = true;
      error = null;
      return true;
    }
    return false;
  }

  const SHORTFALL_KEY = `woco:payment-shortfall:${eventId}:${seriesId}`;

  /**
   * Detect a server "Paid X ETH, expected Y ETH" response and, if matched,
   * transition into the dedicated shortfall receipt card. Persists to
   * sessionStorage so the user can navigate away and come back to it.
   */
  function handleShortfall(msg: string, proof: PaymentProof): boolean {
    const m = msg.match(/Paid\s+([\d.]+)\s+(ETH|USDC),\s*expected\s+([\d.]+)\s+(?:ETH|USDC)/i);
    if (!m || proof.type !== "tx" || !proof.txHash) return false;
    const data = {
      txHash: proof.txHash,
      chainId: proof.chainId,
      paid: m[1],
      expected: m[3],
      currency: m[2].toUpperCase(),
      at: new Date().toISOString(),
    };
    paymentShortfall = data;
    try { sessionStorage.setItem(SHORTFALL_KEY, JSON.stringify(data)); } catch { /* ignore */ }
    error = null;
    return true;
  }

  function dismissShortfall() {
    paymentShortfall = null;
    try { sessionStorage.removeItem(SHORTFALL_KEY); } catch { /* ignore */ }
  }

  async function copyTxHash() {
    if (!paymentShortfall) return;
    try { await navigator.clipboard.writeText(paymentShortfall.txHash); } catch { /* ignore */ }
  }

  function explorerUrl(chainId: PaymentChainId, txHash: string): string {
    return `${CHAIN_INFO[chainId].blockExplorer}/tx/${txHash}`;
  }

  function shortHash(h: string): string {
    return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
  }

  /** Notify parent that a claim succeeded and the TicketSuccess modal should open. */
  function notifyClaimSuccess(via: "wallet" | "email" | null, edition: number | null, ticket?: ClaimedTicket, email?: string) {
    onclaim?.({ edition, claimedVia: via, ticket, claimerEmail: email });
  }

  async function handleStripeCheckout() {
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
        if (pendingOrderRef) {
          preparedOrderRef = pendingOrderRef;
        } else {
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

      // Stash as a fallback — if pre-upload failed, save-order after return
      // still gets a shot at attaching the form data.
      sessionStorage.setItem(STRIPE_FORM_KEY, JSON.stringify({
        fields: formData,
        claimerEmail: email,
        claimerAddress: address,
        quantity,
        // If pre-upload succeeded, record it so save-order can early-out
        preparedOrderRef,
      }));

      const { url } = await createCheckoutSession({
        eventId,
        seriesId,
        claimerEmail: email,
        quantity: quantity > 1 ? quantity : undefined,
        orderRef: preparedOrderRef,
        encryptedOrder: !preparedOrderRef ? inlineEncryptedOrder : undefined,
      });
      // Remember which series we were buying so EventPage can auto-select on return
      try { sessionStorage.setItem(`woco:stripe-returning:${eventId}`, seriesId); } catch { /* ignore */ }
      window.location.href = url;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start checkout";
      if (!handleAlreadyClaimed(msg)) error = msg;
    } finally {
      stripeLoading = false;
    }
  }

  /**
   * Encrypt and push stashed Stripe form data to the server.
   *
   * The webhook processes the claim in the background and returns 200 to Stripe
   * immediately, so the claimer entry may not be in the Swarm feed by the time
   * we arrive here. The server retries for ~30 s; if it still fails we keep the
   * sessionStorage key so a subsequent page visit can try again automatically
   * (see onMount below). The key is only removed on success.
   */
  async function saveStashedOrderData() {
    const raw = sessionStorage.getItem(STRIPE_FORM_KEY);
    if (!raw || !encryptionKey) return;

    try {
      const stashed = JSON.parse(raw) as {
        fields: Record<string, string>;
        claimerEmail?: string;
        claimerAddress?: string;
        quantity?: number;
        preparedOrderRef?: string;
      };

      // If we pre-uploaded the encrypted order before the Stripe redirect and
      // the webhook attached it to every ticket, there's nothing for save-order
      // to do. Drop the stash and return — avoids a redundant Swarm upload.
      if (stashed.preparedOrderRef) {
        sessionStorage.removeItem(STRIPE_FORM_KEY);
        console.log("[ClaimButton] Pre-uploaded order was used by webhook — skipping save-order");
        return;
      }

      const sealed = await sealJson(encryptionKey, {
        fields: stashed.fields,
        seriesId,
        ...(stashed.claimerAddress ? { claimerAddress: stashed.claimerAddress } : {}),
        ...(stashed.claimerEmail ? { claimerEmail: stashed.claimerEmail } : {}),
      });

      const { saveStripeOrder } = await import("../../api/stripe.js");
      await saveStripeOrder({
        seriesId,
        encryptedOrder: sealed,
        claimerEmail: stashed.claimerEmail,
        claimerAddress: stashed.claimerAddress,
        expectedEditions: stashed.quantity && stashed.quantity > 1 ? stashed.quantity : undefined,
      });

      // Only remove on success — if the server-side save failed (claimer entry
      // not yet written by background claim), keep the key so the next mount
      // of this component retries automatically.
      sessionStorage.removeItem(STRIPE_FORM_KEY);
      console.log("[ClaimButton] Order data saved after Stripe payment");
    } catch (err) {
      console.error("[ClaimButton] Failed to save order data (will retry on next visit):", err);
      // Intentionally NOT removing the key — the next onMount will call
      // saveStashedOrderData() again and try once more.
    }
  }

  function handleClaimClick(method?: "wallet" | "email") {
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

      // Local accounts can't pay — need real wallet
      if (auth.kind === "local") {
        error = "Crypto payments require a wallet. Please sign in with a Web3 wallet or Para.";
        return;
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
  {#if paymentShortfall && !claimed}
    <!--
      Ledger-receipt card for an on-chain payment that was confirmed but
      rejected by the server because the ETH amount was short of the
      slippage tolerance. Shows: what you paid vs required, tx hash with
      explorer link + copy, and the recovery options.
    -->
    <div class="receipt">
      <header class="receipt-head">
        <span class="receipt-stripe" aria-hidden="true"></span>
        <div class="receipt-head-text">
          <h3 class="receipt-title">Payment recorded, ticket pending</h3>
          <p class="receipt-sub">Your transaction confirmed on-chain — but the market moved between your sign and our verification. The amount came up short of the {paymentShortfall.currency} we need for this ticket.</p>
        </div>
      </header>

      <div class="receipt-body">
        <dl class="receipt-rows">
          <div class="receipt-row">
            <dt>You paid</dt>
            <dd class="mono tnum">{paymentShortfall.paid} {paymentShortfall.currency}</dd>
          </div>
          <div class="receipt-row">
            <dt>We required</dt>
            <dd class="mono tnum">{paymentShortfall.expected} {paymentShortfall.currency}</dd>
          </div>
          <div class="receipt-row receipt-row--delta">
            <dt>Shortfall</dt>
            <dd class="mono tnum">
              −{(parseFloat(paymentShortfall.expected) - parseFloat(paymentShortfall.paid)).toFixed(8).replace(/0+$/, "").replace(/\.$/, "")} {paymentShortfall.currency}
              <span class="receipt-delta-pct">{((1 - parseFloat(paymentShortfall.paid) / parseFloat(paymentShortfall.expected)) * 100).toFixed(1)}%</span>
            </dd>
          </div>
        </dl>

        <div class="receipt-tx">
          <span class="receipt-tx-label">Transaction</span>
          <div class="receipt-tx-body">
            <code class="mono receipt-tx-hash" title={paymentShortfall.txHash}>{shortHash(paymentShortfall.txHash)}</code>
            <span class="receipt-tx-chain">on {CHAIN_NAMES[paymentShortfall.chainId]}</span>
          </div>
          <div class="receipt-tx-actions">
            <button type="button" class="receipt-icon-btn" onclick={copyTxHash} title="Copy hash">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
            <a
              class="receipt-icon-btn"
              href={explorerUrl(paymentShortfall.chainId, paymentShortfall.txHash)}
              target="_blank"
              rel="noopener noreferrer"
              title="View on explorer"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </a>
          </div>
        </div>
      </div>

      <footer class="receipt-foot">
        <button type="button" class="receipt-btn receipt-btn--primary" onclick={() => { dismissShortfall(); showChainSelector = true; }}>
          Retry with a fresh payment
        </button>
        <button type="button" class="receipt-btn receipt-btn--ghost" onclick={dismissShortfall}>
          Dismiss
        </button>
        <p class="receipt-note">
          Your prior transaction is irreversible — contact the event organiser if you'd like a refund rather than retrying.
        </p>
      </footer>
    </div>
  {:else if stripeSuccessEmail !== null}
    <!-- Optimistic success card: shown immediately on Stripe return.
         Email is the delivery channel; no polling, no QR, no edition. -->
    <div class="stripe-success" role="status" aria-live="polite">
      <div class="stripe-success-check" aria-hidden="true">
        <span class="stripe-success-ring"></span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>
      <div class="stripe-success-body">
        <strong class="stripe-success-title">Payment confirmed</strong>
        {#if stripeSuccessEmail}
          <span class="stripe-success-sub">
            Your {stripeSuccessQty > 1 ? `${stripeSuccessQty} tickets are` : "ticket is"} on its way to
            <span class="stripe-success-email">{stripeSuccessEmail}</span>
          </span>
        {:else}
          <span class="stripe-success-sub">
            Your {stripeSuccessQty > 1 ? `${stripeSuccessQty} tickets are` : "ticket is"} being sent by email
          </span>
        {/if}
        <span class="stripe-success-note">Check your inbox in the next few minutes — peek at spam if it's late.</span>
      </div>
    </div>
  {:else if approvalPending}
    <div class="pending-badge">
      <span class="pending-icon">&#9679;</span>
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
    <div class="order-form">
      {#if status && status.available <= 0}
        <div class="avail-banner avail-banner--sold-out" role="alert">
          <span class="avail-banner-dot"></span>
          <span class="avail-banner-text">Sold out — no tickets remain</span>
        </div>
      {:else if status && status.available < quantity}
        <div class="avail-banner avail-banner--shortfall" role="alert">
          <span class="avail-banner-dot"></span>
          <span class="avail-banner-text">
            Only {status.available} ticket{status.available === 1 ? "" : "s"} left — reduce quantity to continue
          </span>
        </div>
      {:else if status && status.available > 0 && status.available <= 5}
        <div class="avail-pill" aria-live="polite">
          <span class="avail-pill-dot"></span>
          Only {status.available} left
        </div>
      {/if}
      {#if orderFields}
        {#each orderFields as field}
          <label class="form-field">
            <span class="form-label">
              {field.label || field.placeholder || field.type}
              {#if field.required}<span class="required">*</span>{/if}
            </span>
            {#if field.type === "textarea"}
              <textarea
                bind:value={formData[field.id]}
                placeholder={field.placeholder || ""}
                maxlength={field.maxLength}
                rows="2"
              ></textarea>
            {:else if field.type === "select" && field.options}
              <select bind:value={formData[field.id]}>
                <option value="">Select...</option>
                {#each field.options as opt}
                  <option value={opt}>{opt}</option>
                {/each}
              </select>
            {:else if field.type === "checkbox"}
              <label class="checkbox-row">
                <input
                  type="checkbox"
                  checked={formData[field.id] === "yes"}
                  onchange={(e) => formData[field.id] = (e.target as HTMLInputElement).checked ? "yes" : ""}
                />
                <span>{field.placeholder || field.label}</span>
              </label>
            {:else}
              <input
                type={field.type}
                bind:value={formData[field.id]}
                placeholder={field.placeholder || ""}
                maxlength={field.maxLength}
              />
            {/if}
          </label>
        {/each}
      {/if}

      {#if claimMode === "both" && !hasEmailField}
        <label class="form-field">
          <span class="form-label">Email <span class="form-label-optional">(for email claim)</span></span>
          <input
            type="email"
            bind:value={inlineEmail}
            placeholder="your@email.com"
          />
        </label>
      {:else if stripeAfterForm && !hasEmailField && !auth.isConnected}
        <!-- Need an email for Stripe checkout when user isn't logged in -->
        <label class="form-field">
          <span class="form-label">Email <span class="required">*</span></span>
          <input
            type="email"
            bind:value={stripeEmail}
            placeholder="your@email.com"
          />
        </label>
      {/if}

      <div class="form-actions">
        {#if stripeAfterForm}
          <!-- Order form was shown before Stripe checkout -->
          {#if stripeLoading}
            <button class="stripe-btn stripe-btn--primary" disabled>Redirecting to Stripe…</button>
          {:else if status && status.available <= 0}
            <button class="stripe-btn stripe-btn--primary" disabled>Sold out</button>
          {:else if status && status.available < quantity}
            <button class="stripe-btn stripe-btn--primary" disabled>Not enough tickets</button>
          {:else}
            <button
              class="stripe-btn stripe-btn--primary"
              class:preparing={orderRefUploading && !pendingOrderRef}
              onclick={handleStripeCheckout}
              disabled={!formValid()}
            >
              Continue to payment {buyerFees?.cardTotal ? `— ${buyerFees.cardTotal}` : `— ${priceLabel}`}
            </button>
          {/if}
        {:else if claimMode === "both"}
          {#if claiming}
            <button class="claim-btn" disabled>{step}</button>
          {:else}
            <button
              class="claim-btn"
              onclick={() => { chosenMethod = "wallet"; handleClaim(); }}
              disabled={!walletFormValid()}
            >
              {approvalRequired ? "Request with wallet" : "Claim with wallet"}
            </button>
            <button
              class="claim-btn claim-btn--outline"
              onclick={() => { chosenMethod = "email"; handleClaim(); }}
              disabled={!formValid() || (!hasEmailField && !inlineEmail.trim())}
            >
              {approvalRequired ? "Request with email" : "Claim with email"}
            </button>
          {/if}
        {:else}
          <button class="claim-btn" onclick={handleClaim} disabled={claiming || !(claimMode === "email" ? formValid() : walletFormValid())}>
            {#if claiming}
              {step}
            {:else if approvalRequired}
              Submit request
            {:else if claimMode === "email"}
              Claim with email
            {:else}
              Claim ticket
            {/if}
          </button>
        {/if}
        <button class="cancel-btn" onclick={() => { showOrderForm = false; chosenMethod = null; stripeAfterForm = false; }}>Cancel</button>
      </div>
      {#if hasOrderForm}
        <p class="encrypt-note">Your info is encrypted — only the organizer can read it.</p>
      {/if}
    </div>
  {:else if showChainSelector && isPaid && hasCrypto && payment}
    <div class="pay-sheet" class:pay-sheet--ready={!!selectedChain}>
      <!-- Price header -->
      <div class="pay-header">
        <span class="pay-header-label">Total</span>
        <div class="pay-price-stack">
          <span class="pay-price-primary">{buyerFees?.cryptoTotal ?? priceLabel}</span>
          <span class="pay-price-secondary">
            {#if ethPriceLoading}
              fetching rate...
            {:else if ethEquivalent}
              ≈ {ethEquivalent} ETH
            {/if}
          </span>
        </div>
      </div>

      <!-- Fee receipt (when buyer pays fees) -->
      {#if buyerFees}
        <div class="pay-receipt">
          <div class="pay-receipt-row"><span>{buyerFees.baseLabel}</span><span>{buyerFees.base}</span></div>
          <div class="pay-receipt-row pay-receipt-fee"><span>Platform fee (1.5%)</span><span>{buyerFees.platform}</span></div>
        </div>
      {/if}

      <!-- Payment method toggle (ETH vs USDC) -->
      <div class="pay-section">
        <span class="pay-section-label">Pay with</span>
        <div class="pay-method-toggle">
          <button
            class="pay-method-btn"
            class:pay-method-btn--active={selectedPayMethod === "ETH"}
            onclick={() => { selectedPayMethod = "ETH"; }}
          >
            <span class="pay-method-icon">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1L3.5 8.5L8 11L12.5 8.5L8 1Z" fill="currentColor" opacity="0.7"/><path d="M8 11L3.5 8.5L8 15L12.5 8.5L8 11Z" fill="currentColor"/></svg>
            </span>
            <span class="pay-method-label">ETH</span>
            {#if ethEquivalent}
              <span class="pay-method-amount">{ethEquivalent}</span>
            {/if}
          </button>
          <button
            class="pay-method-btn"
            class:pay-method-btn--active={selectedPayMethod === "USDC"}
            class:pay-method-btn--disabled={!usdcAvailableOnChain}
            disabled={!usdcAvailableOnChain}
            onclick={() => { selectedPayMethod = "USDC"; }}
          >
            <span class="pay-method-icon">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5" fill="none"/><text x="8" y="11" text-anchor="middle" font-size="9" font-weight="700" fill="currentColor">$</text></svg>
            </span>
            <span class="pay-method-label">USDC</span>
          </button>
        </div>
        {#if selectedChain && !usdcAvailableOnChain && selectedPayMethod === "ETH"}
          <span class="pay-method-note">USDC not available on {CHAIN_NAMES[selectedChain]}</span>
        {/if}
      </div>

      <!-- Network selector -->
      <div class="pay-section">
        <span class="pay-section-label">Network</span>
        <div class="pay-chains">
          {#each payment.acceptedChains as chainId}
            <button
              class="pay-chain-card"
              class:pay-chain-card--selected={selectedChain === chainId}
              onclick={() => {
                selectedChain = chainId;
                // If switching to a chain without USDC, fall back to ETH
                if (selectedPayMethod === "USDC" && !USDC_ADDRESSES[chainId]) {
                  selectedPayMethod = "ETH";
                }
              }}
            >
              <span class="pay-chain-dot" style="background: {CHAIN_COLORS[chainId] || '#888'}"></span>
              <span class="pay-chain-name">{CHAIN_NAMES[chainId]}</span>
            </button>
          {/each}
        </div>
      </div>

      <!-- CTA + cancel -->
      <div class="pay-actions">
        {#if claiming}
          <button class="pay-cta" disabled>
            <span class="pay-spinner"></span>
            {step}
          </button>
        {:else}
          <button
            class="pay-cta"
            onclick={handlePaymentAndClaim}
            disabled={!selectedChain || ethPriceLoading}
          >
            {#if !selectedChain}
              Select a network
            {:else if selectedPayMethod === "USDC"}
              Pay ≈ {priceLabel} in USDC
            {:else if ethEquivalent}
              Pay {ethEquivalent} ETH
            {:else}
              Pay {priceLabel}
            {/if}
          </button>
        {/if}
        <button class="pay-cancel" onclick={() => { showChainSelector = false; selectedChain = null; selectedPayMethod = "ETH"; }}>Cancel</button>
      </div>

      {#if auth.kind === "local"}
        <p class="pay-note">Crypto payments require a Web3 wallet or Para account.</p>
      {/if}

      {#if hasStripe}
        <div class="pay-divider">
          <span class="pay-divider-line"></span>
          <span class="pay-divider-text">or</span>
          <span class="pay-divider-line"></span>
        </div>
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
        {#if !auth.isConnected && !hasEmailField}
          <input
            class="stripe-email-input"
            type="email"
            placeholder="Email for your ticket"
            bind:value={stripeEmail}
          />
        {/if}
      {/if}
    </div>
  {:else if isPaid && hasStripe && (!hasCrypto || isCardFirst)}
    <!-- Card-first: passkey/local users, or Stripe-only events -->
    <div class="pay-sheet">
      {#if buyerFees}
        <div class="pay-receipt">
          <div class="pay-receipt-row"><span>{buyerFees.baseLabel}</span><span>{buyerFees.base}</span></div>
          {#if buyerFees.stripe}
            <div class="pay-receipt-row pay-receipt-fee"><span>Processing</span><span>{buyerFees.stripe}</span></div>
          {/if}
          <div class="pay-receipt-row pay-receipt-fee"><span>Platform fee (1.5%)</span><span>{buyerFees.platform}</span></div>
          <div class="pay-receipt-row pay-receipt-total"><span>Total</span><span>{buyerFees.cardTotal ?? priceLabel}</span></div>
        </div>
      {/if}

      <button
        class="stripe-btn stripe-btn--primary"
        disabled={stripeLoading || (status?.available === 0)}
        onclick={handleStripeCheckout}
      >
        {#if stripeLoading}
          Redirecting to Stripe...
        {:else if status?.available === 0}
          Sold out
        {:else}
          Pay with card {buyerFees?.cardTotal ? `— ${buyerFees.cardTotal}` : `— ${priceLabel}`}
        {/if}
      </button>
      {#if !auth.isConnected && !hasEmailField}
        <input
          class="stripe-email-input"
          type="email"
          placeholder="Email for your ticket"
          bind:value={stripeEmail}
        />
      {/if}

      {#if hasCrypto}
        <div class="pay-divider">
          <span class="pay-divider-line"></span>
          <span class="pay-divider-text">or</span>
          <span class="pay-divider-line"></span>
        </div>
        <button
          class="pay-crypto-link"
          onclick={() => isCardFirst ? showWalletModal = true : handleClaimClick()}
        >
          Pay with crypto {buyerFees?.cryptoTotal ? `— ${buyerFees.cryptoTotal}` : `— ${priceLabel}`}
        </button>
      {/if}
    </div>
  {:else if isPaid && !hasCrypto && hasStripe}
    <!-- Stripe-only, no crypto at all -->
    <div class="pay-sheet">
      {#if buyerFees}
        <div class="pay-receipt">
          <div class="pay-receipt-row"><span>{buyerFees.baseLabel}</span><span>{buyerFees.base}</span></div>
          {#if buyerFees.stripe}
            <div class="pay-receipt-row pay-receipt-fee"><span>Processing</span><span>{buyerFees.stripe}</span></div>
          {/if}
          <div class="pay-receipt-row pay-receipt-fee"><span>Platform fee (1.5%)</span><span>{buyerFees.platform}</span></div>
          <div class="pay-receipt-row pay-receipt-total"><span>Total</span><span>{buyerFees.cardTotal ?? priceLabel}</span></div>
        </div>
      {/if}

      <button
        class="stripe-btn stripe-btn--primary"
        disabled={stripeLoading || (status?.available === 0)}
        onclick={handleStripeCheckout}
      >
        {#if stripeLoading}
          Redirecting to Stripe...
        {:else if status?.available === 0}
          Sold out
        {:else}
          Pay with card {buyerFees?.cardTotal ? `— ${buyerFees.cardTotal}` : `— ${priceLabel}`}
        {/if}
      </button>
      {#if !auth.isConnected && !hasEmailField}
        <input
          class="stripe-email-input"
          type="email"
          placeholder="Email for your ticket"
          bind:value={stripeEmail}
        />
      {/if}
    </div>
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

  {#if status && !claimed && !showOrderForm}
    <span class="availability">
      {status.available} / {status.totalSupply} available
    </span>
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
    color: #fff;
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

  .claim-btn--outline {
    background: transparent;
    border: 1px solid var(--accent);
    color: var(--accent-text);
  }

  .claim-btn--outline:hover:not(:disabled) {
    background: var(--accent-subtle);
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

  /* ══════════════════════════════════════════════════
   * STRIPE SUCCESS CARD — optimistic, email-first.
   *
   * Quiet conviction: one decisive checkmark, email treated as the hero
   * fact, a single ring emission pulse that plays ONCE on mount (not
   * looping). Designed to match the TicketSuccess modal's visual language
   * (color-mix status tints, monospace numerical detail, hairline borders)
   * without reusing its full modal chrome.
   * ══════════════════════════════════════════════ */
  .stripe-success {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.875rem 1rem;
    background: color-mix(in srgb, var(--success) 7%, var(--bg-surface));
    border: 1px solid color-mix(in srgb, var(--success) 22%, var(--border));
    border-radius: var(--radius-md);
    max-width: 420px;
    animation: stripe-success-rise 420ms cubic-bezier(0.34, 1.36, 0.64, 1);
  }
  @keyframes stripe-success-rise {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .stripe-success-check {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    background: color-mix(in srgb, var(--success) 18%, transparent);
    color: var(--success);
    border: 1px solid color-mix(in srgb, var(--success) 34%, transparent);
    flex-shrink: 0;
  }
  /* One-shot ring emission — plays once on mount, then vanishes. */
  .stripe-success-ring {
    position: absolute;
    inset: -2px;
    border-radius: 50%;
    border: 1.5px solid var(--success);
    opacity: 0;
    animation: stripe-success-pulse 1.2s cubic-bezier(0.16, 1, 0.3, 1) 220ms 1 forwards;
    pointer-events: none;
  }
  @keyframes stripe-success-pulse {
    0%   { transform: scale(1);   opacity: 0.7; }
    100% { transform: scale(1.6); opacity: 0;   }
  }

  .stripe-success-body {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }
  .stripe-success-title {
    font-size: 0.9375rem;
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.01em;
  }
  .stripe-success-sub {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    line-height: 1.45;
  }
  .stripe-success-email {
    display: inline;
    font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
    font-size: 0.8125rem;
    color: var(--accent-text);
    word-break: break-all;
    border-bottom: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    padding-bottom: 1px;
  }
  .stripe-success-note {
    margin-top: 0.375rem;
    padding-top: 0.5rem;
    border-top: 1px solid color-mix(in srgb, var(--success) 14%, var(--border));
    font-size: 0.6875rem;
    color: var(--text-muted);
    letter-spacing: 0.01em;
  }

  .pending-badge {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: #d97706;
    border: 1px solid #d97706;
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }

  .pending-icon {
    font-size: 0.5rem;
    opacity: 0.8;
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

  .availability {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .error {
    color: var(--error);
    font-size: 0.75rem;
    margin: 0;
    text-align: right;
  }

  /* Order form */
  .order-form {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    width: 100%;
    min-width: 240px;
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .form-label {
    font-size: 0.75rem;
    color: var(--text-secondary);
    font-weight: 500;
  }

  .required {
    color: var(--error);
  }

  .form-label-optional {
    font-weight: 400;
    color: var(--text-muted);
    font-style: italic;
  }

  .order-form input,
  .order-form textarea,
  .order-form select {
    font-size: 0.8125rem;
    padding: 0.375rem 0.5rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
  }

  .order-form input:focus,
  .order-form textarea:focus,
  .order-form select:focus {
    border-color: var(--accent);
    outline: none;
    box-shadow: 0 0 0 2px var(--accent-subtle);
  }

  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    cursor: pointer;
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }

  .checkbox-row input[type="checkbox"] {
    width: 0.875rem;
    height: 0.875rem;
    accent-color: var(--accent);
  }

  .form-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }

  .cancel-btn {
    padding: 0.5rem 0.75rem;
    font-size: 0.8125rem;
    color: var(--text-muted);
    transition: color var(--transition);
  }

  .cancel-btn:hover {
    color: var(--text-secondary);
  }

  .encrypt-note {
    font-size: 0.6875rem;
    color: var(--text-muted);
    margin: 0;
    text-align: right;
  }

  /* ── Payment sheet ── */
  .pay-sheet {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    width: 100%;
    min-width: 260px;
    max-width: 320px;
    padding: 1rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    transition: border-color 0.25s ease, box-shadow 0.25s ease;
  }

  .pay-sheet--ready {
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
    box-shadow: 0 0 20px -6px color-mix(in srgb, var(--accent) 15%, transparent);
  }

  /* Price header */
  .pay-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding-bottom: 0.625rem;
    border-bottom: 1px solid var(--border);
  }

  .pay-header-label {
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .pay-price-stack {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.0625rem;
  }

  .pay-price-primary {
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
  }

  .pay-price-secondary {
    font-size: 0.6875rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  /* Sections */
  .pay-section {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .pay-section-label {
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  /* Payment method toggle */
  .pay-method-toggle {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.375rem;
  }

  .pay-method-btn {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.625rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition);
  }

  .pay-method-btn:hover:not(:disabled) {
    border-color: var(--border-hover);
    color: var(--text);
  }

  .pay-method-btn--active {
    background: color-mix(in srgb, var(--accent) 10%, var(--bg-input));
    border-color: var(--accent);
    color: var(--text);
  }

  .pay-method-btn--disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .pay-method-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    color: var(--text-muted);
  }

  .pay-method-btn--active .pay-method-icon {
    color: var(--accent-text);
  }

  .pay-method-label {
    font-weight: 600;
  }

  .pay-method-amount {
    margin-left: auto;
    font-size: 0.6875rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .pay-method-note {
    font-size: 0.625rem;
    color: var(--text-muted);
    font-style: italic;
  }

  /* Chain selector cards */
  .pay-chains {
    display: flex;
    gap: 0.375rem;
    flex-wrap: wrap;
  }

  .pay-chain-card {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.4375rem 0.625rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all var(--transition);
  }

  .pay-chain-card:hover {
    border-color: var(--border-hover);
  }

  .pay-chain-card--selected {
    background: color-mix(in srgb, var(--accent) 8%, var(--bg-input));
    border-color: var(--accent);
  }

  .pay-chain-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .pay-chain-name {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-secondary);
  }

  .pay-chain-card--selected .pay-chain-name {
    color: var(--text);
  }

  /* CTA button */
  .pay-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-top: 0.25rem;
  }

  .pay-cta {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.625rem 1rem;
    font-size: 0.8125rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: #fff;
    white-space: nowrap;
    transition: background 0.2s ease, opacity 0.2s ease;
  }

  .pay-cta:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .pay-cta:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .pay-spinner {
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.25);
    border-top-color: #fff;
    border-radius: 50%;
    animation: pay-spin 0.6s linear infinite;
  }

  @keyframes pay-spin {
    to { transform: rotate(360deg); }
  }

  .pay-cancel {
    padding: 0.625rem 0.75rem;
    font-size: 0.8125rem;
    color: var(--text-muted);
    transition: color var(--transition);
    white-space: nowrap;
  }

  .pay-cancel:hover {
    color: var(--text-secondary);
  }

  .pay-note {
    font-size: 0.625rem;
    color: var(--text-muted);
    margin: 0;
    text-align: center;
  }

  /* Stripe card payment */
  .pay-divider {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 0.5rem 0;
  }

  .pay-divider-line {
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  .pay-divider-text {
    font-size: 0.6875rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* ── Buyer fee receipt ── */
  .pay-receipt {
    display: flex;
    flex-direction: column;
    gap: 0.1875rem;
    padding: 0.5rem 0.625rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }

  .pay-receipt-row {
    display: flex;
    justify-content: space-between;
    color: var(--text-secondary);
  }

  .pay-receipt-fee {
    color: var(--text-muted);
    font-size: 0.6875rem;
  }

  .pay-receipt-total {
    border-top: 1px solid var(--border);
    padding-top: 0.25rem;
    margin-top: 0.125rem;
    font-weight: 600;
    color: var(--text);
  }

  /* ── Stripe card payment ── */
  .stripe-btn {
    width: 100%;
    padding: 0.625rem 1rem;
    font-size: 0.8125rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: #635bff;
    color: #fff;
    white-space: nowrap;
    transition: background 0.2s ease, opacity 0.2s ease;
  }

  .stripe-btn--primary {
    padding: 0.75rem 1rem;
    font-size: 0.875rem;
    border-radius: var(--radius-md);
    background: linear-gradient(135deg, #635bff 0%, #7c6cf0 100%);
    box-shadow: 0 2px 12px -2px rgba(99, 91, 255, 0.3);
  }

  .stripe-btn--primary:hover:not(:disabled) {
    background: linear-gradient(135deg, #5147e5 0%, #6b5ad8 100%);
    box-shadow: 0 4px 16px -2px rgba(99, 91, 255, 0.4);
  }

  .stripe-btn:hover:not(:disabled) {
    background: #5147e5;
  }

  .stripe-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ══════════════════════════════════════════════════
   * AVAILABILITY FLAGS — amber pill / red banner
   * ══════════════════════════════════════════════ */

  /* Ambient pill: "Only 3 left" — sits inside the form header area */
  .avail-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    align-self: flex-start;
    padding: 0.25rem 0.5rem;
    font-size: 0.6875rem;
    font-weight: 600;
    font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
    letter-spacing: 0.01em;
    color: #fbbf24;
    background: color-mix(in srgb, #f59e0b 13%, transparent);
    border: 1px solid color-mix(in srgb, #f59e0b 24%, transparent);
    border-radius: 4px;
    margin-bottom: 0.125rem;
  }
  .avail-pill-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #f59e0b;
    box-shadow: 0 0 6px rgba(245, 158, 11, 0.7);
  }

  /* Banner: full-width, for hard blocks (sold out / shortfall) */
  .avail-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.625rem 0.75rem;
    border-radius: var(--radius-sm);
    font-size: 0.8125rem;
    font-weight: 500;
    animation: avail-banner-in 180ms ease-out;
    margin-bottom: 0.25rem;
  }
  .avail-banner-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .avail-banner--sold-out {
    color: #fca5a5;
    background: color-mix(in srgb, var(--error) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--error) 28%, transparent);
  }
  .avail-banner--sold-out .avail-banner-dot {
    background: var(--error);
    box-shadow: 0 0 8px rgba(244, 63, 94, 0.6);
  }
  .avail-banner--shortfall {
    color: #fcd34d;
    background: color-mix(in srgb, #f59e0b 12%, transparent);
    border: 1px solid color-mix(in srgb, #f59e0b 30%, transparent);
  }
  .avail-banner--shortfall .avail-banner-dot {
    background: #f59e0b;
    box-shadow: 0 0 8px rgba(245, 158, 11, 0.55);
  }
  @keyframes avail-banner-in {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* ══════════════════════════════════════════════════
   * PAY BUTTON — ambient "preparing" shimmer
   * Non-blocking: the button stays fully clickable. The shimmer is a
   * quiet reassurance that something is happening in the background.
   * ══════════════════════════════════════════════ */
  .stripe-btn--primary.preparing {
    position: relative;
    overflow: hidden;
  }
  .stripe-btn--primary.preparing::after {
    content: "";
    position: absolute;
    bottom: 0;
    left: 0;
    height: 2px;
    width: 35%;
    background: linear-gradient(
      90deg,
      transparent 0%,
      rgba(255, 255, 255, 0.85) 50%,
      transparent 100%
    );
    animation: prepare-sweep 1.6s ease-in-out infinite;
    pointer-events: none;
  }
  @keyframes prepare-sweep {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(340%); }
  }

  .pay-crypto-link {
    width: 100%;
    padding: 0.5rem;
    font-size: 0.75rem;
    color: var(--accent-text);
    text-align: center;
    transition: opacity var(--transition);
  }

  .pay-crypto-link:hover {
    opacity: 0.75;
    text-decoration: underline;
  }

  .stripe-email-input {
    width: 100%;
    padding: 0.5rem 0.75rem;
    font-size: 0.8125rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-input);
    color: var(--text);
    margin-top: 0.375rem;
  }

  .stripe-email-input::placeholder {
    color: var(--text-muted);
  }

  /* ── Ledger-receipt: payment-shortfall card ─────────────────────────
     Amber-tinted, monospace, dashed receipt rules. Composed tone — the
     payment confirmed, the user is owed an explanation, not an apology. */
  .receipt {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 28rem;
    margin: 0 auto;
    background: color-mix(in srgb, var(--accent) 5%, var(--bg-card, var(--bg)));
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-radius: var(--radius-md);
    box-shadow:
      0 1px 0 color-mix(in srgb, var(--accent) 12%, transparent) inset,
      0 8px 24px -16px rgba(0, 0, 0, 0.4);
    overflow: hidden;
    animation: receipt-rise 320ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes receipt-rise {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .receipt-head {
    position: relative;
    display: flex;
    gap: 0.75rem;
    padding: 0.875rem 1rem 0.75rem;
  }

  /* Caution-tape stripe — diagonal amber/transparent across the top edge */
  .receipt-stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
    background: repeating-linear-gradient(
      135deg,
      var(--accent) 0 8px,
      transparent 8px 16px
    );
    opacity: 0.7;
  }

  .receipt-head-text { flex: 1; min-width: 0; }

  .receipt-title {
    margin: 0 0 0.25rem;
    font-size: 0.875rem;
    font-weight: 600;
    letter-spacing: -0.005em;
    color: var(--text);
  }

  .receipt-sub {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.5;
    color: var(--text-muted);
  }

  .receipt-body {
    padding: 0.25rem 1rem 0.75rem;
  }

  .receipt-rows {
    margin: 0;
    padding: 0.25rem 0;
    display: flex;
    flex-direction: column;
  }

  .receipt-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 1rem;
    padding: 0.4375rem 0;
    font-size: 0.8125rem;
    border-bottom: 1px dashed color-mix(in srgb, var(--text-muted) 28%, transparent);
  }

  .receipt-row:last-child { border-bottom: none; }

  .receipt-row dt {
    color: var(--text-muted);
    font-size: 0.75rem;
    letter-spacing: 0.01em;
  }

  .receipt-row dd {
    margin: 0;
    color: var(--text);
    font-size: 0.8125rem;
    text-align: right;
  }

  .receipt-row--delta dt,
  .receipt-row--delta dd {
    color: var(--accent-text, var(--accent));
    font-weight: 600;
  }

  .receipt-delta-pct {
    display: inline-block;
    margin-left: 0.5rem;
    padding: 0.0625rem 0.375rem;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--accent-text, var(--accent));
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    border-radius: 999px;
    vertical-align: 1px;
  }

  .receipt-tx {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    margin-top: 0.625rem;
    padding: 0.5rem 0.625rem;
    background: color-mix(in srgb, var(--text) 4%, transparent);
    border: 1px solid color-mix(in srgb, var(--text-muted) 18%, transparent);
    border-radius: var(--radius-sm);
  }

  .receipt-tx-label {
    flex-shrink: 0;
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  .receipt-tx-body {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 0.4375rem;
    overflow: hidden;
  }

  .receipt-tx-hash {
    font-size: 0.75rem;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .receipt-tx-chain {
    font-size: 0.6875rem;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .receipt-tx-actions {
    display: flex;
    gap: 0.125rem;
    flex-shrink: 0;
  }

  .receipt-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.625rem;
    height: 1.625rem;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
  }

  .receipt-icon-btn:hover {
    color: var(--text);
    background: color-mix(in srgb, var(--text) 6%, transparent);
    border-color: color-mix(in srgb, var(--text-muted) 22%, transparent);
  }

  .receipt-foot {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.625rem 1rem 0.875rem;
    border-top: 1px solid color-mix(in srgb, var(--text-muted) 16%, transparent);
    background: color-mix(in srgb, var(--accent) 3%, transparent);
  }

  .receipt-btn {
    width: 100%;
    padding: 0.5625rem 0.875rem;
    font-size: 0.8125rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  }

  .receipt-btn--primary {
    background: var(--accent);
    color: var(--accent-on, #fff);
  }

  .receipt-btn--primary:hover {
    background: color-mix(in srgb, var(--accent) 88%, #000);
  }

  .receipt-btn--ghost {
    background: transparent;
    color: var(--text-muted);
    border-color: color-mix(in srgb, var(--text-muted) 22%, transparent);
  }

  .receipt-btn--ghost:hover {
    color: var(--text);
    border-color: color-mix(in srgb, var(--text-muted) 38%, transparent);
  }

  .receipt-note {
    margin: 0.125rem 0 0;
    font-size: 0.6875rem;
    line-height: 1.5;
    color: var(--text-muted);
    text-align: center;
  }

  .mono {
    font-family: ui-monospace, "SF Mono", "JetBrains Mono", "Menlo", monospace;
  }

  .tnum {
    font-variant-numeric: tabular-nums;
  }
</style>
