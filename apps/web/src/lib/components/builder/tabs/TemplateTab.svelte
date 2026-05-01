<script lang="ts">
  import type { TemplateId } from "@woco/shared";
  import { TEMPLATE_CATALOGUE } from "@woco/shared";

  interface Props {
    currentTemplateId: TemplateId;
    onselect: (id: TemplateId) => void;
  }

  let { currentTemplateId, onselect }: Props = $props();
</script>

<div class="template-tab">
  <div class="tab-header">
    <h2>Choose a template</h2>
    <p class="tab-desc">Templates set default pages, sections, and styling. Picking a new template will reset your current draft content.</p>
  </div>

  <div class="template-grid">
    {#each TEMPLATE_CATALOGUE as entry}
      {@const isActive = entry.id === currentTemplateId}
      <button
        class="template-card"
        class:active={isActive}
        onclick={() => onselect(entry.id)}
      >
        <div class="card-header">
          <span class="card-name">{entry.name}</span>
          {#if isActive}
            <span class="active-badge">Active</span>
          {/if}
        </div>
        <p class="card-desc">{entry.description}</p>
        <div class="card-tags">
          {#each entry.bestFor as tag}
            <span class="tag">{tag}</span>
          {/each}
        </div>
      </button>
    {/each}
  </div>

  <p class="reset-note">
    Selecting a template will replace all current pages and sections with template defaults. Brand colours you set on the Brand tab will be preserved.
  </p>
</div>

<style>
  .template-tab {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .tab-header h2 {
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--text);
    margin: 0 0 0.375rem;
  }

  .tab-desc {
    font-size: 0.875rem;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }

  .template-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1rem;
  }

  .template-card {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding: 1.125rem;
    border: 2px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    text-align: left;
    transition: all var(--transition);
    cursor: pointer;
  }

  .template-card:hover {
    border-color: var(--border-hover);
    background: var(--bg-elevated);
  }

  .template-card.active {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 6%, var(--bg-surface));
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .card-name {
    font-size: 1rem;
    font-weight: 700;
    color: var(--text);
  }

  .active-badge {
    font-size: 0.6875rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.125rem 0.5rem;
    background: var(--accent);
    color: #fff;
    border-radius: 9999px;
    flex-shrink: 0;
  }

  .card-desc {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    margin: 0;
    line-height: 1.55;
    flex: 1;
  }

  .card-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin-top: 0.125rem;
  }

  .tag {
    font-size: 0.6875rem;
    font-weight: 500;
    padding: 0.1875rem 0.5rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 9999px;
    color: var(--text-muted);
  }

  .reset-note {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0;
    padding: 0.75rem 1rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    line-height: 1.5;
  }
</style>
