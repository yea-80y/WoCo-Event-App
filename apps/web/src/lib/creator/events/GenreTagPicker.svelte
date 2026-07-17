<script lang="ts">
  import type { EventTag } from "@woco/shared";
  import { GENRE_VOCAB } from "@woco/shared";

  interface Props {
    tags: EventTag[];
  }

  let { tags = $bindable([]) }: Props = $props();

  const MAX_GENRES = 6;

  const selected = $derived(new Set(tags.filter((t) => t.type === "genre").map((t) => t.value)));
  const atCap = $derived(selected.size >= MAX_GENRES);

  function toggle(value: string) {
    if (selected.has(value)) {
      tags = tags.filter((t) => !(t.type === "genre" && t.value === value));
    } else if (!atCap) {
      tags = [...tags, { type: "genre", value }];
    }
  }
</script>

<div class="genre-picker">
  <div class="genre-head">
    <span class="genre-label">Genre</span>
    <span class="genre-count" class:genre-count--cap={atCap}>{selected.size}/{MAX_GENRES}</span>
  </div>
  <p class="genre-hint">Pick up to {MAX_GENRES} that fit best — helps people find your event.</p>

  <div class="genre-pills" role="group" aria-label="Genre tags">
    {#each GENRE_VOCAB as genre (genre)}
      {@const isOn = selected.has(genre)}
      <button
        type="button"
        class="pill"
        class:pill--active={isOn}
        disabled={!isOn && atCap}
        aria-pressed={isOn}
        onclick={() => toggle(genre)}
      >
        {genre}
      </button>
    {/each}
  </div>
</div>

<style>
  .genre-picker {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .genre-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  .genre-label {
    color: var(--text-secondary);
    font-size: 0.8125rem;
    font-weight: 500;
  }

  .genre-count {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    color: var(--text-muted);
  }

  .genre-count--cap {
    color: var(--accent-text);
  }

  .genre-hint {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .genre-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .pill {
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
</style>
