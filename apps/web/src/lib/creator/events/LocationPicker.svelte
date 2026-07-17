<script lang="ts">
  import type { EventGeo } from "@woco/shared";
  import { COUNTRY_VOCAB, countryName } from "@woco/shared";
  import { searchPlaces, locationLineFor, type PlaceResult } from "../../geo/photon.js";

  interface Props {
    geo: EventGeo | undefined;
    /** The free-text display line — auto-filled on selection, stays user-editable. */
    location: string;
  }

  let { geo = $bindable(undefined), location = $bindable("") }: Props = $props();

  // Rebuilt into a fresh `geo` object literal on every change rather than mutating
  // the bound object in place — Svelte 5's $state proxy only tracks properties
  // present at initialisation, so partial in-place writes to an externally-owned
  // object are an easy way to end up with silently non-reactive fields.
  let country = $state(geo?.country ?? "");
  let city = $state(geo?.city ?? "");
  let venue = $state(geo?.venue ?? "");
  let address = $state(geo?.address ?? "");
  let lat = $state<number | undefined>(geo?.lat);
  let lng = $state<number | undefined>(geo?.lng);

  $effect(() => {
    const next: EventGeo = {};
    if (country) next.country = country;
    if (city) next.city = city;
    if (venue) next.venue = venue;
    if (address) next.address = address;
    if (lat !== undefined && lng !== undefined) {
      next.lat = lat;
      next.lng = lng;
    }
    geo = Object.keys(next).length > 0 ? next : undefined;
  });

  const resolvedLabel = $derived(
    [venue, city, countryName(country) ?? undefined].filter((p, i, a) => p && a.indexOf(p) === i).join(" · "),
  );
  const hasResolved = $derived(!!venue || !!city || (lat !== undefined && lng !== undefined));

  // ── Search-as-you-type against Photon ─────────────────────────────────────
  let query = $state("");
  let results = $state<PlaceResult[]>([]);
  let loading = $state(false);
  let open = $state(false);
  let activeIndex = $state(-1);
  let searchSeq = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function onQueryInput() {
    if (debounceTimer) clearTimeout(debounceTimer);
    activeIndex = -1;
    const q = query.trim();
    if (q.length < 3) {
      results = [];
      open = false;
      loading = false;
      return;
    }
    loading = true;
    debounceTimer = setTimeout(() => runSearch(q), 320);
  }

  async function runSearch(q: string) {
    const seq = ++searchSeq;
    const found = await searchPlaces(q);
    if (seq !== searchSeq) return; // a newer keystroke superseded this lookup
    results = found;
    open = found.length > 0;
    loading = false;
  }

  function selectResult(r: PlaceResult) {
    country = r.countryCode ?? country;
    city = r.city ?? "";
    venue = r.venue ?? "";
    address = r.address ?? "";
    lat = r.lat;
    lng = r.lng;
    const fallbackCountry = r.secondary.split(",").filter(Boolean).pop()?.trim();
    location = locationLineFor(r, countryName(r.countryCode ?? "") ?? fallbackCountry);
    query = "";
    results = [];
    open = false;
    activeIndex = -1;
  }

  function clearResolved() {
    city = "";
    venue = "";
    address = "";
    lat = undefined;
    lng = undefined;
  }

  function onKeydown(e: KeyboardEvent) {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % results.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = activeIndex <= 0 ? results.length - 1 : activeIndex - 1;
    } else if (e.key === "Enter") {
      if (activeIndex >= 0) {
        e.preventDefault();
        selectResult(results[activeIndex]!);
      }
    } else if (e.key === "Escape") {
      open = false;
      activeIndex = -1;
    }
  }
</script>

<div class="location-picker">
  <label class="field">
    <span>Country</span>
    <select bind:value={country}>
      <option value="">Select country</option>
      {#each COUNTRY_VOCAB as c (c.code)}
        <option value={c.code}>{c.name}</option>
      {/each}
    </select>
  </label>

  <div class="field combobox" class:combobox--open={open}>
    <span>Venue or city</span>
    <div class="combo-input-wrap">
      <svg class="search-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.3"/>
        <path d="M9.3 9.3L12.5 12.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
      </svg>
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls="location-results"
        aria-autocomplete="list"
        placeholder="Search for a venue or city…"
        bind:value={query}
        oninput={onQueryInput}
        onkeydown={onKeydown}
        onfocus={() => { if (results.length > 0) open = true; }}
        onblur={() => setTimeout(() => (open = false), 150)}
      />
      {#if loading}
        <span class="combo-spinner" aria-hidden="true"></span>
      {/if}
    </div>

    {#if open}
      <ul class="combo-results" id="location-results" role="listbox">
        {#each results as r, i (r.label + r.lat)}
          <li role="option" aria-selected={i === activeIndex}>
            <button
              type="button"
              class="combo-result"
              class:combo-result--active={i === activeIndex}
              onmousedown={(e) => { e.preventDefault(); selectResult(r); }}
              onmouseenter={() => (activeIndex = i)}
            >
              <span class="combo-result-label">{r.label}</span>
              {#if r.secondary}<span class="combo-result-sub">{r.secondary}</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  {#if hasResolved}
    <div class="resolved-chip">
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true" class="pin-icon">
        <path d="M6.5 1.2c-2 0-3.6 1.6-3.6 3.6 0 2.7 3.6 6.8 3.6 6.8s3.6-4.1 3.6-6.8c0-2-1.6-3.6-3.6-3.6z"
              fill="#C7F23A" opacity="0.18" stroke="#C7F23A" stroke-width="1.1" stroke-linejoin="round"/>
        <circle cx="6.5" cy="4.8" r="1.3" fill="#C7F23A"/>
      </svg>
      <div class="resolved-text">
        <span class="resolved-label">{resolvedLabel || "Coordinates set"}</span>
        {#if lat !== undefined && lng !== undefined}
          <span class="resolved-coords">{lat.toFixed(4)}, {lng.toFixed(4)}</span>
        {/if}
      </div>
      <button type="button" class="resolved-clear" onclick={clearResolved} aria-label="Clear resolved location">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
  {/if}
</div>

<style>
  .location-picker {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .field > span {
    color: var(--text-secondary);
    font-size: 0.8125rem;
    font-weight: 500;
  }

  .combobox {
    position: relative;
  }

  .combo-input-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }

  .search-icon {
    position: absolute;
    left: 0.75rem;
    color: var(--text-muted);
    pointer-events: none;
  }

  .combo-input-wrap input {
    width: 100%;
    padding-left: 2.125rem;
  }

  .combo-spinner {
    position: absolute;
    right: 0.75rem;
    width: 12px;
    height: 12px;
    border: 1.5px solid color-mix(in srgb, var(--accent) 30%, var(--border));
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: location-spin 0.55s linear infinite;
  }

  @keyframes location-spin {
    to { transform: rotate(360deg); }
  }

  .combo-results {
    position: absolute;
    z-index: 20;
    top: calc(100% + 0.3rem);
    left: 0;
    right: 0;
    margin: 0;
    padding: 0.3rem;
    list-style: none;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    max-height: 15rem;
    overflow-y: auto;
  }

  .combo-result {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
    width: 100%;
    padding: 0.5rem 0.625rem;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .combo-result--active,
  .combo-result:hover {
    background: var(--accent-subtle);
  }

  .combo-result-label {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text);
  }

  .combo-result-sub {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .resolved-chip {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.625rem;
    background: var(--accent-subtle);
    border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent);
    border-radius: var(--radius-md);
  }

  .pin-icon {
    flex-shrink: 0;
  }

  .resolved-text {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    flex: 1;
    min-width: 0;
    flex-wrap: wrap;
  }

  .resolved-label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text);
  }

  .resolved-coords {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    color: var(--text-muted);
    letter-spacing: 0.01em;
  }

  .resolved-clear {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    color: var(--text-muted);
    background: transparent;
    border: none;
    border-radius: 50%;
    cursor: pointer;
    transition: background var(--transition), color var(--transition);
  }

  .resolved-clear:hover {
    background: color-mix(in srgb, var(--error) 12%, transparent);
    color: var(--error);
  }
</style>
