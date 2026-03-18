<script lang="ts">
  interface WaveItem {
    id: string;
    label: string;
    totalSupply: number;
    saleStart: string;
    saleEnd: string;
    showSaleWindow: boolean;
  }

  interface TierGroup {
    id: string;
    tierName: string;
    description: string;
    approvalRequired: boolean;
    waves: WaveItem[];
  }

  interface SeriesDraft {
    seriesId: string;
    name: string;
    description: string;
    totalSupply: number;
    approvalRequired?: boolean;
    wave?: string;
    saleStart?: string;
    saleEnd?: string;
  }

  interface Props {
    series: SeriesDraft[];
  }

  let { series = $bindable() }: Props = $props();

  let tierGroups = $state<TierGroup[]>([{
    id: crypto.randomUUID(),
    tierName: "General Admission",
    description: "",
    approvalRequired: false,
    waves: [{
      id: crypto.randomUUID(),
      label: "",
      totalSupply: 10,
      saleStart: "",
      saleEnd: "",
      showSaleWindow: false,
    }],
  }]);

  // Keep series in sync with tier groups
  $effect(() => {
    series = tierGroups.flatMap(tier =>
      tier.waves.map(wave => ({
        seriesId: wave.id,
        name: tier.waves.length > 1 && wave.label.trim()
          ? `${tier.tierName.trim()} — ${wave.label.trim()}`
          : tier.tierName.trim(),
        description: tier.description.trim(),
        totalSupply: wave.totalSupply,
        approvalRequired: tier.approvalRequired,
        ...(tier.waves.length > 1 && wave.label.trim() ? { wave: wave.label.trim() } : {}),
        ...(wave.saleStart ? { saleStart: wave.saleStart } : {}),
        ...(wave.saleEnd ? { saleEnd: wave.saleEnd } : {}),
      }))
    );
  });

  function addTier() {
    tierGroups.push({
      id: crypto.randomUUID(),
      tierName: "",
      description: "",
      approvalRequired: false,
      waves: [{
        id: crypto.randomUUID(),
        label: "",
        totalSupply: 10,
        saleStart: "",
        saleEnd: "",
        showSaleWindow: false,
      }],
    });
  }

  function removeTier(id: string) {
    const idx = tierGroups.findIndex(t => t.id === id);
    if (idx !== -1) tierGroups.splice(idx, 1);
  }

  function addWave(tierId: string) {
    const tier = tierGroups.find(t => t.id === tierId);
    if (tier) {
      tier.waves.push({
        id: crypto.randomUUID(),
        label: "",
        totalSupply: 10,
        saleStart: "",
        saleEnd: "",
        showSaleWindow: false,
      });
    }
  }

  function removeWave(tierId: string, waveId: string) {
    const tier = tierGroups.find(t => t.id === tierId);
    if (tier && tier.waves.length > 1) {
      const idx = tier.waves.findIndex(w => w.id === waveId);
      if (idx !== -1) tier.waves.splice(idx, 1);
    }
  }
</script>

<div class="tiers-editor">
  <h3>Ticket tiers</h3>

  {#each tierGroups as tier, i (tier.id)}
    <div class="tier-card">
      <div class="tier-card-header">
        <span class="tier-card-title">
          Tier {i + 1}
          {#if tier.tierName.trim()}
            <span class="tier-name-preview">— {tier.tierName.trim()}</span>
          {/if}
        </span>
        {#if tierGroups.length > 1}
          <button class="remove-btn" onclick={() => removeTier(tier.id)} type="button" aria-label="Remove tier">✕</button>
        {/if}
      </div>

      <div class="tier-card-body">
        <label class="field">
          <span class="field-label">Tier name <span class="required">*</span></span>
          <input type="text" bind:value={tier.tierName} placeholder="e.g. General Admission, VIP" />
        </label>

        <label class="field">
          <span class="field-label">Description</span>
          <input type="text" bind:value={tier.description} placeholder="What's included" />
        </label>

        <label class="approval-toggle">
          <input type="checkbox" bind:checked={tier.approvalRequired} />
          <span class="approval-label">Require organiser approval</span>
          <span class="approval-hint">Attendees submit a request; you approve each one from the dashboard</span>
        </label>

        <!-- Sale waves -->
        <div class="waves-section">
          <div class="waves-header">
            <span class="waves-label">Sale waves</span>
            {#if tier.waves.length === 1}
              <span class="waves-hint">Add waves to split capacity by sale period (e.g. Early Bird → Standard)</span>
            {/if}
          </div>

          <div class="waves-col-labels" class:has-label={tier.waves.length > 1}>
            {#if tier.waves.length > 1}<span>Wave label</span>{/if}
            <span>Quantity</span>
            <span></span>
          </div>

          {#each tier.waves as wave, wi (wave.id)}
            <div class="wave-row">
              <div class="wave-row-fields" class:has-label={tier.waves.length > 1}>
                {#if tier.waves.length > 1}
                  <input
                    class="wave-label-input"
                    type="text"
                    placeholder="e.g. Early Bird"
                    bind:value={wave.label}
                  />
                {/if}
                <input
                  class="wave-supply-input"
                  type="number"
                  min="1"
                  bind:value={wave.totalSupply}
                />
                <button
                  class="wave-window-btn"
                  class:active={wave.showSaleWindow}
                  type="button"
                  onclick={() => { wave.showSaleWindow = !wave.showSaleWindow; }}
                  title="Set sale window"
                >
                  {#if wave.saleStart || wave.saleEnd}
                    <span class="wave-date-summary">
                      {wave.saleStart ? wave.saleStart.slice(0, 10) : "…"}
                      {#if wave.saleEnd}&nbsp;→&nbsp;{wave.saleEnd.slice(0, 10)}{/if}
                    </span>
                  {:else}
                    <span>Sale window</span>
                  {/if}
                  <span class="chevron">{wave.showSaleWindow ? "▲" : "▼"}</span>
                </button>
                {#if tier.waves.length > 1}
                  <button class="remove-btn remove-btn--sm" onclick={() => removeWave(tier.id, wave.id)} type="button" aria-label="Remove wave">✕</button>
                {/if}
              </div>

              {#if wave.showSaleWindow}
                <div class="sale-window-fields">
                  <label class="field">
                    <span class="field-label">Opens</span>
                    <input type="datetime-local" bind:value={wave.saleStart} />
                  </label>
                  <label class="field">
                    <span class="field-label">Closes</span>
                    <input type="datetime-local" bind:value={wave.saleEnd} />
                  </label>
                </div>
              {/if}
            </div>
          {/each}

          <button class="add-wave-btn" type="button" onclick={() => addWave(tier.id)}>+ Add wave</button>
        </div>
      </div>
    </div>
  {/each}

  <button class="add-tier-btn" onclick={addTier} type="button">
    + Add tier
  </button>
</div>

<style>
  .tiers-editor {
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

  /* ── Tier card ── */
  .tier-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .tier-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0.75rem;
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border);
  }

  .tier-card-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .tier-name-preview {
    color: var(--text-muted);
    font-weight: 400;
  }

  .tier-card-body {
    padding: 0.875rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  /* ── Fields ── */
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .field-label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text-secondary);
  }

  .required {
    color: var(--error);
  }

  .field input[type="text"],
  .field input[type="datetime-local"] {
    padding: 0.375rem 0.5rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 0.8125rem;
    font-family: inherit;
  }

  .field input:focus {
    outline: none;
    border-color: var(--accent);
  }

  /* ── Approval toggle ── */
  .approval-toggle {
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    gap: 0.5rem;
    cursor: pointer;
    flex-wrap: wrap;
  }

  .approval-toggle input[type="checkbox"] {
    margin-top: 0.125rem;
    width: 0.9rem;
    height: 0.9rem;
    accent-color: var(--accent);
    flex-shrink: 0;
  }

  .approval-label {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    font-weight: 500;
  }

  .approval-hint {
    font-size: 0.75rem;
    color: var(--text-muted);
    font-weight: 400;
    width: 100%;
    margin-left: 1.4rem;
  }

  /* ── Waves ── */
  .waves-section {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    border-top: 1px dashed var(--border);
    padding-top: 0.75rem;
    margin-top: 0.125rem;
  }

  .waves-header {
    display: flex;
    align-items: baseline;
    gap: 0.625rem;
    flex-wrap: wrap;
    margin-bottom: 0.125rem;
  }

  .waves-label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .waves-hint {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .waves-col-labels {
    display: grid;
    grid-template-columns: 90px auto 24px;
    gap: 0.5rem;
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0 0.125rem;
  }

  .waves-col-labels.has-label {
    grid-template-columns: 1fr 90px auto 24px;
  }

  .wave-row {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .wave-row-fields {
    display: grid;
    grid-template-columns: 90px auto 24px;
    gap: 0.5rem;
    align-items: center;
  }

  .wave-row-fields.has-label {
    grid-template-columns: 1fr 90px auto 24px;
  }

  .wave-label-input,
  .wave-supply-input {
    padding: 0.375rem 0.5rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 0.8125rem;
    font-family: inherit;
    width: 100%;
  }

  .wave-label-input:focus,
  .wave-supply-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .wave-window-btn {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.375rem 0.5rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
    color: var(--text-muted);
    white-space: nowrap;
    transition: all var(--transition);
    width: 100%;
    justify-content: space-between;
  }

  .wave-window-btn:hover,
  .wave-window-btn.active {
    border-color: var(--accent);
    color: var(--accent-text);
  }

  .wave-date-summary {
    font-size: 0.6875rem;
    color: var(--accent-text);
  }

  .chevron {
    font-size: 0.5625rem;
    opacity: 0.6;
  }

  .sale-window-fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
    padding: 0.5rem 0.625rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  @media (max-width: 480px) {
    .sale-window-fields {
      grid-template-columns: 1fr;
    }

    .field input[type="datetime-local"] {
      width: 100%;
      min-width: 0;
    }

    .wave-row-fields,
    .wave-row-fields.has-label {
      grid-template-columns: 1fr;
      gap: 0.375rem;
    }

    .waves-col-labels,
    .waves-col-labels.has-label {
      display: none;
    }

    .wave-supply-input {
      max-width: none;
    }
  }

  /* ── Remove buttons ── */
  .remove-btn {
    color: var(--text-muted);
    font-size: 0.75rem;
    transition: color var(--transition);
    line-height: 1;
  }

  .remove-btn:hover {
    color: var(--error);
  }

  .remove-btn--sm {
    font-size: 0.6875rem;
    padding: 0.125rem 0.25rem;
  }

  /* ── Add buttons ── */
  .add-wave-btn {
    align-self: flex-start;
    font-size: 0.8125rem;
    color: var(--accent-text);
    padding: 0.25rem 0;
    transition: opacity var(--transition);
  }

  .add-wave-btn:hover {
    opacity: 0.75;
  }

  .add-tier-btn {
    padding: 0.625rem;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    color: var(--accent-text);
    font-size: 0.875rem;
    transition: all var(--transition);
  }

  .add-tier-btn:hover {
    border-color: var(--accent);
    background: var(--accent-subtle);
  }
</style>
