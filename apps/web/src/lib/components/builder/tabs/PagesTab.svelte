<script lang="ts">
  import type { Site, Section, SectionType, Page } from "@woco/shared";
  import SectionEditor from "../SectionEditor.svelte";

  interface Props {
    site: Site;
  }

  let { site = $bindable() }: Props = $props();

  // ── State ─────────────────────────────────────────────────────────────────────
  let selectedPageIdx = $state(0);
  let addPageOpen = $state(false);
  let addPageTitle = $state('');
  let showSectionPicker = $state(false);
  let expandedSectionId = $state<string | null>(null);

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function uid(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function slugify(title: string): string {
    return '/' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `page-${uid()}`;
  }

  const selectedPage = $derived(site.pages[selectedPageIdx] ?? site.pages[0]);
  const pi = $derived(site.pages.indexOf(selectedPage));

  // ── Page mutations ────────────────────────────────────────────────────────────
  function addPage() {
    if (!addPageTitle.trim()) return;
    const slug = slugify(addPageTitle.trim());
    site.pages.push({ slug, title: addPageTitle.trim(), sections: [] });
    selectedPageIdx = site.pages.length - 1;
    addPageTitle = '';
    addPageOpen = false;
  }

  function deletePage(idx: number) {
    if (site.pages.length <= 1) return;
    if (!confirm(`Delete "${site.pages[idx].title}"? This cannot be undone.`)) return;
    site.pages.splice(idx, 1);
    if (selectedPageIdx >= site.pages.length) selectedPageIdx = site.pages.length - 1;
  }

  function movePage(idx: number, dir: 1 | -1) {
    const target = idx + dir;
    if (target < 0 || target >= site.pages.length) return;
    const tmp = site.pages[idx];
    site.pages[idx] = site.pages[target];
    site.pages[target] = tmp;
    selectedPageIdx = target;
  }

  // ── Section mutations ─────────────────────────────────────────────────────────
  function createDefaultSection(type: SectionType): Section {
    const id = uid();
    switch (type) {
      case 'hero':         return { id, type, heading: 'New section' };
      case 'richText':     return { id, type, markdown: '' };
      case 'gallery':      return { id, type, images: [] };
      case 'eventsGrid':   return { id, type, mode: 'upcoming' };
      case 'featuredEvent':return { id, type, eventId: '' };
      case 'openingHours': return { id, type, rows: [{ day: 'Mon–Sun', hours: '12:00 – 23:00' }] };
      case 'map':          return { id, type, lat: 51.5074, lng: -0.1278 };
      case 'contactForm':  return { id, type, emailTo: '' };
      case 'embed':        return { id, type, html: '' };
    }
  }

  function addSection(type: SectionType) {
    const sec = createDefaultSection(type);
    site.pages[pi].sections.push(sec);
    expandedSectionId = sec.id;
    showSectionPicker = false;
  }

  function moveSection(i: number, dir: 1 | -1) {
    const target = i + dir;
    const secs = site.pages[pi].sections;
    if (target < 0 || target >= secs.length) return;
    const tmp = secs[i];
    secs[i] = secs[target];
    secs[target] = tmp;
  }

  function dupSection(i: number) {
    const secs = site.pages[pi].sections;
    const copy = JSON.parse(JSON.stringify(secs[i])) as Section;
    copy.id = uid();
    secs.splice(i + 1, 0, copy);
    expandedSectionId = copy.id;
  }

  function deleteSection(i: number) {
    site.pages[pi].sections = site.pages[pi].sections.filter((_, k) => k !== i);
  }

  function patchSection(i: number, patch: Record<string, unknown>) {
    Object.assign(site.pages[pi].sections[i], patch);
  }

  function toggleExpand(id: string) {
    expandedSectionId = expandedSectionId === id ? null : id;
  }

  // ── Section type metadata ─────────────────────────────────────────────────────
  interface SectionTypeMeta {
    type: SectionType;
    icon: string;
    label: string;
    desc: string;
    color: string;
  }

  const SECTION_TYPES: SectionTypeMeta[] = [
    { type: 'hero',          icon: '&#127752;', label: 'Hero banner',    desc: 'Full-width intro with heading + CTA',   color: '#7c6cf0' },
    { type: 'richText',      icon: '&#128196;', label: 'Rich text',      desc: 'Markdown content block',               color: '#5c9e46' },
    { type: 'gallery',       icon: '&#128247;', label: 'Image gallery',  desc: 'Grid of images from Swarm',            color: '#2090c0' },
    { type: 'eventsGrid',    icon: '&#128197;', label: 'Events grid',    desc: 'Grid of upcoming / all events',        color: '#c8860a' },
    { type: 'featuredEvent', icon: '&#11088;',  label: 'Featured event', desc: 'Single highlighted event card',        color: '#d04060' },
    { type: 'openingHours',  icon: '&#128337;', label: 'Opening hours',  desc: 'Weekly schedule table',                color: '#20b896' },
    { type: 'map',           icon: '&#128205;', label: 'Map',            desc: 'Embedded map with pin',                color: '#2090c0' },
    { type: 'contactForm',   icon: '&#128140;', label: 'Contact form',   desc: 'Sends enquiries to your email',        color: '#9c6cf0' },
    { type: 'embed',         icon: '&#128280;', label: 'Embed',          desc: 'Raw HTML embed (iframes etc.)',        color: '#9a8f7c' },
  ];

  function sectionMeta(type: SectionType): SectionTypeMeta {
    return SECTION_TYPES.find(t => t.type === type) ?? SECTION_TYPES[0];
  }

  function sectionSummary(sec: Section): string {
    switch (sec.type) {
      case 'hero':         return sec.heading?.slice(0, 40) ?? '';
      case 'richText':     return sec.markdown?.slice(0, 40) ?? '';
      case 'gallery':      return `${sec.images.length} image${sec.images.length !== 1 ? 's' : ''}`;
      case 'eventsGrid':   return `Mode: ${sec.mode}${sec.max ? `, max ${sec.max}` : ''}`;
      case 'featuredEvent':return sec.eventId ? `Event: ${sec.eventId.slice(0, 20)}` : '(no event set)';
      case 'openingHours': return `${sec.rows.length} row${sec.rows.length !== 1 ? 's' : ''}`;
      case 'map':          return `${sec.lat.toFixed(4)}, ${sec.lng.toFixed(4)}`;
      case 'contactForm':  return sec.emailTo || '(no email set)';
      case 'embed':        return sec.html ? `${sec.html.slice(0, 40)}…` : '(empty)';
    }
  }
</script>

<div class="pages-tab">
  <!-- Left: pages list -->
  <aside class="pages-sidebar">
    <div class="sidebar-header">
      <span class="sidebar-title">Pages</span>
      <button class="btn-icon-sm" onclick={() => { addPageOpen = !addPageOpen; addPageTitle = ''; }} title="Add page">
        &#43;
      </button>
    </div>

    {#if addPageOpen}
      <div class="add-page-form">
        <input
          class="input"
          type="text"
          placeholder="Page title"
          value={addPageTitle}
          oninput={(e) => { addPageTitle = (e.currentTarget as HTMLInputElement).value; }}
          onkeydown={(e) => { if (e.key === 'Enter') addPage(); if (e.key === 'Escape') addPageOpen = false; }}
          autofocus
        />
        <div class="add-page-actions">
          <button class="btn-ghost-sm" onclick={() => addPageOpen = false}>Cancel</button>
          <button class="btn-accent-sm" onclick={addPage} disabled={!addPageTitle.trim()}>Add</button>
        </div>
      </div>
    {/if}

    <ul class="page-list">
      {#each site.pages as page, idx}
        <li class="page-item" class:selected={idx === selectedPageIdx}>
          <button class="page-btn" onclick={() => selectedPageIdx = idx}>
            <span class="page-title">{page.title}</span>
            <span class="page-slug">{page.slug}</span>
          </button>
          <div class="page-actions">
            <button
              class="btn-icon-xs"
              disabled={idx === 0}
              onclick={() => movePage(idx, -1)}
              title="Move up"
            >&#8593;</button>
            <button
              class="btn-icon-xs"
              disabled={idx === site.pages.length - 1}
              onclick={() => movePage(idx, 1)}
              title="Move down"
            >&#8595;</button>
            <button
              class="btn-icon-xs danger"
              disabled={site.pages.length <= 1}
              onclick={() => deletePage(idx)}
              title="Delete page"
            >&#128465;</button>
          </div>
        </li>
      {/each}
    </ul>
  </aside>

  <!-- Right: sections panel -->
  <main class="sections-panel">
    {#if selectedPage}
      <div class="sections-header">
        <h3 class="sections-title">{selectedPage.title}</h3>
        <span class="sections-slug">{selectedPage.slug}</span>
      </div>

      {#if selectedPage.sections.length === 0}
        <div class="empty-sections">
          <p>No sections yet. Add one below.</p>
        </div>
      {:else}
        <div class="section-list">
          {#each selectedPage.sections as sec, i (sec.id)}
            {@const meta = sectionMeta(sec.type)}
            <div class="section-card" class:expanded={expandedSectionId === sec.id}>
              <div class="section-card-header">
                <button class="section-toggle" onclick={() => toggleExpand(sec.id)}>
                  <span class="type-badge" style="background: {meta.color}22; color: {meta.color}; border-color: {meta.color}44">
                    {@html meta.icon} {meta.label}
                  </span>
                  <span class="section-summary">{sectionSummary(sec)}</span>
                  <span class="expand-arrow" class:open={expandedSectionId === sec.id}>&#8250;</span>
                </button>
                <div class="section-controls">
                  <button class="btn-icon-xs" disabled={i === 0} onclick={() => moveSection(i, -1)} title="Move up">&#8593;</button>
                  <button class="btn-icon-xs" disabled={i === selectedPage.sections.length - 1} onclick={() => moveSection(i, 1)} title="Move down">&#8595;</button>
                  <button class="btn-icon-xs" onclick={() => dupSection(i)} title="Duplicate">&#10697;</button>
                  <button class="btn-icon-xs danger" onclick={() => deleteSection(i)} title="Delete">&#128465;</button>
                </div>
              </div>

              {#if expandedSectionId === sec.id}
                <SectionEditor
                  section={sec}
                  onpatch={(patch) => patchSection(i, patch)}
                />
              {/if}
            </div>
          {/each}
        </div>
      {/if}

      <!-- Section picker -->
      {#if showSectionPicker}
        <div class="section-picker">
          <div class="picker-header">
            <span class="picker-title">Choose section type</span>
            <button class="btn-icon-xs" onclick={() => showSectionPicker = false}>&#10005;</button>
          </div>
          <div class="picker-grid">
            {#each SECTION_TYPES as meta}
              <button class="picker-item" onclick={() => addSection(meta.type)}>
                <span class="picker-icon">{@html meta.icon}</span>
                <span class="picker-label">{meta.label}</span>
                <span class="picker-desc">{meta.desc}</span>
              </button>
            {/each}
          </div>
        </div>
      {:else}
        <button class="add-section-btn" onclick={() => showSectionPicker = true}>
          &#43; Add section
        </button>
      {/if}
    {/if}
  </main>
</div>

<style>
  .pages-tab {
    display: grid;
    grid-template-columns: 220px 1fr;
    gap: 1.25rem;
    min-height: 60vh;
  }

  @media (max-width: 767px) {
    .pages-tab {
      grid-template-columns: 1fr;
    }
  }

  /* ── Sidebar ── */
  .pages-sidebar {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    border-right: 1px solid var(--border);
    padding-right: 1.125rem;
  }

  @media (max-width: 767px) {
    .pages-sidebar {
      border-right: none;
      border-bottom: 1px solid var(--border);
      padding-right: 0;
      padding-bottom: 1rem;
    }
  }

  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.25rem;
  }

  .sidebar-title {
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .page-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .page-item {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    border-radius: var(--radius-sm);
    transition: background var(--transition);
  }

  .page-item.selected {
    background: var(--accent-subtle);
  }

  .page-item:hover:not(.selected) {
    background: var(--bg-elevated);
  }

  .page-btn {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.125rem;
    padding: 0.5rem 0.625rem;
    text-align: left;
    min-width: 0;
  }

  .page-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }

  .page-slug {
    font-size: 0.6875rem;
    color: var(--text-muted);
    font-family: monospace;
  }

  .page-actions {
    display: flex;
    gap: 0.125rem;
    flex-shrink: 0;
    padding-right: 0.375rem;
    opacity: 0;
    transition: opacity var(--transition);
  }

  .page-item:hover .page-actions,
  .page-item.selected .page-actions {
    opacity: 1;
  }

  /* ── Add page form ── */
  .add-page-form {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.625rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    margin-bottom: 0.375rem;
  }

  .add-page-actions {
    display: flex;
    gap: 0.375rem;
    justify-content: flex-end;
  }

  /* ── Sections panel ── */
  .sections-panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 0;
  }

  .sections-header {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding-bottom: 0.625rem;
    border-bottom: 1px solid var(--border);
  }

  .sections-title {
    font-size: 1rem;
    font-weight: 700;
    color: var(--text);
    margin: 0;
  }

  .sections-slug {
    font-size: 0.75rem;
    color: var(--text-muted);
    font-family: monospace;
  }

  .empty-sections {
    padding: 2rem;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.875rem;
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
  }

  .section-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* ── Section card ── */
  .section-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--bg-surface);
    transition: border-color var(--transition);
  }

  .section-card.expanded {
    border-color: var(--border-hover);
  }

  .section-card-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.625rem;
  }

  .section-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
    text-align: left;
    min-width: 0;
  }

  .type-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.6875rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.1875rem 0.5rem;
    border: 1px solid;
    border-radius: 9999px;
    flex-shrink: 0;
    white-space: nowrap;
  }

  .section-summary {
    font-size: 0.8125rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .expand-arrow {
    font-size: 1.25rem;
    color: var(--text-muted);
    transition: transform var(--transition);
    flex-shrink: 0;
    line-height: 1;
  }

  .expand-arrow.open {
    transform: rotate(90deg);
  }

  .section-controls {
    display: flex;
    gap: 0.125rem;
    flex-shrink: 0;
  }

  /* ── Section picker ── */
  .section-picker {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    overflow: hidden;
  }

  .picker-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.625rem 0.875rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elevated);
  }

  .picker-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text);
  }

  .picker-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0;
  }

  .picker-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.125rem;
    padding: 0.75rem 0.875rem;
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    text-align: left;
    transition: background var(--transition);
  }

  .picker-item:hover {
    background: var(--bg-elevated);
  }

  .picker-item:nth-child(3n) {
    border-right: none;
  }

  .picker-icon {
    font-size: 1.125rem;
    line-height: 1;
  }

  .picker-label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text);
  }

  .picker-desc {
    font-size: 0.6875rem;
    color: var(--text-muted);
    line-height: 1.3;
  }

  /* ── Add section button ── */
  .add-section-btn {
    padding: 0.625rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    transition: all var(--transition);
    text-align: center;
    width: 100%;
  }

  .add-section-btn:hover {
    border-color: var(--accent);
    color: var(--accent-text);
    border-style: solid;
    background: color-mix(in srgb, var(--accent) 4%, transparent);
  }

  /* ── Shared button micro-styles ── */
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

  .btn-icon-sm {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.625rem;
    height: 1.625rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.875rem;
    color: var(--text-muted);
    transition: all var(--transition);
  }

  .btn-icon-sm:hover {
    border-color: var(--accent);
    color: var(--accent-text);
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

  .btn-ghost-sm {
    padding: 0.3125rem 0.625rem;
    font-size: 0.8125rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    transition: all var(--transition);
  }

  .btn-ghost-sm:hover {
    border-color: var(--border-hover);
    color: var(--text);
  }

  .btn-accent-sm {
    padding: 0.3125rem 0.75rem;
    font-size: 0.8125rem;
    font-weight: 600;
    background: var(--accent);
    color: #fff;
    border-radius: var(--radius-sm);
    transition: background var(--transition);
  }

  .btn-accent-sm:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .btn-accent-sm:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
