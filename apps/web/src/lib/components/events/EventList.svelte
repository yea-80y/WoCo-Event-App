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
    <p class="status">No events yet. Be the first to create one!</p>
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
    gap: 1rem;
  }

  .status {
    text-align: center;
    color: #6b7280;
    padding: 2rem 0;
  }

  .error {
    text-align: center;
    color: #ef4444;
    padding: 2rem 0;
  }
</style>
