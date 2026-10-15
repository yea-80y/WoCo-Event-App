<script lang="ts">
  import type { NearMeState } from "../../utils/geo-distance.js";

  interface Props {
    nearMe: NearMeState | null;
  }

  let { nearMe = $bindable(null) }: Props = $props();

  const RADIUS_PRESETS = [10, 25, 50, 100, 250, 500];
  const DEFAULT_RADIUS_KM = 50;

  let locating = $state(false);
  let locateError = $state<string | null>(null);
  const where = $derived(nearMe || locating ? "near" : "anywhere");

  function onWhere(e: Event & { currentTarget: HTMLSelectElement }) {
    const select = e.currentTarget;
    if (select.value !== "near") {
      nearMe = null;
      locating = false;
      locateError = null;
      return;
    }
    if (!("geolocation" in navigator)) {
      locateError = "Location isn't available in this browser.";
      select.value = "anywhere";
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
          ? "Location access was denied - allow it in your browser to see events near you."
          : "Couldn't get your location. Try again in a moment.";
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 },
    );
  }

  function onRadius(e: Event & { currentTarget: HTMLSelectElement }) {
    if (nearMe) nearMe = { ...nearMe, radiusKm: Number(e.currentTarget.value) };
  }
</script>

{#snippet caret()}
  <svg class="caret" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path d="M2 3.5l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/>
  </svg>
{/snippet}

<div class="near-line">
  <span class="word">Events</span>
  <span class="ctl" class:ctl--on={where === "near"}>
    {#if where === "near"}
      <svg class="locate" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        {#if locating}
          <circle class="ping-ring" cx="8" cy="8" r="3" />
          <circle class="ping-ring ping-ring--delay" cx="8" cy="8" r="3" />
        {:else}
          <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.1" opacity="0.45" />
        {/if}
        <circle cx="8" cy="8" r="2.2" fill="currentColor" />
      </svg>
    {/if}
    <select value={where} onchange={onWhere} aria-label="Where to look for events">
      <option value="anywhere">anywhere</option>
      <option value="near">near me</option>
    </select>
    {@render caret()}
  </span>
  {#if nearMe}
    <span class="word">within</span>
    <span class="ctl ctl--on">
      <select value={nearMe.radiusKm} onchange={onRadius} aria-label="Distance from you">
        {#each RADIUS_PRESETS as km (km)}
          <option value={km}>{km} km</option>
        {/each}
      </select>
      {@render caret()}
    </span>
  {:else if locating}
    <span class="status" role="status">Finding you…</span>
  {/if}
</div>
{#if locateError}
  <p class="locate-error" role="alert">{locateError}</p>
{/if}

<style>
  .near-line {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.5rem;
    margin-top: 1.25rem;
    font-family: var(--font-display);
    font-size: clamp(1.125rem, 2.6vw, 1.375rem);
    font-weight: 500;
    line-height: 1.3;
    color: var(--text-secondary);
  }

  .ctl {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    color: var(--text);
    border-bottom: 1px solid var(--border-hover);
    transition: border-color var(--transition), color var(--transition);
  }

  .ctl:hover,
  .ctl:focus-within {
    border-bottom-color: var(--accent);
  }

  .ctl--on {
    color: var(--accent-text);
    border-bottom-color: var(--accent);
  }

  .ctl select {
    appearance: none;
    -webkit-appearance: none;
    padding: 0 1.125rem 0.0625rem 0;
    font: inherit;
    color: inherit;
    background: transparent;
    border: none;
    border-radius: 0;
    cursor: pointer;
  }

  .ctl select:focus-visible {
    outline: none;
  }

  .ctl:has(select:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }

  .ctl option {
    color: var(--text);
    background: var(--bg-elevated);
  }

  .caret {
    position: absolute;
    right: 0.125rem;
    pointer-events: none;
  }

  .locate {
    flex-shrink: 0;
    align-self: center;
  }

  .status {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }

  .locate-error {
    margin: 0.5rem 0 0;
    font-size: 0.8125rem;
    color: var(--error);
  }

  .ping-ring {
    fill: none;
    stroke: currentColor;
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
</style>
