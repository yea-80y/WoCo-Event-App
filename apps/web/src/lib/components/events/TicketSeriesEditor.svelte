<script lang="ts">
  interface SeriesDraft {
    seriesId: string;
    name: string;
    description: string;
    totalSupply: number;
  }

  interface Props {
    series: SeriesDraft[];
  }

  let { series = $bindable() }: Props = $props();

  function addSeries() {
    series = [
      ...series,
      {
        seriesId: crypto.randomUUID(),
        name: "",
        description: "",
        totalSupply: 10,
      },
    ];
  }

  function removeSeries(index: number) {
    series = series.filter((_, i) => i !== index);
  }
</script>

<div class="series-editor">
  <h3>Tickets</h3>

  {#each series as s, i}
    <div class="series-card">
      <div class="series-header">
        <span class="series-num">Series {i + 1}</span>
        {#if series.length > 1}
          <button class="remove-btn" onclick={() => removeSeries(i)}>Remove</button>
        {/if}
      </div>

      <label>
        <span>Name</span>
        <input
          type="text"
          bind:value={s.name}
          placeholder="e.g. General Admission, VIP"
        />
      </label>

      <label>
        <span>Description</span>
        <input
          type="text"
          bind:value={s.description}
          placeholder="What's included"
        />
      </label>

      <label>
        <span>Quantity</span>
        <input
          type="number"
          bind:value={s.totalSupply}
          min="1"
        />
      </label>
    </div>
  {/each}

  <button class="add-btn" onclick={addSeries}>
    + Add ticket series
  </button>
</div>

<style>
  .series-editor {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  h3 {
    margin: 0;
    color: var(--text);
    font-size: 1rem;
    font-weight: 600;
  }

  .series-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .series-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .series-num {
    color: var(--text-muted);
    font-size: 0.8125rem;
    font-weight: 500;
  }

  .remove-btn {
    color: var(--text-muted);
    font-size: 0.8125rem;
    transition: color var(--transition);
  }

  .remove-btn:hover {
    color: var(--error);
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  label span {
    color: var(--text-secondary);
    font-size: 0.8125rem;
    font-weight: 500;
  }

  input[type="number"] {
    max-width: 120px;
  }

  .add-btn {
    padding: 0.625rem;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    color: var(--accent-text);
    font-size: 0.875rem;
    transition: all var(--transition);
  }

  .add-btn:hover {
    border-color: var(--accent);
    background: var(--accent-subtle);
  }
</style>
