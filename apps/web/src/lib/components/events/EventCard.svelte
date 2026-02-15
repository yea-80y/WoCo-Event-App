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
      year: "numeric",
    });
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="event-card" role="button" tabindex="0" onclick={onclick}>
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
    <h3>{event.title}</h3>
    <p class="meta">
      <span>{formatDate(event.startDate)}</span>
      {#if event.location}
        <span>&middot; {event.location}</span>
      {/if}
    </p>
    <p class="tickets">{event.totalTickets} tickets &middot; {event.seriesCount} series</p>
  </div>
</div>

<style>
  .event-card {
    border: 1px solid #2a2a4a;
    border-radius: 10px;
    overflow: hidden;
    cursor: pointer;
    transition: border-color 0.15s;
  }

  .event-card:hover {
    border-color: #4f46e5;
  }

  .card-image {
    width: 100%;
    height: 140px;
    object-fit: cover;
  }

  .placeholder {
    background: #1a1a2e;
  }

  .card-body {
    padding: 0.75rem;
  }

  h3 {
    margin: 0 0 0.25rem;
    color: #e2e8f0;
    font-size: 1rem;
  }

  .meta {
    margin: 0;
    color: #9ca3af;
    font-size: 0.8125rem;
  }

  .meta span + span {
    margin-left: 0.25rem;
  }

  .tickets {
    margin: 0.25rem 0 0;
    color: #6b7280;
    font-size: 0.75rem;
  }
</style>
