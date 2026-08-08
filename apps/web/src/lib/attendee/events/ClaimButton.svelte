<script lang="ts">
  import type { OrderField, SealedBox, PaymentConfig } from "@woco/shared";
  import { sealJson } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { getClaimStatus } from "../../api/events.js";
  import { createCheckoutSession } from "../../api/stripe.js";
  import type { SeriesClaimStatus } from "@woco/shared";
  import { cacheGet, cacheSet, cacheKey, TTL } from "../../cache/cache.js";
  import { onMount } from "svelte";
  import {
    CURRENCY_SYMBOLS,
    getEmailFromForm as getEmailFromFormPure,
    buildOrderSnapshot as buildOrderSnapshotPure,
  } from "./claim/helpers.js";
  import { calculateBuyerFees } from "./claim/fees.js";
  import StripeSuccessCard from "./claim/StripeSuccessCard.svelte";
  import ReservationPill from "./claim/ReservationPill.svelte";
  import StripePayPanel from "./claim/StripePayPanel.svelte";
  import OrderForm from "./claim/OrderForm.svelte";
  import { useReservation } from "./claim/useReservation.svelte.js";
  import { useOrderPrefetch } from "./claim/useOrderPrefetch.svelte.js";
  import { useStripeSuccess } from "./claim/useStripeSuccess.svelte.js";

  // Stripe checkout is the ONLY purchase path — the v1 claim rail (free /
  // email / crypto-proof claims against POST .../claim) was deleted with the
  // rail; tickets mint on-chain in the webhook. Free events need a v2 mint
  // path before freeEventsAllowed can flip back on.

  interface Props {
    eventId: string;
    seriesId: string;
    /** Organizer's X25519 public key — present when event collects info */
    encryptionKey?: string;
    /** Order form fields — present when event collects info */
    orderFields?: OrderField[];
    /** Override API base URL — used when event is hosted on an organiser's own server */
    apiUrl?: string;
    /** Payment config — pricing + Stripe availability */
    payment?: PaymentConfig;
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
    /** Organiser display name, shown in the checkout privacy notice so the buyer
     *  is told who actually receives their details. Falls back to generic wording. */
    organiserName?: string;
  }

  let { eventId, seriesId, encryptionKey, orderFields, apiUrl, payment, quantity = 1, eager = false, organiserName }: Props = $props();

  const isPaid = $derived(!!payment && parseFloat(payment.price) > 0);
  const hasStripe = $derived(!!payment?.stripeEnabled);
  let stripeLoading = $state(false);
  let stripeEmail = $state("");
  // eventId/seriesId are per-mount stable (component remounts per series) —
  // the init-time captures below are intentional.
  // svelte-ignore state_referenced_locally
  const stripeSuccess = useStripeSuccess({ eventId, seriesId });

  const buyerFees = $derived(calculateBuyerFees(payment, quantity));

  const priceLabel = $derived(
    payment
      ? `${CURRENCY_SYMBOLS[payment.currency] || ""}${payment.price}`
      : "",
  );

  // ──────────────────────────────────────────────────────────────
  // Status + purchase state. Synchronous cache init — runs before first
  // render so availability shows immediately. The status is anonymous data
  // (supply counts only) — the server no longer returns per-user fields.
  // ──────────────────────────────────────────────────────────────
  // svelte-ignore state_referenced_locally
  const _statusKey = cacheKey.claimStatus(eventId, seriesId, "anon");
  // svelte-ignore state_referenced_locally
  const _cachedStatus = cacheGet<SeriesClaimStatus>(_statusKey);

  let status = $state<SeriesClaimStatus | null>(_cachedStatus);
  let error = $state<string | null>(null);
  /** Buyer returned from a successful Stripe checkout this session. */
  let claimed = $state(false);

  let showOrderForm = $state(false);
  let formData = $state<Record<string, string>>({});
  /** PECR opt-in. null until the buyer touches it — an untouched box is still a
   *  valid "no" for sending, but it is recorded as an explicit false only once
   *  the form has actually been shown (see claimMarketingConsent below). */
  let marketingConsent = $state<boolean | null>(null);
  /** The form was displayed, so the opt-out WAS offered — that is what PECR
   *  reg. 22 requires. An untouched checkbox therefore records as a refusal,
   *  not as "never asked". */
  const claimMarketingConsent = $derived(
    showOrderForm ? marketingConsent === true : undefined
  );
  /** Whether the order form already includes an email-type field */
  const hasEmailField = $derived(
    !!orderFields?.some((f) => f.type === "email" || f.id === "__email")
  );
  const hasOrderForm = $derived(!!orderFields?.length && !!encryptionKey);

  /** True while we refresh availability when the form opens. */
  let prefetching = $state(false);
  /** Bumped by hover/focus/touchstart on Pay to fire pre-upload immediately. */
  let payHoverTick = $state(0);
  /** Guards the reservation trigger — must be flipped by an explicit user
   *  gesture (or the `eager` prop) so every ClaimButton on the page doesn't
   *  reserve a slot on mount. */
  // svelte-ignore state_referenced_locally
  let intentToCheckout = $state(eager);

  const formValid = $derived(() => {
    if (!orderFields?.length) return true;
    return orderFields.every((f) =>
      !f.required || (formData[f.id] ?? "").trim().length > 0
    );
  });

  const getEmailFromForm = (): string | null =>
    getEmailFromFormPure(formData, orderFields, "");

  function applyStatus(s: SeriesClaimStatus) {
    status = s;
  }

  function refreshStatus(): void {
    getClaimStatus(eventId, seriesId, undefined, undefined, apiUrl)
      .then((fresh) => {
        if (!fresh) return;
        cacheSet(_statusKey, fresh, TTL.CLAIM_STATUS);
        applyStatus(fresh);
      })
      .catch(() => { /* background fetch — cached data stays shown */ });
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
      stripeSuccess.consumeReturnHash();
    }
    refreshStatus();
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
    if (claimed) return;
    prefetching = true;
    getClaimStatus(eventId, seriesId, undefined, undefined, apiUrl)
      .then((fresh) => {
        if (!fresh) return;
        cacheSet(_statusKey, fresh, TTL.CLAIM_STATUS);
        applyStatus(fresh);
      })
      .catch(() => { /* background fetch — silently ignore */ })
      .finally(() => { prefetching = false; });
  });

  // ──────────────────────────────────────────────────────────────
  // Pre-upload + reservation hooks
  // ──────────────────────────────────────────────────────────────
  const buildOrderSnapshot = (): string => buildOrderSnapshotPure(
    formData,
    getEmailFromForm() ?? stripeEmail.trim(),
    auth.parent?.toLowerCase() ?? "",
  );

  // svelte-ignore state_referenced_locally
  const orderPrefetch = useOrderPrefetch({
    seriesId,
    encryptionKey,
    getShouldPrefetch: () => showOrderForm && !!encryptionKey && formValid(),
    getSnapshot: () => buildOrderSnapshot(),
    getFormData: () => formData,
    getEmail: () => getEmailFromForm() ?? stripeEmail.trim(),
    getAddress: () => auth.parent?.toLowerCase() ?? "",
    getQuantity: () => quantity,
    getPayHoverTick: () => payHoverTick,
  });

  /**
   * Server-side seat hold — fires whenever a paid-event buyer is actively in
   * the checkout flow. Abuse is bounded by clientKey dedup (one hold per
   * browser per series), per-IP cap, 10-min TTL.
   */
  // svelte-ignore state_referenced_locally
  const reservationHook = useReservation({
    eventId,
    seriesId,
    getQuantity: () => quantity,
    getShouldHold: () => {
      const alreadyDone = claimed || stripeSuccess.visible;
      return isPaid && !alreadyDone && quantity >= 1 && (
        // Order form open — explicit user action opened it
        showOrderForm ||
        // Fee sheet visible + the buyer has clicked a payment button (or the
        // parent pre-armed via `eager`).
        (intentToCheckout && hasStripe)
      );
    },
  });

  // Note: we deliberately do NOT release the reservation on pagehide or
  // component unmount. The 10-min TTL is the buyer's window; closing the
  // tab and reopening should resume the SAME hold with the SAME deadline.
  // Releasing on unload would let a buyer extend their lock indefinitely by
  // closing+reopening the page.

  /** sessionStorage key for stashing purchase context across Stripe redirect */
  // svelte-ignore state_referenced_locally
  const STRIPE_FORM_KEY = `woco:stripe-form:${eventId}:${seriesId}`;

  async function handleStripeCheckout() {
    intentToCheckout = true;
    // If there's an order form and it hasn't been shown yet, show it first
    if (hasOrderForm && !showOrderForm) {
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
      // path: the prefetch hook already did this while the user was typing and
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
        // The form is still displayed at this point (handleStripeCheckout returns
        // early to show it and is re-entered), so the opt-out WAS offered and an
        // untouched box records as a refusal.
        marketingConsent: claimMarketingConsent,
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
      error = err instanceof Error ? err.message : "Failed to start checkout";
    } finally {
      stripeLoading = false;
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
      surface the purchase in a subtle chip above it.
    -->
    <div class="own-chip" role="status">
      <span class="own-chip-dot" aria-hidden="true">&#10003;</span>
      <span class="own-chip-text">You own this ticket</span>
      <span class="own-chip-hint">Buy another below</span>
    </div>
  {/if}
  {#if showOrderForm}
    <OrderForm
      {status}
      {quantity}
      {orderFields}
      {hasEmailField}
      authConnected={auth.isConnected}
      {stripeLoading}
      {buyerFees}
      {priceLabel}
      payPreparing={orderPrefetch.uploading && !orderPrefetch.ref}
      {formValid}
      bind:formData
      bind:stripeEmail
      bind:marketingConsent
      {organiserName}
      onStripeCheckout={handleStripeCheckout}
      onPayHover={() => { payHoverTick++; }}
      onCancel={() => { showOrderForm = false; }}
    />
  {:else if isPaid && hasStripe}
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
    <!-- No live purchase rail for this series (free events and the crypto
         rail need a v2 mint path — see features.ts). -->
    <button class="claim-btn" disabled>Not currently available</button>
  {/if}

  {#if error}
    <p class="error">{error}</p>
  {/if}
</div>

<!--
  Stripe email-success modal — shown immediately on return from Stripe.
  Email is the hero; no QR/edition (webhook still writing on-chain).
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

  .claim-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
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
</style>
