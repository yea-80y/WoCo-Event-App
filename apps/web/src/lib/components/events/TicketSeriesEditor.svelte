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
  <h3>Ticket Series</h3>

  {#each series as s, i}
    <div class="series-card">
      <div class="series-header">
        <span class="series-num">#{i + 1}</span>
        {#if series.length > 1}
          <button class="remove-btn" onclick={() => removeSeries(i)}>&times;</button>
        {/if}
      </div>

      <label>
        <span>Series name</span>
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
        <span>Quantity (max 127)</span>
        <input
          type="number"
          bind:value={s.totalSupply}
          min="1"
          max="127"
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
    color: #e2e8f0;
    font-size: 1rem;
  }

  .series-card {
    border: 1px solid #2a2a4a;
    border-radius: 8px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .series-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .series-num {
    color: #6b7280;
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .remove-btn {
    background: none;
    border: none;
    color: #6b7280;
    font-size: 1.25rem;
    cursor: pointer;
    padding: 0;
    line-height: 1;
  }

  .remove-btn:hover {
    color: #ef4444;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  label span {
    color: #9ca3af;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  input {
    padding: 0.5rem 0.75rem;
    border: 1px solid #374151;
    border-radius: 6px;
    background: #0f0f23;
    color: #e2e8f0;
    font-size: 0.875rem;
  }

  input:focus {
    outline: none;
    border-color: #4f46e5;
  }

  input[type="number"] {
    max-width: 120px;
  }

  .add-btn {
    padding: 0.5rem;
    border: 1px dashed #374151;
    border-radius: 6px;
    background: transparent;
    color: #818cf8;
    cursor: pointer;
    font-size: 0.875rem;
  }

  .add-btn:hover {
    border-color: #4f46e5;
  }
</style>
