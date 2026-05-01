<script lang="ts">
  import type { Site, TemplateId } from "@woco/shared";
  import { newSiteFromTemplate } from "@woco/shared";
  import TemplateTab from "./tabs/TemplateTab.svelte";
  import BrandTab from "./tabs/BrandTab.svelte";
  import PagesTab from "./tabs/PagesTab.svelte";
  import NavTab from "./tabs/NavTab.svelte";

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function uid(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  const DRAFT_KEY = 'woco:site-draft';
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

  // ── State ─────────────────────────────────────────────────────────────────────
  let site = $state<Site>(loadDraft());
  let tab = $state<'template' | 'brand' | 'pages' | 'nav'>('brand');

  // Autosave to localStorage
  $effect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(DRAFT_KEY, JSON.stringify($state.snapshot(site)));
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

  function resetWithTemplate(templateId: TemplateId) {
    if (!confirm('Replace current draft with template defaults?')) return;
    site = newSiteFromTemplate({ siteId: uid(), ownerAddress: '0x0', templateId, idGen: uid });
    tab = 'brand';
  }

  type TabId = 'template' | 'brand' | 'pages' | 'nav';

  const TABS: { id: TabId; label: string }[] = [
    { id: 'template', label: 'Template' },
    { id: 'brand',    label: 'Brand' },
    { id: 'pages',    label: 'Pages' },
    { id: 'nav',      label: 'Navigation' },
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
        </button>
      {/each}
    </nav>

    <div class="tab-bar-right">
      <button class="preview-btn" onclick={openPreview}>
        Preview &#8599;
      </button>
    </div>
  </div>

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
    padding: 0.75rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text-muted);
    border-bottom: 2px solid transparent;
    transition: color var(--transition), border-color var(--transition);
    white-space: nowrap;
  }

  .tab-btn:hover {
    color: var(--text);
  }

  .tab-btn.active {
    color: var(--text);
    border-bottom-color: var(--accent);
    font-weight: 600;
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
    background: var(--accent);
    color: #fff;
    border-radius: var(--radius-sm);
    transition: background var(--transition);
    white-space: nowrap;
  }

  .preview-btn:hover {
    background: var(--accent-hover);
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
    .tab-bar {
      padding: 0 1.75rem;
    }

    .tab-content {
      padding: 1.75rem 1.75rem 2rem;
    }

    .tab-btn {
      padding: 0.8125rem 1.25rem;
    }
  }
</style>
