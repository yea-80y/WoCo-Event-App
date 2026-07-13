<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import StripeConnect from "../../creator/dashboard/StripeConnect.svelte";
</script>

<div class="wallet-tab">
  <!-- Identity row -->
  <section class="identity-card">
    <div class="identity-row">
      <span class="identity-label">Account type</span>
      <span class="identity-value">
        {#if auth.kind === "web3"}Web3 Wallet
        {:else if auth.kind === "web3auth"}Email / Social Login
        {:else if auth.kind === "coinbase"}Coinbase Smart Wallet
        {:else if auth.kind === "passkey"}Passkey
        {:else}Not connected{/if}
      </span>
    </div>
    {#if auth.parent}
      <div class="identity-row">
        <span class="identity-label">Address</span>
        <span class="identity-value identity-mono" title={auth.parent}>
          {auth.parent.slice(0, 6)}…{auth.parent.slice(-4)}
        </span>
      </div>
    {/if}
  </section>

  <!-- Stripe — shown to all auth'd users; StripeConnect handles not-yet-connected gracefully -->
  {#if auth.isConnected}
    <section class="stripe-section">
      <h3 class="section-title">Card Payments</h3>
      <p class="section-hint">
        Connect Stripe to accept card payments for your events. Payouts go straight to your Stripe balance.
      </p>
      <StripeConnect />
    </section>
  {/if}
</div>

<style>
  .wallet-tab {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding-top: 0.5rem;
  }

  .identity-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1rem 1.25rem;
    background: var(--bg-surface);
    display: flex;
    flex-direction: column;
  }

  .identity-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border);
  }

  .identity-row:last-child {
    border-bottom: none;
  }

  .identity-label {
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }

  .identity-value {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text);
  }

  .identity-mono {
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.75rem;
  }

  .stripe-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .section-title {
    margin: 0;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .section-hint {
    margin: 0 0 0.25rem;
    font-size: 0.8125rem;
    color: var(--text-muted);
    line-height: 1.5;
  }
</style>
