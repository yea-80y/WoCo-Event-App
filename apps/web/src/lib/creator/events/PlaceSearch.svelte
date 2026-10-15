<script lang="ts">
  import { untrack } from "svelte";
  import { searchPlaces, cachedPlaces, type PlaceResult, type SearchKind } from "../../geo/photon.js";

  interface Props {
    kind: SearchKind;
    label: string;
    placeholder: string;
    /** Text to search for when it changes - an imported or previously typed location. */
    seed?: string;
    onpick: (r: PlaceResult) => void;
    /** Offered only once a search has ANSWERED: never for a slow or failed one. */
    onmanual?: (query: string) => void;
  }

  let { kind, label, placeholder, seed = "", onpick, onmanual }: Props = $props();

  const listId = $props.id();

  let query = $state("");
  let results = $state<PlaceResult[]>([]);
  /** The query the shown results answer, and how its search ended. */
  let answered = $state<{ query: string; status: "ok" | "error" } | null>(null);
  let loading = $state(false);
  let open = $state(false);
  let activeIndex = $state(-1);
  let searchSeq = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const s = seed.trim();
    untrack(() => {
      if (s.length >= 3 && s !== query.trim()) {
        query = s;
        void runSearch(s);
      }
    });
  });

  function onQueryInput() {
    if (debounceTimer) clearTimeout(debounceTimer);
    activeIndex = -1;
    const q = query.trim();
    if (q.length < 3) {
      searchSeq++;
      results = [];
      answered = null;
      open = false;
      loading = false;
      return;
    }
    const hit = cachedPlaces(q, kind);
    if (hit) {
      searchSeq++;
      show(q, { status: "ok", results: hit });
      return;
    }
    // The last results stay up while the next lookup runs: the list refines as
    // you type instead of blanking on every key.
    loading = true;
    debounceTimer = setTimeout(() => void runSearch(q), 200);
  }

  async function runSearch(q: string) {
    const seq = ++searchSeq;
    loading = true;
    const outcome = await searchPlaces(q, kind);
    if (seq !== searchSeq || outcome.status === "superseded") return;
    show(q, outcome);
  }

  function show(q: string, outcome: { status: "ok"; results: PlaceResult[] } | { status: "error" }) {
    loading = false;
    answered = { query: q, status: outcome.status };
    if (outcome.status === "ok") results = outcome.results;
    open = outcome.status === "ok" && outcome.results.length > 0;
  }

  function retry() {
    const q = query.trim();
    if (q.length >= 3) void runSearch(q);
  }

  function select(r: PlaceResult) {
    open = false;
    activeIndex = -1;
    onpick(r);
  }

  function manual() {
    open = false;
    onmanual?.(query.trim());
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
        select(results[activeIndex]!);
      }
    } else if (e.key === "Escape") {
      open = false;
      activeIndex = -1;
    }
  }

  const current = $derived(answered && answered.query === query.trim() && !loading ? answered : null);
  const noMatch = $derived(current?.status === "ok" && results.length === 0);
</script>

<div class="field combobox">
  <span>{label}</span>
  <div class="combo-input-wrap">
    <svg class="search-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.3"/>
      <path d="M9.3 9.3L12.5 12.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    </svg>
    <input
      type="text"
      role="combobox"
      aria-expanded={open}
      aria-controls={listId}
      aria-autocomplete="list"
      autocomplete="off"
      {placeholder}
      bind:value={query}
      oninput={onQueryInput}
      onkeydown={onKeydown}
      onfocus={() => { if (results.length > 0 && query.trim().length >= 3) open = true; }}
      onblur={() => setTimeout(() => (open = false), 150)}
    />
    {#if loading}
      <span class="combo-spinner" aria-hidden="true"></span>
    {/if}
  </div>

  {#if open}
    <ul class="combo-results" id={listId} role="listbox">
      {#each results as r, i (r.label + r.lat + r.lng)}
        <li role="option" aria-selected={i === activeIndex}>
          <button
            type="button"
            class="combo-result"
            class:combo-result--active={i === activeIndex}
            onmousedown={(e) => { e.preventDefault(); select(r); }}
            onmouseenter={() => (activeIndex = i)}
          >
            <span class="combo-result-label">{r.label}</span>
            {#if r.secondary}<span class="combo-result-sub">{r.secondary}</span>{/if}
          </button>
        </li>
      {/each}
      {#if onmanual && current?.status === "ok"}
        <li class="combo-manual-row">
          <button type="button" class="combo-manual" onmousedown={(e) => { e.preventDefault(); manual(); }}>
            Not listed? Enter it yourself
          </button>
        </li>
      {/if}
    </ul>
  {/if}

  {#if current?.status === "error"}
    <p class="search-note" role="status">
      Search isn't answering right now.
      <button type="button" class="note-link" onclick={retry}>Try again</button>
    </p>
  {:else if noMatch}
    <p class="search-note" role="status">
      No match for "{current?.query}".
      {#if onmanual}<button type="button" class="note-link" onclick={manual}>Enter it yourself</button>{/if}
    </p>
  {/if}
</div>

<style>
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
    animation: place-spin 0.55s linear infinite;
  }

  @keyframes place-spin {
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
    max-height: 17rem;
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

  .combo-manual-row {
    margin-top: 0.25rem;
    padding-top: 0.25rem;
    border-top: 1px solid var(--border);
  }

  .combo-manual {
    width: 100%;
    padding: 0.45rem 0.625rem;
    text-align: left;
    font-size: 0.8125rem;
    color: var(--accent-text);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .combo-manual:hover {
    background: var(--accent-subtle);
  }

  .search-note {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .note-link {
    padding: 0;
    font-size: inherit;
    color: var(--accent-text);
    background: none;
    border: none;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }
</style>
