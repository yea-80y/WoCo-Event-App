<script lang="ts">
  import { formatCountdown, type ReservationData } from "../../../api/reservations.js";

  interface Props {
    reservation: ReservationData | null;
    secsLeft: number | null;
    expired: boolean;
    error: string | null;
    onretry: () => void;
  }

  let { reservation, secsLeft, expired, error, onretry }: Props = $props();
</script>

<!--
  Reservation status — shown above every buy-state so the buyer sees their
  hold both in the pre-form fees view (after Get-tickets click on email/
  Stripe-only events) and once the order form is open.
-->
{#if reservation && secsLeft !== null}
  <div class="avail-pill avail-pill--reserved" aria-live="polite">
    <span class="avail-pill-dot"></span>
    {reservation.quantity} ticket{reservation.quantity === 1 ? "" : "s"} reserved · {formatCountdown(secsLeft)} to checkout
  </div>
{:else if expired}
  <div class="avail-banner avail-banner--expired" role="alert">
    <span class="avail-banner-dot"></span>
    <span class="avail-banner-text">Your hold has expired — change quantity or <button class="retry-link" onclick={onretry}>try again</button>.</span>
  </div>
{:else if error}
  <div class="avail-banner avail-banner--shortfall" role="alert">
    <span class="avail-banner-dot"></span>
    <span class="avail-banner-text">{error}</span>
  </div>
{/if}

<style>
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

  /* Reserved variant: same shape, neutral palette + steady pulse on the dot
     so the user reads it as a live timer rather than a warning. */
  .avail-pill--reserved {
    color: var(--text-secondary, #c9c9d1);
    background: color-mix(in srgb, var(--text-secondary, #c9c9d1) 8%, transparent);
    border-color: color-mix(in srgb, var(--text-secondary, #c9c9d1) 18%, transparent);
  }
  .avail-pill--reserved .avail-pill-dot {
    background: #10b981;
    box-shadow: 0 0 6px rgba(16, 185, 129, 0.55);
    animation: avail-pill-pulse 1.6s ease-in-out infinite;
  }
  @keyframes avail-pill-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }

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
  .avail-banner--shortfall {
    color: #fcd34d;
    background: color-mix(in srgb, #f59e0b 12%, transparent);
    border: 1px solid color-mix(in srgb, #f59e0b 30%, transparent);
  }
  .avail-banner--shortfall .avail-banner-dot {
    background: #f59e0b;
    box-shadow: 0 0 8px rgba(245, 158, 11, 0.55);
  }
  .avail-banner--expired {
    color: #fcd34d;
    background: color-mix(in srgb, #f59e0b 12%, transparent);
    border: 1px solid color-mix(in srgb, #f59e0b 30%, transparent);
  }
  .avail-banner--expired .avail-banner-dot {
    background: #f59e0b;
    box-shadow: 0 0 8px rgba(245, 158, 11, 0.55);
  }
  .retry-link {
    background: none;
    border: none;
    padding: 0;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
  }
  @keyframes avail-banner-in {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }
</style>
