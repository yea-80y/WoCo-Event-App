<script lang="ts">
  import type { ClaimedTicket } from "@woco/shared";
  import { navigate } from "../../router/router.svelte.js";

  interface Props {
    ticket: ClaimedTicket;
  }

  let { ticket }: Props = $props();

  const BEE_GATEWAY = "https://gateway.woco-net.com";

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="ticket-card"
  role="button"
  tabindex="0"
  onclick={() => navigate(`/event/${ticket.eventId}`)}
>
  {#if ticket.imageHash}
    <img
      src="{BEE_GATEWAY}/bytes/{ticket.imageHash}"
      alt={ticket.seriesName}
      class="ticket-image"
    />
  {:else}
    <div class="ticket-image placeholder"></div>
  {/if}

  <div class="ticket-body">
    <span class="series-name">{ticket.seriesName}</span>
    <p class="edition">#{ticket.edition} of {ticket.totalSupply}</p>
    <p class="claimed-date">Claimed {formatDate(ticket.claimedAt)}</p>
  </div>

  <div class="ticket-stub">
    <span class="check">&#10003;</span>
  </div>
</div>

<style>
  .ticket-card {
    display: flex;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    cursor: pointer;
    transition: border-color var(--transition), transform var(--transition);
    background: var(--bg-surface);
  }

  .ticket-card:hover {
    border-color: var(--border-hover);
    transform: translateY(-1px);
  }

  .ticket-image {
    width: 100px;
    height: 100px;
    object-fit: cover;
    flex-shrink: 0;
  }

  .placeholder {
    background: linear-gradient(135deg, var(--bg-surface-hover), var(--bg-elevated));
  }

  .ticket-body {
    flex: 1;
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-width: 0;
  }

  .series-name {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .edition {
    margin: 0.25rem 0 0;
    font-size: 0.8125rem;
    color: var(--accent-text);
    font-weight: 500;
  }

  .claimed-date {
    margin: 0.25rem 0 0;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .ticket-stub {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    flex-shrink: 0;
    border-left: 2px dashed var(--border);
    color: var(--success);
    font-size: 1.125rem;
  }
</style>
