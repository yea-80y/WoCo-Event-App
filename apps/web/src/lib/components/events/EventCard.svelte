<script lang="ts">
  import type { EventDirectoryEntry } from "@woco/shared";
  import CreatorChip from "../profile/CreatorChip.svelte";

  interface Props {
    event: EventDirectoryEntry;
    /** Whether the current user owns a ticket for this event */
    owned?: boolean;
    onclick?: () => void;
  }

  let { event, owned = false, onclick }: Props = $props();

  const BEE_GATEWAY = import.meta.env.VITE_GATEWAY_URL || "https://gateway.woco-net.com";

  function handleClick() {
    onclick?.();
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="card" role="button" tabindex="0" onclick={handleClick} class:has-ext={!!event.apiUrl}>
  {#if event.imageHash}
    <img
      src="{BEE_GATEWAY}/bytes/{event.imageHash}"
      alt={event.title}
      class="card-image"
    />
  {:else}
    <div class="card-image placeholder"></div>
  {/if}
  <div class="card-body">
    <div class="card-title-row">
      <span class="date">{formatDate(event.startDate)}</span>
      <div class="card-badges">
        {#if owned}
          <span class="owned-badge" title="You have a ticket">&#10003; Ticket</span>
        {/if}
        {#if event.apiUrl}
          <span class="site-badge" title="Self-hosted event">&#9670;</span>
        {/if}
      </div>
    </div>
    <h3>{event.title}</h3>
    {#if event.location}
      <p class="location">{event.location}</p>
    {/if}
    <div class="card-footer">
      <CreatorChip address={event.creatorAddress} compact={false} />
      <span class="tickets">{event.totalTickets} tickets</span>
    </div>
  </div>
</div>

<style>
  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    cursor: pointer;
    transition: border-color var(--transition), transform var(--transition);
    background: var(--bg-surface);
  }

  .card:hover {
    border-color: var(--border-hover);
    transform: translateY(-2px);
  }

  .card-image {
    width: 100%;
    height: 160px;
    object-fit: cover;
  }

  .placeholder {
    background: linear-gradient(135deg, var(--bg-surface-hover), var(--bg-elevated));
  }

  .card-body {
    padding: 0.875rem 1rem;
  }

  .date {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--accent-text);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  h3 {
    margin: 0.25rem 0 0.375rem;
    color: var(--text);
    font-size: 1rem;
    font-weight: 600;
    line-height: 1.3;
  }

  .location {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.8125rem;
  }

  .card-title-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .card-badges {
    display: flex;
    gap: 0.375rem;
    align-items: center;
  }

  .owned-badge {
    font-size: 0.625rem;
    font-weight: 600;
    color: var(--accent-text, #22c55e);
    background: color-mix(in srgb, var(--accent-text, #22c55e) 12%, transparent);
    padding: 0.125rem 0.4375rem;
    border-radius: 9999px;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }

  .card-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border);
    gap: 0.5rem;
    min-width: 0;
  }

  .tickets {
    color: var(--text-muted);
    font-size: 0.6875rem;
    white-space: nowrap;
    flex-shrink: 0;
  }
</style>
