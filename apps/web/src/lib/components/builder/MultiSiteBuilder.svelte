<script lang="ts">
  import type { Site, SiteEventEntry, TemplateId } from "@woco/shared";
  import { newSiteFromTemplate } from "@woco/shared";
  import { publishSite, deploySite, loadSite, getSiteEvents } from "../../api/sites.js";
  import type { MySiteRecord } from './types.js';
  import MySitesScreen from './MySitesScreen.svelte';
  import TemplateTab from "./tabs/TemplateTab.svelte";
  import BrandTab from "./tabs/BrandTab.svelte";
  import PagesTab from "./tabs/PagesTab.svelte";
  import NavTab from "./tabs/NavTab.svelte";
  import EventsTab from "./tabs/EventsTab.svelte";

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function uid(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  const DRAFT_KEY     = 'woco:site-draft';
  const EVENTS_KEY    = 'woco:site-events-draft';
  const PREVIEW_KEY   = 'woco:site-preview';
  const LAST_SITE_KEY = 'woco:last-site-id';
  const FEED_HASH_KEY = 'woco:site-feed-hash';
  const MY_SITES_KEY  = 'woco:my-sites';

  const API_URL     = (import.meta as { env?: Record<string, string> }).env?.VITE_API_URL ?? 'http://localhost:3001';
  const GATEWAY_URL = (import.meta as { env?: Record<string, string> }).env?.VITE_GATEWAY_URL ?? 'https://gateway.woco-net.com';
  const WOCO_APP_URL = (import.meta as { env?: Record<string, string> }).env?.VITE_APP_URL ?? 'https://woco.eth.limo';

  function loadDraft(): Site {
    if (typeof window === 'undefined') {
      return newSiteFromTemplate({ siteId: uid(), ownerAddress: '0x0', templateId: 'pub-venue-v1', idGen: uid });
    }
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) {
      try { return JSON.parse(raw) as Site; } catch { /* fall through */ }
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

  function readMySites(): MySiteRecord[] {
    if (typeof window === 'undefined') return [];
    const raw = localStorage.getItem(MY_SITES_KEY);
    if (raw) {
      try { return JSON.parse(raw) as MySiteRecord[]; } catch {}
    }
    return [];
  }

  function saveMySites(records: MySiteRecord[]) {
    if (typeof window !== 'undefined') {
      localStorage.setItem(MY_SITES_KEY, JSON.stringify(records));
    }
  }

  function upsertSiteRecord(update: Partial<MySiteRecord> & { siteId: string }) {
    const existing = mySites.find((r) => r.siteId === update.siteId);
    let next: MySiteRecord;
    if (existing) {
      next = { ...existing, ...update };
    } else {
      next = {
        accentColor: site.theme.palette.accent,
        brandName: site.theme.brandName || 'Untitled site',
        updatedAt: Date.now(),
        ...update,
      };
    }
    const filtered = mySites.filter((r) => r.siteId !== update.siteId);
    mySites = [next, ...filtered];
    saveMySites(mySites);
  }

  // ── State ─────────────────────────────────────────────────────────────────────
  let site       = $state<Site>(loadDraft());
  let siteEvents = $state<SiteEventEntry[]>(loadEventsDraft());
  let mySites    = $state<MySiteRecord[]>(readMySites());
  let screen     = $state<'my-sites' | 'builder'>('my-sites');
  let tab        = $state<'template' | 'brand' | 'pages' | 'nav' | 'events'>('brand');

  type PublishState = 'idle' | 'publishing' | 'done' | 'error';
  let publishState = $state<PublishState>('idle');
  let publishError = $state('');
  let deployedUrl  = $state('');
  let feedHash     = $state(typeof window !== 'undefined' ? (localStorage.getItem(FEED_HASH_KEY) ?? '') : '');

  let openingId = $state<string | undefined>(undefined); // card spinner

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
      gatewayUrl: GATEWAY_URL,
      apiUrl: API_URL,
      previewEvents: $state.snapshot(siteEvents),
    }));
    window.open('./multi-site.html', '_blank');
  }

  async function handlePublish() {
    if (publishState === 'publishing') return;
    publishState = 'publishing';
    publishError = '';
    deployedUrl = '';
    try {
      const feedRes = await publishSite($state.snapshot(site), $state.snapshot(siteEvents));
      if (!feedRes.ok) {
        publishError = feedRes.error ?? 'Publish failed';
        publishState = 'error';
        setTimeout(() => { publishState = 'idle'; }, 5000);
        return;
      }

      const deployRes = await deploySite(site.siteId, { apiUrl: API_URL, gatewayUrl: GATEWAY_URL, wocoAppUrl: WOCO_APP_URL });
      if (deployRes.ok && deployRes.data) {
        deployedUrl = deployRes.data.siteUrl;
        if (deployRes.data.feedManifestHash) {
          feedHash = deployRes.data.feedManifestHash;
          localStorage.setItem(FEED_HASH_KEY, feedHash);
        }
        localStorage.setItem(LAST_SITE_KEY, site.siteId);

        // Keep My Sites registry up to date
        upsertSiteRecord({
          siteId: site.siteId,
          brandName: site.theme.brandName || 'Untitled site',
          logoSwarmRef: site.theme.logoSwarmRef,
          accentColor: site.theme.palette.accent,
          feedHash: feedHash || deployRes.data.feedManifestHash,
          deployedUrl: deployRes.data.siteUrl,
          publishedAt: Date.now(),
          updatedAt: Date.now(),
        });
      }

      publishState = 'done';
    } catch (err) {
      publishError = err instanceof Error ? err.message : 'Publish failed';
      publishState = 'error';
      setTimeout(() => { publishState = 'idle'; }, 5000);
    }
  }

  /** Open a site from the My Sites registry. Uses localStorage draft if siteId matches, else fetches from Swarm. */
  async function handleOpenSite(rec: MySiteRecord) {
    // If this site is already the current draft, just enter the builder.
    if (site.siteId === rec.siteId) {
      feedHash = rec.feedHash ?? localStorage.getItem(FEED_HASH_KEY) ?? '';
      deployedUrl = rec.deployedUrl ?? '';
      screen = 'builder';
      return;
    }

    openingId = rec.siteId;
    try {
      const [siteRes, eventsRes] = await Promise.all([
        loadSite(rec.siteId),
        getSiteEvents(rec.siteId),
      ]);
      if (siteRes.ok && siteRes.data) {
        site = siteRes.data;
        localStorage.setItem(DRAFT_KEY, JSON.stringify(siteRes.data));
        localStorage.setItem(LAST_SITE_KEY, rec.siteId);
        localStorage.setItem(FEED_HASH_KEY, rec.feedHash ?? '');
        feedHash = rec.feedHash ?? '';
        deployedUrl = rec.deployedUrl ?? '';
        if (eventsRes.ok && eventsRes.data) {
          siteEvents = eventsRes.data.events;
          localStorage.setItem(EVENTS_KEY, JSON.stringify(eventsRes.data.events));
        }
        screen = 'builder';
        tab = 'brand';
      }
    } finally {
      openingId = undefined;
    }
  }

  /** Start a brand-new site from the default template. */
  function handleNewSite() {
    site = newSiteFromTemplate({ siteId: uid(), ownerAddress: '0x0', templateId: 'pub-venue-v1', idGen: uid });
    siteEvents = [];
    deployedUrl = '';
    feedHash = '';
    publishState = 'idle';
    localStorage.removeItem(FEED_HASH_KEY);
    screen = 'builder';
    tab = 'brand';
  }

  /** Advanced: load a site by raw Site ID (for cross-device recovery). */
  async function handleLoadById(id: string) {
    const [siteRes, eventsRes] = await Promise.all([
      loadSite(id),
      getSiteEvents(id),
    ]);
    if (!siteRes.ok || !siteRes.data) {
      throw new Error(siteRes.error ?? 'Site not found');
    }
    site = siteRes.data;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(siteRes.data));
    localStorage.setItem(LAST_SITE_KEY, id);
    if (eventsRes.ok && eventsRes.data) {
      siteEvents = eventsRes.data.events;
      localStorage.setItem(EVENTS_KEY, JSON.stringify(eventsRes.data.events));
    }

    // Add to registry so it shows on My Sites
    upsertSiteRecord({
      siteId: id,
      brandName: siteRes.data.theme?.brandName || 'Loaded site',
      logoSwarmRef: siteRes.data.theme?.logoSwarmRef,
      accentColor: siteRes.data.theme?.palette?.accent ?? '#6366f1',
      updatedAt: Date.now(),
    });

    feedHash = '';
    deployedUrl = '';
    screen = 'builder';
    tab = 'brand';
  }

  function goToMySites() {
    // Refresh the name/logo/accent in the registry from the current draft state
    upsertSiteRecord({
      siteId: site.siteId,
      brandName: site.theme.brandName || 'Untitled site',
      logoSwarmRef: site.theme.logoSwarmRef,
      accentColor: site.theme.palette.accent,
      updatedAt: Date.now(),
    });
    screen = 'my-sites';
    publishState = 'idle';
  }

  function resetWithTemplate(templateId: TemplateId) {
    if (!confirm('Replace current draft with template defaults?')) return;
    site = newSiteFromTemplate({ siteId: uid(), ownerAddress: '0x0', templateId, idGen: uid });
    siteEvents = [];
    deployedUrl = '';
    feedHash = '';
    localStorage.removeItem(FEED_HASH_KEY);
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
  {#if screen === 'my-sites'}
    <MySitesScreen
      sites={mySites}
      gatewayUrl={GATEWAY_URL}
      onopen={handleOpenSite}
      onnew={handleNewSite}
      onloadbyid={handleLoadById}
      loadingId={openingId}
    />

  {:else}
    <!-- Builder header -->
    <div class="tab-bar">
      <div class="tab-bar-left">
        <button class="back-btn" onclick={goToMySites} title="Back to My Sites">
          ← My Sites
        </button>
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
      </div>

      <div class="tab-bar-right">
        <button class="preview-btn" onclick={openPreview}>
          Preview ↗
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
            <span class="pub-spinner" aria-hidden="true"></span>Publishing…
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

    {#if feedHash || deployedUrl}
      <div class="deploy-banner">
        {#if feedHash}
          <div class="deploy-row deploy-row--primary">
            <span class="deploy-label feed-label">Feed hash</span>
            <span class="deploy-siteid">{feedHash}</span>
            <button class="deploy-copy" onclick={() => navigator.clipboard.writeText(feedHash)} title="Copy feed hash">Copy</button>
            <span class="feed-hint">← stable · use this for ENS</span>
          </div>
        {/if}
        {#if deployedUrl}
          <div class="deploy-row">
            <span class="deploy-label">Preview</span>
            <a href={deployedUrl} target="_blank" rel="noopener" class="deploy-url">{deployedUrl}</a>
            <button class="deploy-copy" onclick={() => navigator.clipboard.writeText(deployedUrl)} title="Copy URL">Copy</button>
          </div>
        {/if}
      </div>
    {/if}

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
  {/if}
</div>

<style>
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
    padding: 0 1rem 0 0.5rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elevated);
    position: sticky;
    top: 0;
    z-index: 50;
  }

  .tab-bar-left {
    display: flex;
    align-items: center;
    min-width: 0;
    flex: 1;
  }

  /* Back button */
  .back-btn {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    padding: 0.5rem 0.75rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--muted);
    border-right: 1px solid var(--border);
    margin-right: 0.25rem;
    white-space: nowrap;
    transition: color 150ms ease;
  }

  .back-btn:hover {
    color: var(--text);
  }

  .tab-nav {
    display: flex;
    gap: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .tab-nav::-webkit-scrollbar { display: none; }

  .tab-btn {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.75rem 0.875rem;
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
    flex-shrink: 0;
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

  /* ── Deploy banner ── */
  .deploy-banner {
    display: flex;
    flex-direction: column;
    gap: 0;
    background: color-mix(in srgb, #22c55e 8%, var(--bg));
    border-bottom: 1px solid color-mix(in srgb, #22c55e 25%, transparent);
  }

  .deploy-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.375rem 1.5rem;
    flex-wrap: wrap;
  }

  .deploy-row--primary {
    padding-top: 0.5rem;
    border-bottom: 1px solid color-mix(in srgb, #22c55e 12%, transparent);
  }

  .deploy-row:last-child { padding-bottom: 0.5rem; }

  .deploy-label {
    font-size: 0.8125rem;
    color: #22c55e;
    font-weight: 600;
    white-space: nowrap;
  }

  .feed-label { font-size: 0.8125rem; }

  .feed-hint {
    font-size: 0.75rem;
    color: color-mix(in srgb, #22c55e 70%, var(--text-muted));
    white-space: nowrap;
  }

  .deploy-url {
    font-size: 0.8125rem;
    color: var(--text);
    font-family: monospace;
    word-break: break-all;
    flex: 1;
  }

  .deploy-siteid {
    font-size: 0.75rem;
    font-family: monospace;
    color: var(--text);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .deploy-copy {
    padding: 0.25rem 0.625rem;
    font-size: 0.75rem;
    font-weight: 600;
    background: transparent;
    border: 1px solid color-mix(in srgb, #22c55e 40%, transparent);
    color: #22c55e;
    border-radius: var(--radius-sm);
    white-space: nowrap;
    transition: background var(--transition);
  }

  .deploy-copy:hover {
    background: color-mix(in srgb, #22c55e 12%, transparent);
  }

  /* Publish button */
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

  @keyframes spin { to { transform: rotate(360deg); } }

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
    .tab-bar { padding: 0 1.75rem 0 0.5rem; }
    .tab-content { padding: 1.75rem 1.75rem 2rem; }
    .tab-btn { padding: 0.8125rem 1rem; }
  }
</style>
