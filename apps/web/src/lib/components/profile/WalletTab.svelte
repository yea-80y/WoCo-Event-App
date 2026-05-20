<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import { get } from "../../api/client.js";
  import { onMount } from "svelte";
  import StripeConnect from "../../creator/dashboard/StripeConnect.svelte";

  const authKindLabel: Record<string, string> = {
    web3: "Web3 Wallet",
    para: "Para Wallet",
    passkey: "Passkey",
    local: "Browser Account",
  };

  let isOrganiser = $state(false);

  onMount(async () => {
    if (!auth.parent) return;
    try {
      const resp = await get<Array<{ creatorAddress: string }>>("/api/events");
      if (resp.ok && resp.data) {
        isOrganiser = resp.data.some(
          (e) => e.creatorAddress.toLowerCase() === auth.parent?.toLowerCase(),
        );
      }
    } catch { /* silent — not load-bearing */ }
  });

  function truncate(addr: string): string {
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  }
</script>

<div class="wallet-tab">
  <!-- Identity card -->
  <section class="identity-card">
    <div class="identity-row">
      <span class="identity-label">Account type</span>
      <span class="identity-value">{authKindLabel[auth.kind ?? ""] ?? "Not connected"}</span>
    </div>
    {#if auth.parent}
      <div class="identity-row">
        <span class="identity-label">Address</span>
        <span class="identity-value identity-mono" title={auth.parent}>{truncate(auth.parent)}</span>
      </div>
    {/if}
  </section>

  <!-- Stripe section — only for users who have created events.
       Stripe's "Connect" CTA can otherwise confuse attendees who never need it. -->
  {#if isOrganiser}
    <section class="stripe-section">
      <h3 class="section-title">Card Payments</h3>
      <p class="section-hint">
        Connect Stripe so attendees can pay for tickets by card. Payouts go straight to your Stripe balance.
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
    gap: 0.25rem;
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
