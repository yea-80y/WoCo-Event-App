<script lang="ts">
  export interface GenreOption {
    value: string;
    count: number;
  }

  interface Props {
    genres: GenreOption[];
    selectedGenres: Set<string>;
  }

  let { genres, selectedGenres = $bindable(new Set()) }: Props = $props();

  // A genre no listed event carries is not an option - a row of greyed-out
  // pills reads as broken. A selected one stays so it can be turned off.
  const visible = $derived(genres.filter((g) => g.count > 0 || selectedGenres.has(g.value)));

  function toggle(value: string) {
    const next = new Set(selectedGenres);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    selectedGenres = next;
  }
</script>

{#if visible.length > 0}
  <div class="genre-row" role="group" aria-label="Filter by genre">
    <button
      type="button"
      class="pill"
      class:pill--active={selectedGenres.size === 0}
      aria-pressed={selectedGenres.size === 0}
      onclick={() => (selectedGenres = new Set())}
    >All</button>
    {#each visible as g (g.value)}
      {@const isOn = selectedGenres.has(g.value)}
      <button
        type="button"
        class="pill"
        class:pill--active={isOn}
        aria-pressed={isOn}
        onclick={() => toggle(g.value)}
      >
        {g.value}<span class="pill-count">{g.count}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .genre-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    padding: 1rem 0;
    border-bottom: 1px solid var(--border);
  }

  .pill {
    display: inline-flex;
    align-items: baseline;
    gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text-secondary);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
    white-space: nowrap;
    transition: border-color var(--transition), background var(--transition), color var(--transition);
  }

  .pill:hover {
    border-color: var(--border-hover);
    color: var(--text);
  }

  .pill--active {
    color: var(--accent-ink);
    background: var(--accent);
    border-color: var(--accent);
    font-weight: 600;
  }

  .pill--active:hover {
    color: var(--accent-ink);
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }

  .pill-count {
    font-family: var(--font-mono);
    font-size: 0.625rem;
    opacity: 0.7;
    font-variant-numeric: tabular-nums;
  }
</style>
