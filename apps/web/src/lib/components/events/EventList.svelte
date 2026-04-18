<script lang="ts">
  import type { EventDirectoryEntry, UserCollection } from "@woco/shared";
  import { listEvents, getMyCollection } from "../../api/events.js";
  import EventCard from "./EventCard.svelte";
  import { cacheGet, cacheSet, cacheKey, TTL } from "../../cache/cache.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { onMount, onDestroy } from "svelte";
  import {
    startEventStream,
    stopEventStream,
    mergeWithLive,
    clearLiveEvents,
  } from "../../waku/discovery.svelte.js";

  interface Props {
    onselect?: (eventId: string) => void;
  }

  let { onselect }: Props = $props();

  const _KEY = cacheKey.directory();
  const _cached = cacheGet<EventDirectoryEntry[]>(_KEY);

  let fetchedEvents = $state<EventDirectoryEntry[]>(_cached ?? []);
  let loading = $state(_cached === null);
  let error = $state<string | null>(null);

  // Owned events lookup — populated from user's collection (wallet-claimed tickets only)
  // Read from collection cache synchronously for instant badge render on first paint.
  const _addr = auth.parent?.toLowerCase();
  const _cachedCollection = _addr ? cacheGet<UserCollection>(cacheKey.collection(_addr)) : null;
  let ownedEventIds = $state<Set<string>>(
    new Set(_cachedCollection?.entries.map((e) => e.eventId) ?? []),
  );

  let events = $derived(mergeWithLive(fetchedEvents));

  onMount(() => {
    listEvents()
      .then((fresh) => {
        cacheSet(_KEY, fresh, TTL.EVENT);
        fetchedEvents = fresh;
        clearLiveEvents();
        loading = false;
        error = null;
      })
      .catch((e) => {
        if (_cached === null) {
          error = e instanceof Error ? e.message : "Failed to load events";
          loading = false;
        }
      });

    // Refresh owned-tickets set in background (only if signed in with wallet identity).
    // Failure is silent — badges fall back to whatever was in cache.
    if (auth.isConnected && auth.parent) {
      getMyCollection()
        .then((collection) => {
          const addr = auth.parent!.toLowerCase();
          cacheSet(cacheKey.collection(addr), collection, TTL.COLLECTION);
          ownedEventIds = new Set(collection.entries.map((e) => e.eventId));
        })
        .catch(() => {/* non-critical */});
    }

    startEventStream();
  });

  onDestroy(() => {
    stopEventStream();
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
      {#each events as event (event.eventId)}
        <EventCard {event} owned={ownedEventIds.has(event.eventId)} onclick={() => onselect?.(event.eventId)} />
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
