<script lang="ts">
  import type { OrderField, SealedBox, ClaimMode, PaymentConfig, PaymentChainId, PaymentProof } from "@woco/shared";
  import { sealJson, CHAIN_NAMES, USDC_ADDRESSES } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { claimTicket, claimTicketByEmail, getClaimStatus } from "../../api/events.js";
  import type { SeriesClaimStatus } from "@woco/shared";
  import { cacheGet, cacheSet, cacheDel, cacheKey, TTL } from "../../cache/cache.js";
  import { onMount } from "svelte";

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
  }

  let { eventId, seriesId, totalSupply, encryptionKey, orderFields, claimMode = "wallet", approvalRequired = false, apiUrl, payment, eventEndDate }: Props = $props();

  console.log(`[ClaimButton] seriesId=${seriesId} payment:`, payment ?? "FREE");

  // Payment state
  const isPaid = $derived(!!payment && parseFloat(payment.price) > 0);
  let showChainSelector = $state(false);
  let selectedChain = $state<PaymentChainId | null>(null);
  let paymentProofResult = $state<PaymentProof | null>(null);
  /** ETH equivalent for USD-priced events (fetched when chain selector opens) */
  let ethEquivalent = $state<string | null>(null);
  let ethPriceLoading = $state(false);
  /** User's chosen payment method — relevant for USD-priced events where ETH or USDC are both options */
  let selectedPayMethod = $state<"ETH" | "USDC">("ETH");
  const priceLabel = $derived(
    payment
      ? payment.currency === "USD"
        ? `$${payment.price}`
        : `${payment.price} ${payment.currency}`
      : "",
  );
  /** Whether USDC is available on the selected chain */
  const usdcAvailableOnChain = $derived(
    selectedChain ? !!USDC_ADDRESSES[selectedChain] : false,
  );
  /** Whether the user can choose between ETH and USDC (USD-priced + chain supports USDC) */
  const showPayMethodChoice = $derived(
    payment?.currency === "USD" && usdcAvailableOnChain,
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
  /** Inline email input for email claims when no email field in order form */
  let inlineEmail = $state("");
  /** Whether the order form already includes an email-type field */
  const hasEmailField = $derived(
    !!orderFields?.some((f) => f.type === "email" || f.id === "__email")
  );

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

    // For paid events: always route through payment flow
    if (isPaid && !paymentProofResult) {
      if (!showChainSelector) {
        if (payment!.acceptedChains.length === 1) {
          selectedChain = payment!.acceptedChains[0];
        }
        if (payment!.currency === "USD" && !ethEquivalent) {
          ethPriceLoading = true;
          import("../../payment/eth-price.js").then(({ usdToETH }) =>
            usdToETH(payment!.price).then((eth) => { ethEquivalent = eth; ethPriceLoading = false; })
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

      // For USD-priced events, resolve to the user's chosen pay method
      let paymentConfig = payment;
      if (payment.currency === "USD") {
        if (selectedPayMethod === "USDC") {
          // Pay exact USD amount in USDC (1:1 stablecoin)
          paymentConfig = { ...payment, price: payment.price, currency: "USDC" };
        } else {
          // Pay in ETH — convert USD to ETH equivalent
          step = "Fetching ETH price...";
          const { usdToETH } = await import("../../payment/eth-price.js");
          const ethAmount = await usdToETH(payment.price);
          ethEquivalent = ethAmount;
          paymentConfig = { ...payment, price: ethAmount, currency: "ETH" };
        }
      }

      step = "Switching chain...";
      const { executePayment } = await import("../../payment/pay.js");

      const displayAmount = payment.currency === "USD"
        ? `${ethEquivalent} ETH ($${payment.price})`
        : `${payment.price} ${payment.currency}`;
      step = `Confirm ${displayAmount} payment...`;
      const result = await executePayment(paymentConfig, selectedChain, eventId, eventEndDate);
      paymentProofResult = result.proof;
      showChainSelector = false;

      step = "Payment confirmed. Claiming ticket...";

      // Now proceed with the normal claim flow (proof is attached)
      await handleClaimWithProof(result.proof);
    } catch (e) {
      error = e instanceof Error ? e.message : "Payment failed";
    } finally {
      claiming = false;
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
      if (!result.ok) { error = result.error || "Failed to claim ticket"; return; }

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
      showOrderForm = false;
      step = "";
      cacheDel(cacheKey.claimStatus(eventId, seriesId, "anon"));
    } else {
      // Wallet — session already ensured in handlePaymentAndClaim if paid
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

      const result = await claimTicket(eventId, seriesId, auth.parent!, encryptedOrder, apiUrl, proof);
      if (!result.ok) { error = result.error || "Failed to claim ticket"; return; }

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
      showOrderForm = false;
      step = "";

      if (auth.parent) {
        const addr = auth.parent.toLowerCase();
        cacheSet(cacheKey.claimed(eventId, seriesId, addr), { edition: claimedEdition, via: "wallet" }, TTL.PERMANENT);
        cacheDel(cacheKey.claimStatus(eventId, seriesId, addr));
      }
    }
  }

  async function handleClaim() {
    if (claiming) return;

    // Hard gate: paid events MUST go through the payment flow — never fall through
    if (isPaid && !paymentProofResult) {
      if (!showChainSelector) {
        if (payment!.acceptedChains.length === 1) {
          selectedChain = payment!.acceptedChains[0];
        }
        // Fetch ETH equivalent for USD-priced events
        if (payment!.currency === "USD" && !ethEquivalent) {
          ethPriceLoading = true;
          import("../../payment/eth-price.js").then(({ usdToETH }) =>
            usdToETH(payment!.price).then((eth) => { ethEquivalent = eth; ethPriceLoading = false; })
          ).catch(() => { ethPriceLoading = false; });
        }
        showChainSelector = true;
        showOrderForm = false;
      }
      // Always return — chain selector's Pay button calls handlePaymentAndClaim()
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
          error = result.error || "Failed to claim ticket";
          return;
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
        showOrderForm = false;
        step = "";
        // Email claims: no address to key permanent cache on, but invalidate
        // status cache so availability count refreshes next visit
        cacheDel(cacheKey.claimStatus(eventId, seriesId, "anon"));
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
          error = result.error || "Failed to claim ticket";
          return;
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
  {#if approvalPending}
    <div class="pending-badge">
      <span class="pending-icon">&#9679;</span>
      Pending Approval
    </div>
    <p class="pending-note">Your request has been submitted. You'll receive your ticket once the organiser approves it.</p>
  {:else if claimed}
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
      {/if}

      <div class="form-actions">
        {#if claimMode === "both"}
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
        <button class="cancel-btn" onclick={() => { showOrderForm = false; chosenMethod = null; }}>Cancel</button>
      </div>
      {#if hasOrderForm}
        <p class="encrypt-note">Your info is encrypted — only the organizer can read it.</p>
      {/if}
    </div>
  {:else if showChainSelector && isPaid && payment}
    <div class="pay-sheet" class:pay-sheet--ready={!!selectedChain}>
      <!-- Price header -->
      <div class="pay-header">
        <span class="pay-header-label">Total</span>
        <div class="pay-price-stack">
          <span class="pay-price-primary">{priceLabel}</span>
          {#if payment.currency === "USD"}
            <span class="pay-price-secondary">
              {#if ethPriceLoading}
                fetching rate...
              {:else if ethEquivalent}
                ≈ {ethEquivalent} ETH
              {/if}
            </span>
          {/if}
        </div>
      </div>

      <!-- Payment method toggle (USD-priced only, when chain supports USDC) -->
      {#if payment.currency === "USD"}
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
              <span class="pay-method-amount">{payment.price}</span>
            </button>
          </div>
          {#if selectedChain && !usdcAvailableOnChain && selectedPayMethod === "ETH"}
            <span class="pay-method-note">USDC not available on {CHAIN_NAMES[selectedChain]}</span>
          {/if}
        </div>
      {/if}

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
            {:else if payment.currency === "USDC"}
              Pay {payment.price} USDC
            {:else if payment.currency === "ETH"}
              Pay {payment.price} ETH
            {:else if selectedPayMethod === "USDC"}
              Pay {payment.price} USDC
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
</style>
