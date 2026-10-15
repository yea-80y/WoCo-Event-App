<script lang="ts">
  import { untrack } from "svelte";
  import type { EventGeo } from "@woco/shared";
  import { countryName } from "@woco/shared";
  import { locationLineFor, rememberPlace, type PlaceResult } from "../../geo/photon.js";
  import PlaceSearch from "./PlaceSearch.svelte";

  interface Props {
    geo: EventGeo | undefined;
    /** The display line, written from the chosen place - there is no separate box for it. */
    location: string;
  }

  let { geo = $bindable(undefined), location = $bindable("") }: Props = $props();

  interface Place {
    venue?: string;
    address?: string;
    city?: string;
    country?: string;
    lat: number;
    lng: number;
  }

  // Seeded once from the event being edited; from then on this component owns both
  // values. `geo` is rebuilt as a fresh object each time - Svelte 5's $state proxy
  // only tracks properties present at initialisation.
  // svelte-ignore state_referenced_locally
  const initial = { geo, location };
  const initialPlace: Place | null =
    !initial.geo?.online && initial.geo?.lat !== undefined && initial.geo?.lng !== undefined
      ? {
          venue: initial.geo.venue, address: initial.geo.address, city: initial.geo.city,
          country: initial.geo.country, lat: initial.geo.lat, lng: initial.geo.lng,
        }
      : null;

  let mode = $state<"search" | "manual" | "online">(initial.geo?.online ? "online" : "search");
  let place = $state<Place | null>(initialPlace);
  // An edited event keeps the line it was saved with until its place changes.
  let placeLine = $state(initialPlace ? initial.location : "");
  let manualVenue = $state("");
  let manualAddress = $state("");
  let town = $state<Place | null>(null);
  // An event saved before places were required has only its old text: search for it.
  let seed = $state(!initialPlace && !initial.geo?.online ? initial.location : "");

  const dedupe = (p: string | undefined, i: number, a: (string | undefined)[]) => !!p && a.indexOf(p) === i;

  const out = $derived.by((): { geo: EventGeo | undefined; line: string } => {
    if (mode === "online") return { geo: { online: true }, line: "Online" };
    if (mode === "manual") {
      const venue = manualVenue.trim();
      const address = manualAddress.trim();
      if (!venue || !town) return { geo: undefined, line: "" };
      return {
        geo: {
          venue,
          ...(address ? { address } : {}),
          ...(town.city ? { city: town.city } : {}),
          ...(town.country ? { country: town.country } : {}),
          lat: town.lat,
          lng: town.lng,
        },
        line: [venue, address, town.city, countryName(town.country ?? "") ?? undefined].filter(dedupe).join(", "),
      };
    }
    if (!place) return { geo: undefined, line: "" };
    const g: EventGeo = { lat: place.lat, lng: place.lng };
    if (place.country) g.country = place.country;
    if (place.city) g.city = place.city;
    if (place.venue) g.venue = place.venue;
    if (place.address) g.address = place.address;
    return { geo: g, line: placeLine };
  });

  // What the parent last heard from us. Anything else in `location` was set from
  // outside (the URL import): a chosen place wins over it, otherwise it is searched.
  let written: string | null = null;
  $effect(() => {
    written = out.line;
    geo = out.geo;
    location = out.line;
  });
  $effect(() => {
    const l = location;
    untrack(() => {
      if (written === null || l === written) return;
      if (out.geo) location = written;
      else if (mode === "search" && l.trim()) seed = l;
    });
  });

  function toPlace(r: PlaceResult): Place {
    return { venue: r.venue, address: r.address, city: r.city, country: r.countryCode, lat: r.lat, lng: r.lng };
  }

  function pickPlace(r: PlaceResult) {
    place = toPlace(r);
    const fallbackCountry = r.secondary.split(",").filter(Boolean).pop()?.trim();
    placeLine = locationLineFor(r, countryName(r.countryCode ?? "") ?? fallbackCountry);
    rememberPlace(r);
  }

  function pickTown(r: PlaceResult) {
    town = { city: r.city ?? r.label, country: r.countryCode, lat: r.lat, lng: r.lng };
    rememberPlace(r);
  }

  function enterManually(query: string) {
    mode = "manual";
    if (!manualVenue.trim()) manualVenue = query;
  }

  function backToSearch() {
    mode = "search";
    seed = manualVenue.trim();
  }

  const placeLabel = $derived(
    place
      ? [place.venue, place.city, countryName(place.country ?? "") ?? undefined].filter(dedupe).join(" · ") || "Place set"
      : "",
  );
  const townLabel = $derived(
    town ? [town.city, countryName(town.country ?? "") ?? undefined].filter(dedupe).join(", ") : "",
  );
</script>

{#snippet pin()}
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true" class="pin-icon">
    <path d="M6.5 1.2c-2 0-3.6 1.6-3.6 3.6 0 2.7 3.6 6.8 3.6 6.8s3.6-4.1 3.6-6.8c0-2-1.6-3.6-3.6-3.6z"
          fill="currentColor" fill-opacity="0.18" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>
    <circle cx="6.5" cy="4.8" r="1.3" fill="currentColor"/>
  </svg>
{/snippet}

<div class="location-picker">
  <div class="where-head">
    <span class="where-label">Where</span>
    <div class="mode-switch" role="radiogroup" aria-label="Where the event happens">
      <button
        type="button"
        role="radio"
        aria-checked={mode !== "online"}
        class:on={mode !== "online"}
        onclick={() => { if (mode === "online") mode = "search"; }}
      >In person</button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === "online"}
        class:on={mode === "online"}
        onclick={() => (mode = "online")}
      >Online</button>
    </div>
  </div>

  {#if mode === "online"}
    <p class="online-note">
      People filtering by distance won't see it. Send ticket holders the joining link
      from your event dashboard - it isn't shown on the public page.
    </p>
  {:else if mode === "search"}
    {#if place}
      <div class="resolved-chip">
        {@render pin()}
        <div class="resolved-text">
          <span class="resolved-label">{placeLabel}</span>
          {#if place.address}<span class="resolved-sub">{place.address}</span>{/if}
          <span class="resolved-coords">{place.lat.toFixed(4)}, {place.lng.toFixed(4)}</span>
        </div>
        <button type="button" class="resolved-change" onclick={() => { place = null; placeLine = ""; }}>Change</button>
      </div>
    {:else}
      <PlaceSearch
        kind="place"
        label="Venue or address"
        placeholder="Search for the venue or address…"
        {seed}
        onpick={pickPlace}
        onmanual={enterManually}
      />
    {/if}
  {:else}
    <div class="manual">
      <label class="field">
        <span>Venue name</span>
        <input type="text" bind:value={manualVenue} maxlength="80" placeholder="e.g. Joe's Barn" />
      </label>
      <label class="field">
        <span>Address <span class="hint">optional</span></span>
        <input type="text" bind:value={manualAddress} maxlength="160" placeholder="Street and number" />
      </label>
      {#if town}
        <div class="field">
          <span>Town or city</span>
          <div class="resolved-chip">
            {@render pin()}
            <div class="resolved-text">
              <span class="resolved-label">{townLabel}</span>
            </div>
            <button type="button" class="resolved-change" onclick={() => (town = null)}>Change</button>
          </div>
        </div>
      {:else}
        <PlaceSearch kind="town" label="Town or city" placeholder="Search for the town…" onpick={pickTown} />
      {/if}
      <p class="manual-note">Distance is measured from the town.</p>
      <button type="button" class="back-link" onclick={backToSearch}>Back to search</button>
    </div>
  {/if}
</div>

<style>
  .location-picker {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .where-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .where-label,
  .field > span {
    color: var(--text-secondary);
    font-size: 0.8125rem;
    font-weight: 500;
  }

  .mode-switch {
    display: inline-flex;
    padding: 2px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .mode-switch button {
    padding: 0.3rem 0.75rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background var(--transition), color var(--transition);
  }

  .mode-switch button:hover:not(.on) {
    color: var(--text);
  }

  .mode-switch button.on {
    background: var(--accent);
    color: var(--accent-ink);
  }

  .online-note,
  .manual-note {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.5;
    color: var(--text-muted);
  }

  .manual {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .hint {
    color: var(--text-muted);
    font-weight: 400;
  }

  .back-link {
    align-self: flex-start;
    padding: 0;
    font-size: 0.75rem;
    color: var(--accent-text);
    background: none;
    border: none;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .resolved-chip {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.625rem;
    color: var(--accent);
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

  .resolved-sub {
    font-size: 0.75rem;
    color: var(--text-secondary);
  }

  .resolved-coords {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    color: var(--text-muted);
    letter-spacing: 0.01em;
  }

  .resolved-change {
    flex-shrink: 0;
    padding: 0.2rem 0.5rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-secondary);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: border-color var(--transition), color var(--transition);
  }

  .resolved-change:hover {
    color: var(--text);
    border-color: var(--border-hover);
  }
</style>
