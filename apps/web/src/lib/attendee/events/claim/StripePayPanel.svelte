<script lang="ts">
  import type { BuyerFees } from "./fees.js";

  interface Props {
    buyerFees: BuyerFees | null;
    priceLabel: string;
    stripeLoading: boolean;
    soldOut: boolean;
    stripeEmail: string;
    showEmailInput: boolean;
    onCheckout: () => void;
    onStripeEmailChange: (v: string) => void;
    /** When set, renders the "or — Pay with crypto" footer link. */
    cryptoFooter?: {
      label: string;
      onclick: () => void;
    } | null;
  }

  let {
    buyerFees,
    priceLabel,
    stripeLoading,
    soldOut,
    stripeEmail,
    showEmailInput,
    onCheckout,
    onStripeEmailChange,
    cryptoFooter = null,
  }: Props = $props();
</script>

<div class="pay-sheet">
  {#if buyerFees}
    <div class="pay-receipt">
      <div class="pay-receipt-row"><span>{buyerFees.baseLabel}</span><span>{buyerFees.base}</span></div>
      <div class="pay-receipt-row pay-receipt-fee"><span>Service fee (10%)</span><span>{buyerFees.fee}</span></div>
      <div class="pay-receipt-row pay-receipt-total"><span>Total</span><span>{buyerFees.cardTotal ?? priceLabel}</span></div>
    </div>
  {/if}

  <button
    class="stripe-btn stripe-btn--primary"
    disabled={stripeLoading || soldOut}
    onclick={onCheckout}
  >
    {#if stripeLoading}
      Redirecting to Stripe...
    {:else if soldOut}
      Sold out
    {:else}
      Pay with card {buyerFees?.cardTotal ? `— ${buyerFees.cardTotal}` : `— ${priceLabel}`}
    {/if}
  </button>
  {#if showEmailInput}
    <input
      class="stripe-email-input"
      type="email"
      placeholder="Email for your ticket"
      value={stripeEmail}
      oninput={(e) => onStripeEmailChange((e.target as HTMLInputElement).value)}
    />
  {/if}

  {#if cryptoFooter}
    <div class="pay-divider">
      <span class="pay-divider-line"></span>
      <span class="pay-divider-text">or</span>
      <span class="pay-divider-line"></span>
    </div>
    <button class="pay-crypto-link" onclick={cryptoFooter.onclick}>
      {cryptoFooter.label}
    </button>
  {/if}
</div>

<style>
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
</style>
