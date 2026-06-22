<script lang="ts">
  import type { EventDirectoryEntry } from "@woco/shared";
  import { isPastEvent } from "../../utils/events.js";
  import CreatorChip from "../../components/profile/CreatorChip.svelte";

  interface Props {
    event: EventDirectoryEntry;
    /** Whether the current user owns a ticket for this event */
    owned?: boolean;
    onclick?: () => void;
  }

  let { event, owned = false, onclick }: Props = $props();

  const BEE_GATEWAY = import.meta.env.VITE_GATEWAY_URL || "https://gateway.woco-net.com";

  const isPast = $derived(isPastEvent(event));

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
<div class="card" role="button" tabindex="0" onclick={handleClick} class:has-ext={!!event.apiUrl} class:is-past={isPast}>
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
        {#if isPast}
          <span class="past-badge">Past</span>
        {/if}
        {#if owned}
          <span class="owned-badge" title="You have a ticket">&#10003; Ticket</span>
        {/if}
        {#if event.apiUrl}
          <span class="site-badge" title="Self-hosted event">ext</span>
        {/if}
      </div>
    </div>
    <h3>{event.title}</h3>
    {#if event.tagline}
      <p class="tagline">{event.tagline}</p>
    {/if}
    {#if event.location}
      <p class="location">{event.location}</p>
    {/if}
    <div class="card-footer">
      <CreatorChip address={event.creatorAddress} compact={false} showFollow signer={event.creatorFeedSigner} />
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
    border-color: var(--accent);
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
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }

  h3 {
    margin: 0.25rem 0 0.375rem;
    color: var(--text);
    font-size: 1rem;
    font-weight: 600;
    line-height: 1.3;
  }

  .tagline {
    margin: 0 0 0.25rem;
    color: var(--text-secondary);
    font-size: 0.8125rem;
    font-weight: 500;
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
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
    font-family: var(--font-mono);
    font-size: 0.625rem;
    font-weight: 600;
    color: var(--accent-text);
    background: var(--accent-subtle);
    padding: 0.125rem 0.4375rem;
    border-radius: var(--radius-sm);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .site-badge {
    font-family: var(--font-mono);
    font-size: 0.5625rem;
    font-weight: 500;
    color: var(--text-dim);
    border: 1px solid var(--border);
    padding: 0.0625rem 0.3125rem;
    border-radius: var(--radius-sm);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .past-badge {
    font-family: var(--font-mono);
    font-size: 0.625rem;
    font-weight: 600;
    color: var(--text-dim);
    background: var(--bg-surface-hover);
    border: 1px solid var(--border);
    padding: 0.125rem 0.4375rem;
    border-radius: var(--radius-sm);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .is-past { opacity: 0.6; }
  .is-past:hover { opacity: 0.85; }

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
