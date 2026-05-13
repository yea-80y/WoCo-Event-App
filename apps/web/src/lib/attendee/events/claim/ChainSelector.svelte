<script lang="ts">
  import type { PaymentConfig, PaymentChainId } from "@woco/shared";
  import { CHAIN_NAMES, USDC_ADDRESSES } from "@woco/shared";
  import { CHAIN_COLORS } from "./helpers.js";
  import type { BuyerFees } from "./fees.js";

  interface Props {
    payment: PaymentConfig;
    buyerFees: BuyerFees | null;
    priceLabel: string;
    ethEquivalent: string | null;
    ethPriceLoading: boolean;
    selectedChain: PaymentChainId | null;
    selectedPayMethod: "ETH" | "USDC";
    usdcAvailableOnChain: boolean;
    claiming: boolean;
    step: string;
    authKind: string | null;
    hasStripe: boolean;
    stripeLoading: boolean;
    stripeEmail: string;
    showEmailInput: boolean;
    onSelectChain: (id: PaymentChainId) => void;
    onSelectPayMethod: (m: "ETH" | "USDC") => void;
    onPay: () => void;
    onCancel: () => void;
    onStripeCheckout: () => void;
    onStripeEmailChange: (v: string) => void;
  }

  let {
    payment,
    buyerFees,
    priceLabel,
    ethEquivalent,
    ethPriceLoading,
    selectedChain,
    selectedPayMethod,
    usdcAvailableOnChain,
    claiming,
    step,
    authKind,
    hasStripe,
    stripeLoading,
    stripeEmail,
    showEmailInput,
    onSelectChain,
    onSelectPayMethod,
    onPay,
    onCancel,
    onStripeCheckout,
    onStripeEmailChange,
  }: Props = $props();
</script>

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
        onclick={() => onSelectPayMethod("ETH")}
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
        onclick={() => onSelectPayMethod("USDC")}
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
          onclick={() => onSelectChain(chainId)}
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
        onclick={onPay}
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
    <button class="pay-cancel" onclick={onCancel}>Cancel</button>
  </div>

  {#if authKind === "local"}
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
      onclick={onStripeCheckout}
    >
      {#if stripeLoading}
        Redirecting to Stripe...
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

  /* Stripe fallback divider (shared with parent — Svelte scopes, duplicate kept here) */
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

  /* Buyer fee receipt (shared with parent — duplicate kept here) */
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

  /* Stripe button (non-primary variant — shared with parent) */
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

  .stripe-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .stripe-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
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
