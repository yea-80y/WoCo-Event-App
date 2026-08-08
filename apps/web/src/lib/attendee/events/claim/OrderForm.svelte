<script lang="ts">
  import type { OrderField, SeriesClaimStatus } from "@woco/shared";
  import {
    MARKETING_CONSENT_NOTICE,
    TRANSACTIONAL_EMAIL_NOTICE,
    CHECKOUT_PRIVACY_SUMMARY,
  } from "@woco/shared";
  import type { BuyerFees } from "./fees.js";

  // Stripe-only: the form collects the organiser's order fields (+ a buyer
  // email when needed) ahead of the checkout redirect. The direct wallet/email
  // claim buttons went with the v1 claim rail.
  interface Props {
    status: SeriesClaimStatus | null;
    quantity: number;
    orderFields?: OrderField[];
    hasEmailField: boolean;
    authConnected: boolean;
    stripeLoading: boolean;
    buyerFees: BuyerFees | null;
    priceLabel: string;
    /** Pay button shows shimmer while the order-ref pre-upload is in flight. */
    payPreparing: boolean;
    /** Closure over orderFields + formData. Recomputed on each call. */
    formValid: () => boolean;
    formData: Record<string, string>;
    stripeEmail: string;
    /** Organiser display name — the consent must name who is being consented to. */
    organiserName?: string;
    /** Tri-state, bound upward: null = never asked. Starts unticked; a pre-ticked
     *  box is not valid consent (UK GDPR Recital 32). */
    marketingConsent: boolean | null;
    onStripeCheckout: () => void;
    onPayHover: () => void;
    onCancel: () => void;
  }

  let {
    status,
    quantity,
    orderFields,
    hasEmailField,
    authConnected,
    stripeLoading,
    buyerFees,
    priceLabel,
    payPreparing,
    formValid,
    formData = $bindable(),
    stripeEmail = $bindable(),
    organiserName,
    marketingConsent = $bindable(),
    onStripeCheckout,
    onPayHover,
    onCancel,
  }: Props = $props();
</script>

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
        Not enough tickets available — please reduce quantity to continue
      </span>
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

  {#if !hasEmailField && !authConnected}
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

  <!-- Notice + consent sit ABOVE the action buttons: both must be visible
       before submission, not after it. -->
  <div class="consent-block">
    <p class="transactional-note">{TRANSACTIONAL_EMAIL_NOTICE}</p>

    <label class="consent-row">
      <input
        type="checkbox"
        checked={marketingConsent === true}
        onchange={(e) => (marketingConsent = (e.target as HTMLInputElement).checked)}
      />
      <span>{MARKETING_CONSENT_NOTICE}</span>
    </label>

    <p class="privacy-note">
      {#if organiserName}
        Your details go to <strong>{organiserName}</strong>, who is responsible for them.
        {CHECKOUT_PRIVACY_SUMMARY.slice(CHECKOUT_PRIVACY_SUMMARY.indexOf("Anything you enter"))}
      {:else}
        {CHECKOUT_PRIVACY_SUMMARY}
      {/if}
      <a href="#/legal/privacy" target="_blank" rel="noopener">Privacy Policy</a>
    </p>
  </div>

  <div class="form-actions">
    {#if stripeLoading}
      <button class="stripe-btn stripe-btn--primary" disabled>Redirecting to Stripe…</button>
    {:else if status && status.available <= 0}
      <button class="stripe-btn stripe-btn--primary" disabled>Sold out</button>
    {:else if status && status.available < quantity}
      <button class="stripe-btn stripe-btn--primary" disabled>Not enough tickets</button>
    {:else}
      <button
        class="stripe-btn stripe-btn--primary"
        class:preparing={payPreparing}
        onclick={onStripeCheckout}
        onpointerenter={onPayHover}
        onpointerdown={onPayHover}
        onmousedown={onPayHover}
        onfocus={onPayHover}
        ontouchstart={onPayHover}
        disabled={!formValid()}
      >
        Continue to payment {buyerFees?.cardTotal ? `— ${buyerFees.cardTotal}` : `— ${priceLabel}`}
      </button>
    {/if}
    <button class="cancel-btn" onclick={onCancel}>Cancel</button>
  </div>
</div>

<style>
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

  .consent-block {
    display: flex;
    flex-direction: column;
    gap: 0.4375rem;
    padding: 0.625rem 0.75rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .transactional-note {
    font-size: 0.6875rem;
    color: var(--text-secondary);
    margin: 0;
  }

  .consent-row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    cursor: pointer;
    font-size: 0.75rem;
    line-height: 1.45;
    color: var(--text);
  }

  .consent-row input[type="checkbox"] {
    width: 0.875rem;
    height: 0.875rem;
    margin-top: 0.125rem;
    flex-shrink: 0;
    accent-color: var(--accent);
  }

  .privacy-note {
    font-size: 0.6875rem;
    line-height: 1.5;
    color: var(--text-muted);
    margin: 0;
    padding-top: 0.375rem;
    border-top: 1px solid var(--border);
  }

  .privacy-note a {
    color: var(--accent-text);
    text-decoration: underline;
  }

  .stripe-btn {
    width: 100%;
    padding: 0.625rem 1rem;
    font-size: 0.8125rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: #fff;
    white-space: nowrap;
    transition: background 0.2s ease, opacity 0.2s ease;
  }

  .stripe-btn--primary {
    padding: 0.75rem 1rem;
    font-size: 0.875rem;
    border-radius: var(--radius-md);
    background: var(--accent);
    box-shadow: 0 2px 12px -2px color-mix(in srgb, var(--accent) 30%, transparent);
  }

  .stripe-btn--primary:hover:not(:disabled) {
    background: var(--accent-hover);
    box-shadow: 0 4px 16px -2px color-mix(in srgb, var(--accent) 40%, transparent);
  }

  .stripe-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .stripe-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Availability banners — only used inside the order form. */
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

  /* Pay-button shimmer while the order-ref pre-upload is in flight. */
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
</style>
