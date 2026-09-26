<script lang="ts">
  /**
   * Refund progress for a cancelled event (#644), at the top of the dashboard.
   * Counts and totals only — the server holds no buyer data in this view. Polls
   * until every refund is settled; the refunds themselves run server-side
   * whether or not this is open.
   */
  import { onDestroy } from "svelte";
  import { getCancellation, type CancellationProgress } from "../../api/events.js";

  interface Props {
    eventId: string;
    cancelledAt: string;
    onnotify: () => void;
  }

  let { eventId, cancelledAt, onnotify }: Props = $props();

  const POLL_MS = 30_000;
  let progress = $state<CancellationProgress | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function refresh(): Promise<void> {
    try {
      progress = await getCancellation(eventId);
    } catch {
      // Keep the last reading; the next poll tries again.
    }
    if (!progress?.settled) timer = setTimeout(() => void refresh(), POLL_MS);
  }
  void refresh();
  onDestroy(() => {
    if (timer) clearTimeout(timer);
  });

  function money(minor: number, currency: string): string {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(minor / 100);
    } catch {
      return `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`;
    }
  }
</script>

<div class="cancelled">
  <div class="head">
    <strong>Event cancelled</strong>
    <span class="when">{new Date(cancelledAt).toLocaleString()}</span>
  </div>

  {#if progress?.cancelled && progress.sales !== undefined}
    {#if progress.sales === 0}
      <p>No tickets were sold, so there is nothing to refund.</p>
    {:else}
      <p class="line">
        Refunds: <strong>{progress.done} of {progress.sales}</strong> complete
        {#each Object.entries(progress.totals ?? {}) as [currency, t] (currency)}
          <span class="money"> - {money(t.refunded, currency)} of {money(t.charged, currency)}</span>
        {/each}
      </p>
      {#if progress.waitingForFunds}
        <p class="alert">
          {progress.waitingForFunds} refund(s) are waiting for funds in your Stripe balance. Add funds in your
          <a href="https://dashboard.stripe.com" target="_blank" rel="noopener noreferrer">Stripe Dashboard</a>
          and they go through automatically.
        </p>
      {/if}
      {#if progress.waitingForBuyer}
        <p>{progress.waitingForBuyer} refund(s) are waiting on the buyer's bank.</p>
      {/if}
      {#if progress.disputed}
        <p>{progress.disputed} buyer(s) opened a dispute with their bank - those are settled through the dispute.</p>
      {/if}
      {#if progress.needsAttention}
        <p class="alert">{progress.needsAttention} refund(s) could not be completed. We have been alerted and will sort them.</p>
      {/if}
      {#if progress.settled}
        <p class="ok">Every buyer has been refunded.</p>
      {:else if progress.inProgress}
        <p>{progress.inProgress} refund(s) in progress.</p>
      {/if}
    {/if}
  {:else}
    <p>Loading refund progress…</p>
  {/if}

  <button class="notify-btn" onclick={onnotify}>Tell your attendees</button>
</div>

<style>
  .cancelled {
    border: 1px solid var(--error);
    background: var(--error-subtle);
    border-radius: var(--radius-md);
    padding: 1rem 1.25rem;
    margin: 0.75rem 0 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    font-size: 0.875rem;
    color: var(--text-secondary);
  }
  .cancelled p {
    margin: 0;
    line-height: 1.45;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .head strong {
    color: var(--error);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 0.8125rem;
  }
  .when {
    font-size: 0.8125rem;
    color: var(--text-muted);
  }
  .line strong {
    color: var(--text);
  }
  .money {
    color: var(--text-muted);
  }
  .alert {
    color: var(--warning);
  }
  .alert a {
    color: inherit;
    text-decoration: underline;
  }
  .ok {
    color: var(--success);
  }
  .notify-btn {
    align-self: flex-start;
    margin-top: 0.4rem;
    padding: 0.5rem 1.125rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border-hover);
    color: var(--text);
    border-radius: var(--radius-md);
    font-size: 0.8125rem;
    font-weight: 600;
    cursor: pointer;
  }
</style>
