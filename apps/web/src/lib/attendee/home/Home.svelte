<script lang="ts">
  import type { SnapshotCard } from "@woco/shared";
  import { COUNTRY_VOCAB, GENRE_VOCAB } from "@woco/shared";
  import { listEvents } from "../../api/events.js";
  import { navigate } from "../../router/router.svelte.js";
  import { setExternalEventApi, setEventFeedSigner } from "../../api/event-api-registry.js";
  import EventCard from "../events/EventCard.svelte";
  import DiscoveryFilters from "./DiscoveryFilters.svelte";
  import { cacheGet, cacheSet, cacheKey, TTL } from "../../cache/cache.js";
  import { isPastEvent } from "../../utils/events.js";
  import { haversineKm, type NearMeState } from "../../utils/geo-distance.js";
  import { onMount, onDestroy } from "svelte";

  type Tab = "upcoming" | "past";
  let tab = $state<Tab>("upcoming");

  // Reactive clock — drives past/upcoming split without any server involvement.
  // Ticks every minute; events auto-migrate between tabs when they end.
  let now = $state(Date.now());
  let clockTimer: ReturnType<typeof setInterval>;

  const _KEY = cacheKey.directory();
  const _cached = cacheGet<SnapshotCard[]>(_KEY);

  let allEvents = $state<SnapshotCard[]>(_cached ?? []);
  let loading = $state(_cached === null);

  // ── Discovery facet filter (#37) — client-side, zero extra requests ────────
  let country = $state("");
  let selectedGenres = $state<Set<string>>(new Set());
  let nearMe = $state<NearMeState | null>(null);
  const hasActiveFilters = $derived(!!country || selectedGenres.size > 0 || !!nearMe);

  function passesCountry(e: SnapshotCard): boolean {
    return !country || e.geo?.country === country;
  }
  function passesGenre(e: SnapshotCard): boolean {
    if (selectedGenres.size === 0) return true;
    const eventGenres = e.tags?.filter((t) => t.type === "genre").map((t) => t.value) ?? [];
    return eventGenres.some((g) => selectedGenres.has(g));
  }
  function passesNearMe(e: SnapshotCard): boolean {
    if (!nearMe) return true;
    if (e.geo?.lat === undefined || e.geo?.lng === undefined) return false;
    return haversineKm(nearMe.lat, nearMe.lng, e.geo.lat, e.geo.lng) <= nearMe.radiusKm;
  }
  function distanceFor(e: SnapshotCard): number | undefined {
    if (!nearMe || e.geo?.lat === undefined || e.geo?.lng === undefined) return undefined;
    return haversineKm(nearMe.lat, nearMe.lng, e.geo.lat, e.geo.lng);
  }
  function clearFilters() {
    country = "";
    selectedGenres = new Set();
    nearMe = null;
  }

  const filteredEvents = $derived(
    allEvents.filter((e) => passesCountry(e) && passesGenre(e) && passesNearMe(e)),
  );

  // Facet option counts exclude their OWN facet (but respect the others) — picking
  // a country never hides itself from the country list, standard faceted-search UX.
  const countryOptions = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const e of allEvents) {
      if (!passesGenre(e) || !passesNearMe(e)) continue;
      if (e.geo?.country) counts.set(e.geo.country, (counts.get(e.geo.country) ?? 0) + 1);
    }
    return COUNTRY_VOCAB
      .filter((c) => counts.has(c.code) || c.code === country)
      .map((c) => ({ code: c.code, name: c.name, count: counts.get(c.code) ?? 0 }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  });

  const genreOptions = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const e of allEvents) {
      if (!passesCountry(e) || !passesNearMe(e)) continue;
      for (const t of e.tags ?? []) {
        if (t.type === "genre") counts.set(t.value, (counts.get(t.value) ?? 0) + 1);
      }
    }
    return GENRE_VOCAB.map((value) => ({ value, count: counts.get(value) ?? 0 }));
  });

  // Client-side split — single source of truth, no extra network calls
  const upcoming = $derived(
    filteredEvents.filter(e => !isPastEvent(e, now))
      .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime())
  );
  const past = $derived(
    filteredEvents.filter(e => isPastEvent(e, now))
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

{#if !loading && allEvents.length > 0}
  <DiscoveryFilters
    countries={countryOptions}
    genres={genreOptions}
    bind:country
    bind:selectedGenres
    bind:nearMe
  />
{/if}

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
        {#if hasActiveFilters}
          <p class="empty-head">No events match your filters</p>
          <p class="empty-sub"><button class="inline-link" onclick={clearFilters}>Clear filters</button> to see everything upcoming.</p>
        {:else}
          <p class="empty-head">No upcoming events</p>
          <p class="empty-sub">Check back soon — or <button class="inline-link" onclick={() => navigate("/creator")}>start something yourself</button>.</p>
        {/if}
      </div>
    {:else}
      <div class="event-grid">
        {#each upcoming as event (event.eventId)}
          <EventCard {event} distanceKm={distanceFor(event)} onclick={() => {
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
        {#if hasActiveFilters}
          <p class="empty-head">No past events match your filters</p>
          <p class="empty-sub"><button class="inline-link" onclick={clearFilters}>Clear filters</button> to see everything past.</p>
        {:else}
          <p class="empty-head">No past events</p>
        {/if}
      </div>
    {:else}
      <div class="event-grid">
        {#each past as event (event.eventId)}
          <EventCard {event} distanceKm={distanceFor(event)} onclick={() => {
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
