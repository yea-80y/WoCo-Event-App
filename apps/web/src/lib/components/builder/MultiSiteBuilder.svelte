<script lang="ts">
  import type { Site, SiteEventEntry, TemplateId } from "@woco/shared";
  import { newSiteFromTemplate } from "@woco/shared";
  import { publishSite } from "../../api/sites.js";
  import TemplateTab from "./tabs/TemplateTab.svelte";
  import BrandTab from "./tabs/BrandTab.svelte";
  import PagesTab from "./tabs/PagesTab.svelte";
  import NavTab from "./tabs/NavTab.svelte";
  import EventsTab from "./tabs/EventsTab.svelte";

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function uid(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  const DRAFT_KEY = 'woco:site-draft';
  const EVENTS_KEY = 'woco:site-events-draft';
  const PREVIEW_KEY = 'woco:site-preview';

  function loadDraft(): Site {
    if (typeof window === 'undefined') {
      return newSiteFromTemplate({ siteId: uid(), ownerAddress: '0x0', templateId: 'pub-venue-v1', idGen: uid });
    }
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) {
      try {
        return JSON.parse(raw) as Site;
      } catch { /* fall through */ }
    }
    return newSiteFromTemplate({ siteId: uid(), ownerAddress: '0x0', templateId: 'pub-venue-v1', idGen: uid });
  }

  function loadEventsDraft(): SiteEventEntry[] {
    if (typeof window === 'undefined') return [];
    const raw = localStorage.getItem(EVENTS_KEY);
    if (raw) {
      try { return JSON.parse(raw) as SiteEventEntry[]; } catch {}
    }
    return [];
  }

  // ── State ─────────────────────────────────────────────────────────────────────
  let site = $state<Site>(loadDraft());
  let siteEvents = $state<SiteEventEntry[]>(loadEventsDraft());
  let tab = $state<'template' | 'brand' | 'pages' | 'nav' | 'events'>('brand');

  type PublishState = 'idle' | 'publishing' | 'done' | 'error';
  let publishState = $state<PublishState>('idle');
  let publishError = $state('');

  // Autosave drafts
  $effect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(DRAFT_KEY, JSON.stringify($state.snapshot(site)));
    }
  });

  $effect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(EVENTS_KEY, JSON.stringify($state.snapshot(siteEvents)));
    }
  });

  // ── Actions ───────────────────────────────────────────────────────────────────
  function openPreview() {
    if (typeof window === 'undefined') return;
    localStorage.setItem(PREVIEW_KEY, JSON.stringify({
      site: $state.snapshot(site),
      gatewayUrl: (import.meta as { env?: Record<string, string> }).env?.VITE_GATEWAY_URL ?? 'https://gateway.woco-net.com',
      apiUrl: (import.meta as { env?: Record<string, string> }).env?.VITE_API_URL ?? 'http://localhost:3001',
    }));
    window.open('./multi-site.html', '_blank');
  }

  async function handlePublish() {
    if (publishState === 'publishing') return;
    publishState = 'publishing';
    publishError = '';
    try {
      const res = await publishSite($state.snapshot(site), $state.snapshot(siteEvents));
      if (res.ok) {
        publishState = 'done';
        setTimeout(() => { publishState = 'idle'; }, 4000);
      } else {
        publishError = res.error ?? 'Publish failed';
        publishState = 'error';
        setTimeout(() => { publishState = 'idle'; }, 5000);
      }
    } catch (err) {
      publishError = err instanceof Error ? err.message : 'Publish failed';
      publishState = 'error';
      setTimeout(() => { publishState = 'idle'; }, 5000);
    }
  }

  function resetWithTemplate(templateId: TemplateId) {
    if (!confirm('Replace current draft with template defaults?')) return;
    site = newSiteFromTemplate({ siteId: uid(), ownerAddress: '0x0', templateId, idGen: uid });
    siteEvents = [];
    tab = 'brand';
  }

  type TabId = 'template' | 'brand' | 'pages' | 'nav' | 'events';

  const TABS: { id: TabId; label: string }[] = [
    { id: 'template', label: 'Template' },
    { id: 'brand',    label: 'Brand' },
    { id: 'pages',    label: 'Pages' },
    { id: 'nav',      label: 'Navigation' },
    { id: 'events',   label: 'Events' },
  ];
</script>

<div class="builder">
  <!-- Tab bar -->
  <div class="tab-bar">
    <nav class="tab-nav">
      {#each TABS as t}
        <button
          class="tab-btn"
          class:active={tab === t.id}
          onclick={() => tab = t.id}
        >
          {t.label}
          {#if t.id === 'events' && siteEvents.length > 0}
            <span class="tab-badge">{siteEvents.length}</span>
          {/if}
        </button>
      {/each}
    </nav>

    <div class="tab-bar-right">
      <button class="preview-btn" onclick={openPreview}>
        Preview &#8599;
      </button>
      <button
        class="publish-btn"
        class:publishing={publishState === 'publishing'}
        class:done={publishState === 'done'}
        class:error={publishState === 'error'}
        onclick={handlePublish}
        disabled={publishState === 'publishing'}
      >
        {#if publishState === 'publishing'}
          <span class="pub-spinner"></span>Publishing…
        {:else if publishState === 'done'}
          ✓ Published
        {:else if publishState === 'error'}
          ✗ Failed
        {:else}
          Publish
        {/if}
      </button>
    </div>
  </div>

  {#if publishState === 'error' && publishError}
    <div class="publish-error-bar">
      <span>Publish failed: {publishError}</span>
    </div>
  {/if}

  <!-- Tab content -->
  <div class="tab-content">
    {#if tab === 'template'}
      <TemplateTab
        currentTemplateId={site.templateId}
        onselect={resetWithTemplate}
      />
    {:else if tab === 'brand'}
      <BrandTab bind:site />
    {:else if tab === 'pages'}
      <PagesTab bind:site />
    {:else if tab === 'nav'}
      <NavTab bind:site />
    {:else if tab === 'events'}
      <EventsTab
        siteId={site.siteId}
        {siteEvents}
        onsiteeventschange={(ev) => siteEvents = ev}
      />
    {/if}
  </div>
</div>

<style>
  /* Builder breaks out of App.svelte's 840px max-width */
  .builder {
    margin: 0 -1.25rem;
    min-height: calc(100vh - 10rem);
    display: flex;
    flex-direction: column;
  }

  /* Tab bar */
  .tab-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0 1.5rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elevated);
    position: sticky;
    top: 0;
    z-index: 50;
  }

  .tab-nav {
    display: flex;
    gap: 0;
  }

  .tab-btn {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.75rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text-muted);
    border-bottom: 2px solid transparent;
    transition: color var(--transition), border-color var(--transition);
    white-space: nowrap;
  }

  .tab-btn:hover { color: var(--text); }

  .tab-btn.active {
    color: var(--text);
    border-bottom-color: var(--accent);
    font-weight: 600;
  }

  .tab-badge {
    font-size: 0.6875rem;
    font-weight: 700;
    padding: 0.1em 0.45em;
    background: var(--accent);
    color: #fff;
    border-radius: 9999px;
    line-height: 1.4;
  }

  .tab-bar-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .preview-btn {
    padding: 0.4375rem 0.875rem;
    font-size: 0.8125rem;
    font-weight: 600;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    transition: all var(--transition);
    white-space: nowrap;
  }

  .preview-btn:hover {
    border-color: var(--accent);
    color: var(--text);
  }

  .publish-btn {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.4375rem 0.875rem;
    font-size: 0.8125rem;
    font-weight: 600;
    background: var(--accent);
    color: #fff;
    border-radius: var(--radius-sm);
    transition: background var(--transition), opacity var(--transition);
    white-space: nowrap;
  }

  .publish-btn:hover:not(:disabled) { background: var(--accent-hover); }
  .publish-btn:disabled { opacity: 0.7; cursor: not-allowed; }
  .publish-btn.done { background: #22c55e; }
  .publish-btn.error { background: #ef4444; }

  .pub-spinner {
    width: 0.875rem;
    height: 0.875rem;
    border: 1.5px solid rgba(255,255,255,0.4);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Error bar */
  .publish-error-bar {
    padding: 0.5rem 1.5rem;
    background: color-mix(in srgb, #ef4444 10%, var(--bg));
    border-bottom: 1px solid color-mix(in srgb, #ef4444 30%, transparent);
    font-size: 0.8125rem;
    color: #ef4444;
  }

  /* Tab content */
  .tab-content {
    flex: 1;
    padding: 1.5rem;
    max-width: 1200px;
    width: 100%;
    margin: 0 auto;
    box-sizing: border-box;
  }

  @media (min-width: 640px) {
    .tab-bar { padding: 0 1.75rem; }
    .tab-content { padding: 1.75rem 1.75rem 2rem; }
    .tab-btn { padding: 0.8125rem 1.25rem; }
  }
</style>
