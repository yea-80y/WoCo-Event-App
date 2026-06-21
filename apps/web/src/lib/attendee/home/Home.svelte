<script lang="ts">
  import type { EventDirectoryEntry } from "@woco/shared";
  import { listEvents } from "../../api/events.js";
  import { navigate } from "../../router/router.svelte.js";
  import { setExternalEventApi, setEventFeedSigner } from "../../api/event-api-registry.js";
  import EventCard from "../events/EventCard.svelte";
  import { cacheGet, cacheSet, cacheKey, TTL } from "../../cache/cache.js";
  import { isPastEvent } from "../../utils/events.js";
  import { onMount, onDestroy } from "svelte";

  type Tab = "upcoming" | "past";
  let tab = $state<Tab>("upcoming");

  // Reactive clock — drives past/upcoming split without any server involvement.
  // Ticks every minute; events auto-migrate between tabs when they end.
  let now = $state(Date.now());
  let clockTimer: ReturnType<typeof setInterval>;

  const _KEY = cacheKey.directory();
  const _cached = cacheGet<EventDirectoryEntry[]>(_KEY);

  let allEvents = $state<EventDirectoryEntry[]>(_cached ?? []);
  let loading = $state(_cached === null);

  // Client-side split — single source of truth, no extra network calls
  const upcoming = $derived(
    allEvents.filter(e => !isPastEvent(e, now))
      .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime())
  );
  const past = $derived(
    allEvents.filter(e => isPastEvent(e, now))
      .sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime())
  );

  onMount(() => {
    clockTimer = setInterval(() => { now = Date.now(); }, 60_000);

    listEvents()
      .then((fresh) => {
        cacheSet(_KEY, fresh, TTL.EVENT);
        allEvents = fresh;
        loading = false;
      })
      .catch(() => {
        if (_cached === null) loading = false;
      });
  });

  onDestroy(() => clearInterval(clockTimer));
</script>

<section class="hero">
  <span class="kicker">Discover</span>
  <h1>Find your scene</h1>
  <p class="hero-sub">Independent events, cryptographic tickets, no corporate middleman.</p>
</section>

<div class="tabs">
  <button class="tab" class:active={tab === "upcoming"} onclick={() => tab = "upcoming"}>
    Upcoming
    {#if !loading && upcoming.length > 0}
      <span class="tab-count">{upcoming.length}</span>
    {/if}
  </button>
  <button class="tab" class:active={tab === "past"} onclick={() => tab = "past"}>
    Past
    {#if !loading && past.length > 0}
      <span class="tab-count">{past.length}</span>
    {/if}
  </button>
</div>

<section class="events-section">
  {#if loading}
    <p class="status">Loading events...</p>
  {:else if tab === "upcoming"}
    {#if upcoming.length === 0}
      <div class="empty">
        <p class="empty-head">No upcoming events</p>
        <p class="empty-sub">Check back soon — or <button class="inline-link" onclick={() => navigate("/creator")}>start something yourself</button>.</p>
      </div>
    {:else}
      <div class="event-grid">
        {#each upcoming as event (event.eventId)}
          <EventCard {event} onclick={() => {
            if (event.apiUrl) setExternalEventApi(event.eventId, event.apiUrl);
            setEventFeedSigner(event.eventId, event.creatorFeedSigner);
            navigate(`/event/${event.eventId}`);
          }} />
        {/each}
      </div>
    {/if}
  {:else}
    {#if past.length === 0}
      <div class="empty">
        <p class="empty-head">No past events</p>
      </div>
    {:else}
      <div class="event-grid">
        {#each past as event (event.eventId)}
          <EventCard {event} onclick={() => {
            if (event.apiUrl) setExternalEventApi(event.eventId, event.apiUrl);
            setEventFeedSigner(event.eventId, event.creatorFeedSigner);
            navigate(`/event/${event.eventId}`);
          }} />
        {/each}
      </div>
    {/if}
  {/if}
</section>

<style>
  .hero {
    padding: 2.5rem 0 2rem;
    border-bottom: 1px solid var(--border);
    margin-bottom: 1.5rem;
  }

  .hero h1 {
    margin: 0.5rem 0 0.625rem;
    font-size: clamp(2rem, 5vw, 3rem);
  }

  .hero-sub {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.9375rem;
    line-height: 1.6;
    max-width: 420px;
  }

  .tabs {
    display: flex;
    border-bottom: 1px solid var(--border);
    margin-bottom: 1.5rem;
  }

  .tab {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.625rem 1.25rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: all var(--transition);
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .tab:hover { color: var(--text); }
  .tab.active { color: var(--accent-text); border-bottom-color: var(--accent); }

  .tab-count {
    font-size: 0.625rem;
    font-weight: 700;
    padding: 0.0625rem 0.375rem;
    border-radius: var(--radius-sm);
    background: var(--accent-subtle);
    color: var(--accent-text);
    font-variant-numeric: tabular-nums;
  }

  .events-section { padding-bottom: 3rem; }

  .event-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 1rem;
  }

  .status {
    text-align: center;
    color: var(--text-muted);
    padding: 3rem 0;
    font-size: 0.875rem;
  }

  .empty { padding: 3rem 0; text-align: center; }
  .empty-head { margin: 0 0 0.375rem; color: var(--text-secondary); font-size: 1rem; font-weight: 600; }
  .empty-sub { margin: 0; color: var(--text-muted); font-size: 0.875rem; }

  .inline-link {
    color: var(--accent-text);
    font-size: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    transition: color var(--transition);
  }
  .inline-link:hover { color: var(--accent); }
</style>
