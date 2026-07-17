<script lang="ts">
  import { countryName } from "@woco/shared";
  import type { NearMeState } from "../../utils/geo-distance.js";

  export interface CountryOption {
    code: string;
    name: string;
    count: number;
  }

  export interface GenreOption {
    value: string;
    count: number;
  }

  interface Props {
    countries: CountryOption[];
    genres: GenreOption[];
    country: string;
    selectedGenres: Set<string>;
    nearMe: NearMeState | null;
  }

  let {
    countries,
    genres,
    country = $bindable(""),
    selectedGenres = $bindable(new Set()),
    nearMe = $bindable(null),
  }: Props = $props();

  const RADIUS_PRESETS = [25, 50, 100, 250, 500];
  const DEFAULT_RADIUS_KM = 50;

  let locating = $state(false);
  let locateError = $state<string | null>(null);

  const hasActiveFilters = $derived(!!country || selectedGenres.size > 0 || !!nearMe);
  const countryLabel = $derived(country ? (countryName(country) ?? country) : "");

  function toggleGenre(value: string) {
    const next = new Set(selectedGenres);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    selectedGenres = next;
  }

  function toggleNearMe() {
    if (nearMe || locating) {
      nearMe = null;
      locating = false;
      locateError = null;
      return;
    }
    if (!("geolocation" in navigator)) {
      locateError = "Location isn't available in this browser.";
      return;
    }
    locating = true;
    locateError = null;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        locating = false;
        nearMe = { lat: pos.coords.latitude, lng: pos.coords.longitude, radiusKm: DEFAULT_RADIUS_KM };
      },
      (err) => {
        locating = false;
        locateError = err.code === err.PERMISSION_DENIED
          ? "Location access was denied."
          : "Couldn't get your location.";
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 },
    );
  }

  function setRadius(km: number) {
    if (nearMe) nearMe = { ...nearMe, radiusKm: km };
  }

  function clearAll() {
    country = "";
    selectedGenres = new Set();
    nearMe = null;
    locateError = null;
  }
</script>

<div class="discovery-filters">
  <div class="filters-row">
    <div class="genre-scroll-wrap">
      <div class="genre-scroll" role="group" aria-label="Filter by genre">
        {#each genres as g (g.value)}
          {@const isOn = selectedGenres.has(g.value)}
          {@const disabled = g.count === 0 && !isOn}
          <button
            type="button"
            class="pill"
            class:pill--active={isOn}
            disabled={disabled}
            aria-pressed={isOn}
            onclick={() => toggleGenre(g.value)}
          >
            {g.value}
            {#if isOn || g.count > 0}<span class="pill-count">{g.count}</span>{/if}
          </button>
        {/each}
      </div>
    </div>

    <div class="filters-side">
      <select class="country-select" bind:value={country} aria-label="Filter by country">
        <option value="">Any country</option>
        {#each countries as c (c.code)}
          <option value={c.code}>{c.name} · {c.count}</option>
        {/each}
      </select>

      <button
        type="button"
        class="nearme-btn"
        class:nearme-btn--active={!!nearMe}
        aria-pressed={!!nearMe}
        onclick={toggleNearMe}
      >
        <span class="locate-icon" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            {#if locating}
              <circle class="ping-ring" cx="8" cy="8" r="3" />
              <circle class="ping-ring ping-ring--delay" cx="8" cy="8" r="3" />
            {:else}
              <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.1" opacity="0.4" fill="none" />
            {/if}
            <circle cx="8" cy="8" r="2.2" fill={nearMe ? "var(--accent)" : "currentColor"} />
          </svg>
        </span>
        {#if locating}
          Locating…
        {:else if nearMe}
          Within {nearMe.radiusKm} km
        {:else}
          Near me
        {/if}
      </button>
    </div>
  </div>

  {#if nearMe}
    <div class="radius-row" role="group" aria-label="Search radius">
      {#each RADIUS_PRESETS as km (km)}
        <button
          type="button"
          class="radius-chip"
          class:radius-chip--active={nearMe.radiusKm === km}
          onclick={() => setRadius(km)}
        >
          {km} km
        </button>
      {/each}
    </div>
  {/if}

  {#if locateError}
    <p class="locate-error" role="alert">{locateError}</p>
  {/if}

  {#if hasActiveFilters}
    <div class="active-chips">
      {#if country}
        <button type="button" class="chip" onclick={() => (country = "")}>
          {countryLabel}<span class="chip-x" aria-hidden="true">×</span>
        </button>
      {/if}
      {#each [...selectedGenres] as g (g)}
        <button type="button" class="chip" onclick={() => toggleGenre(g)}>
          {g}<span class="chip-x" aria-hidden="true">×</span>
        </button>
      {/each}
      {#if nearMe}
        <button type="button" class="chip" onclick={() => (nearMe = null)}>
          Within {nearMe.radiusKm} km<span class="chip-x" aria-hidden="true">×</span>
        </button>
      {/if}
      <button type="button" class="clear-all" onclick={clearAll}>Clear all</button>
    </div>
  {/if}
</div>

<style>
  .discovery-filters {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    margin-bottom: 1.25rem;
  }

  .filters-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
  }

  .genre-scroll-wrap {
    flex: 1;
    min-width: 0;
    /* Fade the trailing edge so a horizontally-scrollable pill row reads as
       "more content" rather than an abrupt clip on narrow viewports. */
    mask-image: linear-gradient(to right, black calc(100% - 1.5rem), transparent 100%);
    -webkit-mask-image: linear-gradient(to right, black calc(100% - 1.5rem), transparent 100%);
  }

  .genre-scroll {
    display: flex;
    gap: 0.4rem;
    overflow-x: auto;
    padding: 0.125rem 1.5rem 0.125rem 0.0625rem;
    scrollbar-width: none;
  }

  .genre-scroll::-webkit-scrollbar {
    display: none;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    flex-shrink: 0;
    padding: 0.4rem 0.75rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text-secondary);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 999px;
    cursor: pointer;
    transition: border-color var(--transition), background var(--transition), color var(--transition), transform 0.08s ease-out;
    white-space: nowrap;
  }

  .pill:hover:not(:disabled) {
    border-color: var(--border-hover);
    color: var(--text);
  }

  .pill:active:not(:disabled) {
    transform: scale(0.97);
  }

  .pill--active {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-ink);
    font-weight: 600;
  }

  .pill--active:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }

  .pill:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .pill-count {
    font-family: var(--font-mono);
    font-size: 0.625rem;
    opacity: 0.7;
  }

  .filters-side {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .country-select {
    padding: 0.4rem 0.625rem;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: border-color var(--transition), color var(--transition);
    max-width: 10rem;
  }

  .country-select:hover {
    border-color: var(--border-hover);
    color: var(--text);
  }

  .nearme-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.4rem 0.75rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text-secondary);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    cursor: pointer;
    white-space: nowrap;
    transition: border-color var(--transition), background var(--transition), color var(--transition);
  }

  .nearme-btn:hover {
    border-color: var(--border-hover);
    color: var(--text);
  }

  .nearme-btn--active {
    background: var(--accent-subtle);
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
    color: var(--accent-text);
  }

  .locate-icon {
    display: inline-flex;
    color: currentColor;
  }

  .ping-ring {
    fill: none;
    stroke: var(--accent);
    stroke-width: 1.3;
    transform-origin: 8px 8px;
    animation: locate-ping 1.6s cubic-bezier(0.2, 0.8, 0.2, 1) infinite;
  }

  .ping-ring--delay {
    animation-delay: 0.8s;
  }

  @keyframes locate-ping {
    0% { r: 3px; opacity: 0.9; }
    100% { r: 7px; opacity: 0; }
  }

  .radius-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .radius-chip {
    padding: 0.25rem 0.625rem;
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 999px;
    cursor: pointer;
    transition: border-color var(--transition), color var(--transition), background var(--transition);
  }

  .radius-chip:hover {
    color: var(--text);
    border-color: var(--border-hover);
  }

  .radius-chip--active {
    color: var(--accent-ink);
    background: var(--accent);
    border-color: var(--accent);
    font-weight: 700;
  }

  .locate-error {
    margin: 0;
    font-size: 0.75rem;
    color: var(--error);
  }

  .active-chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.25rem 0.5rem 0.25rem 0.625rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--accent-text);
    background: var(--accent-subtle);
    border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent);
    border-radius: 999px;
    cursor: pointer;
    transition: background var(--transition);
  }

  .chip:hover {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
  }

  .chip-x {
    font-size: 0.875rem;
    line-height: 1;
    opacity: 0.7;
  }

  .clear-all {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0.25rem 0.375rem;
    transition: color var(--transition);
  }

  .clear-all:hover {
    color: var(--text);
  }
</style>
