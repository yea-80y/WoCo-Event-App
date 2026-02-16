<script lang="ts">
  import type { EventDirectoryEntry } from "@woco/shared";
  import { listEvents } from "../../api/events.js";
  import EventCard from "./EventCard.svelte";
  import { onMount } from "svelte";

  interface Props {
    onselect?: (eventId: string) => void;
  }

  let { onselect }: Props = $props();

  let events = $state<EventDirectoryEntry[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      events = await listEvents();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load events";
    } finally {
      loading = false;
    }
  });
</script>

<div class="event-list">
  {#if loading}
    <p class="status">Loading events...</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if events.length === 0}
    <div class="empty">
      <p>No events yet</p>
      <p class="sub">Be the first to create one.</p>
    </div>
  {:else}
    <div class="grid">
      {#each events as event}
        <EventCard {event} onclick={() => onselect?.(event.eventId)} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .event-list {
    width: 100%;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 1.25rem;
  }

  .status {
    text-align: center;
    color: var(--text-muted);
    padding: 3rem 0;
  }

  .empty {
    text-align: center;
    padding: 4rem 0;
  }

  .empty p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 1rem;
  }

  .empty .sub {
    color: var(--text-muted);
    font-size: 0.875rem;
    margin-top: 0.25rem;
  }

  .error {
    text-align: center;
    color: var(--error);
    padding: 3rem 0;
  }
</style>
