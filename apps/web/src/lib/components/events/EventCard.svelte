<script lang="ts">
  import type { EventDirectoryEntry } from "@woco/shared";

  interface Props {
    event: EventDirectoryEntry;
    onclick?: () => void;
  }

  let { event, onclick }: Props = $props();

  const BEE_GATEWAY = "https://gateway.woco-net.com";

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="card" role="button" tabindex="0" onclick={onclick}>
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
    <span class="date">{formatDate(event.startDate)}</span>
    <h3>{event.title}</h3>
    {#if event.location}
      <p class="location">{event.location}</p>
    {/if}
    <p class="tickets">{event.totalTickets} tickets</p>
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

  .tickets {
    margin: 0.375rem 0 0;
    color: var(--text-muted);
    font-size: 0.75rem;
  }
</style>
