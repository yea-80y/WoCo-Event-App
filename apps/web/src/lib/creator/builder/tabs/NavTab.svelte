<script lang="ts">
  import type { Site, NavItem } from "@woco/shared";

  interface Props {
    site: Site;
  }

  let { site = $bindable() }: Props = $props();

  let addLabel = $state('');
  let addSlug = $state('');
  let addFormOpen = $state(false);

  // Pages not yet in nav
  const availablePages = $derived(
    site.pages.filter(p => !site.nav.some(n => n.pageSlug === p.slug))
  );

  function moveNav(i: number, dir: 1 | -1) {
    const target = i + dir;
    if (target < 0 || target >= site.nav.length) return;
    const tmp = site.nav[i];
    site.nav[i] = site.nav[target];
    site.nav[target] = tmp;
  }

  function deleteNav(i: number) {
    site.nav.splice(i, 1);
  }

  function addNavItem() {
    if (!addSlug || !addLabel.trim()) return;
    site.nav.push({ label: addLabel.trim(), pageSlug: addSlug });
    addLabel = '';
    addSlug = '';
    addFormOpen = false;
  }

  function onSlugChange(slug: string) {
    addSlug = slug;
    // Auto-fill label from page title if label is still empty
    if (!addLabel.trim()) {
      const page = site.pages.find(p => p.slug === slug);
      if (page) addLabel = page.title;
    }
  }
</script>

<div class="nav-tab">
  <div class="tab-header">
    <h2>Navigation</h2>
    <p class="tab-desc">Control which pages appear in the top nav bar and in what order.</p>
  </div>

  <div class="nav-list">
    {#each site.nav as item, i}
      <div class="nav-item">
        <div class="nav-item-reorder">
          <button class="btn-icon-xs" disabled={i === 0} onclick={() => moveNav(i, -1)} title="Move up">&#8593;</button>
          <button class="btn-icon-xs" disabled={i === site.nav.length - 1} onclick={() => moveNav(i, 1)} title="Move down">&#8595;</button>
        </div>

        <div class="nav-item-fields">
          <input
            class="input label-input"
            type="text"
            value={item.label}
            placeholder="Nav label"
            oninput={(e) => { site.nav[i].label = (e.currentTarget as HTMLInputElement).value; }}
          />
          <span class="nav-slug">{item.pageSlug}</span>
        </div>

        <button class="btn-icon-xs danger" onclick={() => deleteNav(i)} title="Remove from nav">&#128465;</button>
      </div>
    {/each}

    {#if site.nav.length === 0}
      <div class="empty-nav">No nav items yet. Add pages below.</div>
    {/if}
  </div>

  <!-- Add nav item -->
  {#if addFormOpen}
    <div class="add-form">
      <div class="add-form-row">
        <div class="field">
          <label class="field-label" for="nav-add-page">Page</label>
          <select
            id="nav-add-page"
            class="input select"
            value={addSlug}
            onchange={(e) => onSlugChange((e.currentTarget as HTMLSelectElement).value)}
          >
            <option value="" disabled selected>Select a page…</option>
            {#each availablePages as page}
              <option value={page.slug}>{page.title} ({page.slug})</option>
            {/each}
          </select>
        </div>
        <div class="field">
          <label class="field-label" for="nav-add-label">Label</label>
          <input
            id="nav-add-label"
            class="input"
            type="text"
            placeholder="Nav label"
            value={addLabel}
            oninput={(e) => { addLabel = (e.currentTarget as HTMLInputElement).value; }}
          />
        </div>
      </div>
      <div class="add-form-actions">
        <button class="btn-ghost" onclick={() => { addFormOpen = false; addLabel = ''; addSlug = ''; }}>Cancel</button>
        <button class="btn-primary" onclick={addNavItem} disabled={!addSlug || !addLabel.trim()}>
          Add nav item
        </button>
      </div>
    </div>
  {:else}
    <button
      class="add-btn"
      onclick={() => addFormOpen = true}
      disabled={availablePages.length === 0}
    >
      + Add nav item
      {#if availablePages.length === 0}
        <span class="add-btn-note">(all pages already in nav)</span>
      {/if}
    </button>
  {/if}

  <div class="nav-hint">
    <p>Nav items link to pages in your site. Pages not listed here are still accessible via direct links.</p>
  </div>
</div>

<style>
  .nav-tab {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    max-width: 600px;
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

  .nav-list {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
  }

  .nav-item-reorder {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    flex-shrink: 0;
  }

  .nav-item-fields {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex: 1;
    min-width: 0;
  }

  .label-input {
    flex: 1;
    max-width: 200px;
  }

  .nav-slug {
    font-size: 0.75rem;
    color: var(--text-muted);
    font-family: monospace;
    flex-shrink: 0;
  }

  .empty-nav {
    padding: 1.5rem;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.875rem;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
  }

  /* ── Add form ── */
  .add-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.875rem 1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
  }

  .add-form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }

  @media (max-width: 480px) {
    .add-form-row {
      grid-template-columns: 1fr;
    }
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .field-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .add-form-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }

  .add-btn {
    padding: 0.5625rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    transition: all var(--transition);
    text-align: center;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
  }

  .add-btn:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent-text);
    border-style: solid;
    background: color-mix(in srgb, var(--accent) 4%, transparent);
  }

  .add-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .add-btn-note {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .nav-hint {
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
  }

  .nav-hint p {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }

  /* ── Shared ── */
  .input {
    padding: 0.4375rem 0.625rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 0.875rem;
    font-family: inherit;
    width: 100%;
    box-sizing: border-box;
    transition: border-color var(--transition);
  }

  .input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .select {
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23666'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.75rem center;
    padding-right: 2rem;
    cursor: pointer;
  }

  .btn-icon-xs {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.375rem;
    height: 1.375rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.6875rem;
    color: var(--text-muted);
    transition: all var(--transition);
    flex-shrink: 0;
  }

  .btn-icon-xs:hover:not(:disabled) {
    border-color: var(--border-hover);
    color: var(--text);
  }

  .btn-icon-xs.danger:hover:not(:disabled) {
    border-color: var(--error);
    color: var(--error);
    background: color-mix(in srgb, var(--error) 8%, transparent);
  }

  .btn-icon-xs:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .btn-ghost {
    padding: 0.4375rem 0.875rem;
    font-size: 0.875rem;
    font-weight: 500;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    transition: all var(--transition);
  }

  .btn-ghost:hover {
    border-color: var(--border-hover);
    color: var(--text);
  }

  .btn-primary {
    padding: 0.4375rem 1rem;
    font-size: 0.875rem;
    font-weight: 600;
    background: var(--accent);
    color: #fff;
    border-radius: var(--radius-sm);
    transition: background var(--transition);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .btn-primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
