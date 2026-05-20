<script lang="ts">
  import type { Site, SiteEventEntry, TemplateId } from "@woco/shared";
  import { newSiteFromTemplate } from "@woco/shared";
  import { onMount } from 'svelte';
  import { publishSite, deploySite, loadSite, getSiteEvents, uploadSiteImage } from "../../api/sites.js";
  import { getMySitesSWR } from "../../api/creator-cache.js";
  import { cacheGet, cacheSet, cacheKey, TTL } from "../../cache/cache.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import type { MySiteRecord } from './types.js';
  import MySitesScreen from './MySitesScreen.svelte';
  import TemplateTab from "./tabs/TemplateTab.svelte";
  import BrandTab from "./tabs/BrandTab.svelte";
  import PagesTab from "./tabs/PagesTab.svelte";
  import NavTab from "./tabs/NavTab.svelte";
  import EventsTab from "./tabs/EventsTab.svelte";
  import GatewayPicker from "./GatewayPicker.svelte";
  import { GATEWAYS } from "./gateways.js";
  import PurchaseBatchModal from "./PurchaseBatchModal.svelte";
  import { getMyEthernaBatch } from "../../api/etherna.js";

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function uid(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  const DRAFT_KEY     = 'woco:site-draft';
  const EVENTS_KEY    = 'woco:site-events-draft';
  const PREVIEW_KEY   = 'woco:site-preview';
  const LAST_SITE_KEY = 'woco:last-site-id';
  const FEED_HASH_KEY = 'woco:site-feed-hash';

  const API_URL     = (import.meta as { env?: Record<string, string> }).env?.VITE_API_URL ?? 'http://localhost:3001';
  const DEFAULT_GATEWAY = GATEWAYS.find((g) => g.default)?.url ?? GATEWAYS[0].url;
  const WOCO_APP_URL = (import.meta as { env?: Record<string, string> }).env?.VITE_APP_URL ?? 'https://woco.eth.limo';

  const ETHERNA_URL = 'https://gateway.etherna.io';

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

  // Sites list is stored in the shared per-address SWR cache
  // (cacheKey.creatorSites(addr)). Keying by address is what prevents the next
  // user on a shared device from briefly seeing the previous user's sites,
  // and auth-store.logout() wipes the prefix via USER_SCOPED_PREFIXES.
  function readMySites(addr: string | null): MySiteRecord[] {
    if (!addr) return [];
    return cacheGet<MySiteRecord[]>(cacheKey.creatorSites(addr.toLowerCase())) ?? [];
  }

  function saveMySites(addr: string | null, records: MySiteRecord[]) {
    if (!addr) return;
    cacheSet(cacheKey.creatorSites(addr.toLowerCase()), records, TTL.CREATOR_SITES);
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
    saveMySites(auth.parent, mySites);
  }

  // ── State ─────────────────────────────────────────────────────────────────────
  let site       = $state<Site>(loadDraft());
  let siteEvents = $state<SiteEventEntry[]>(loadEventsDraft());
  // Initial paint: empty. We only read the per-address cache once auth.parent is
  // known (the auth effect below). Reading at module init time would risk
  // showing whichever address last wrote to localStorage on a shared device.
  let mySites    = $state<MySiteRecord[]>([]);
  let screen     = $state<'my-sites' | 'builder'>('my-sites');
  let tab        = $state<'template' | 'brand' | 'pages' | 'nav' | 'events'>('brand');

  type PublishState = 'idle' | 'publishing' | 'done' | 'error';
  let publishState = $state<PublishState>('idle');
  let publishError = $state('');
  let deployedUrl  = $state('');
  let feedHash     = $state(typeof window !== 'undefined' ? (localStorage.getItem(FEED_HASH_KEY) ?? '') : '');

  let gatewayUrl        = $state(DEFAULT_GATEWAY);
  let purchaseOpen      = $state(false);
  let pendingLogoBase64 = $state<string | null>(null);

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

  // React to identity changes. We track `auth.parent` (not just isConnected) so
  // a same-tab account switch (A → B without an intermediate logout) repaints
  // with the right user's sites instead of B briefly seeing A's data.
  let _prevAddr = $state<string | null>(null);
  $effect(() => {
    const addr = auth.isConnected && auth.parent ? auth.parent.toLowerCase() : null;
    if (addr === _prevAddr) return;
    _prevAddr = addr;

    if (!addr) {
      mySites = [];
      screen = 'builder'; // stay in builder — no auth needed for draft/preview
      return;
    }

    // Logged in (or switched to a new identity). Force EIP-712 before any
    // per-address site list is on screen: cache is keyed by address but its
    // contents are user-private, so painting before the session is signed
    // would skip the boundary that proves wallet control this session.
    (async () => {
      if (!auth.hasSession) {
        const ok = await auth.ensureSession();
        if (!ok || _prevAddr !== addr) return;
      }

      const swr = getMySitesSWR(addr);
      mySites = swr.cached ? [...swr.cached] : [];

      // Refresh from Swarm in the background. On failure the cached view stays.
      const apiSites = await swr.refresh();
      if (_prevAddr !== addr) return;
      if (!apiSites) return;
      const apiIds = new Set(apiSites.map((s) => s.siteId));
      const localOnly = mySites.filter((s) => !apiIds.has(s.siteId));
      mySites = [...apiSites, ...localOnly];
      saveMySites(addr, mySites);
    })();
  });

  // ── Actions ───────────────────────────────────────────────────────────────────
  function openPreview() {
    if (typeof window === 'undefined') return;
    localStorage.setItem(PREVIEW_KEY, JSON.stringify({
      site: $state.snapshot(site),
      gatewayUrl,
      apiUrl: API_URL,
      previewEvents: $state.snapshot(siteEvents),
      previewLogoDataUrl: pendingLogoBase64 ?? undefined,
    }));
    window.open('./multi-site.html?preview=1', '_blank');
  }

  /** Etherna website publish requires a per-user batch. Returns true if the
   * batch exists OR the user just bought one in the modal; false if cancelled.
   * Throws on lookup errors (auth/network/server) so they surface as a publish
   * failure instead of being mistaken for "no batch yet" and silently opening
   * the purchase modal. */
  async function ensureUserBatchForEtherna(): Promise<boolean> {
    if (gatewayUrl !== ETHERNA_URL) return true;
    const res = await getMyEthernaBatch();
    if (!res.ok) throw new Error(res.error || 'Could not check Etherna batch');
    if (res.data) return true;
    purchaseOpen = true;
    return await new Promise<boolean>((resolve) => {
      pendingPurchaseResolve = resolve;
    });
  }

  let pendingPurchaseResolve: ((ok: boolean) => void) | null = $state(null);

  function handlePurchaseClose() {
    purchaseOpen = false;
    pendingPurchaseResolve?.(false);
    pendingPurchaseResolve = null;
  }

  function handlePurchased() {
    purchaseOpen = false;
    pendingPurchaseResolve?.(true);
    pendingPurchaseResolve = null;
  }

  async function handlePublish() {
    if (publishState === 'publishing') return;

    if (!auth.isConnected) {
      const ok = await loginRequest.request();
      if (!ok) return;
    }
    if (!auth.hasSession) {
      const ok = await auth.ensureSession();
      if (!ok) return;
    }

    publishState = 'publishing';
    publishError = '';
    deployedUrl = '';

    try {
      const batchOk = await ensureUserBatchForEtherna();
      if (!batchOk) {
        // User cancelled the purchase modal — not an error, just a no-op.
        publishState = 'idle';
        return;
      }

      if (pendingLogoBase64) {
        const imgRes = await uploadSiteImage(pendingLogoBase64, gatewayUrl);
        if (!imgRes.ok) throw new Error(imgRes.error ?? 'Logo upload failed');
        site.theme.logoSwarmRef = imgRes.data!.imageRef;
        pendingLogoBase64 = null;
      }

      const feedRes = await publishSite($state.snapshot(site), $state.snapshot(siteEvents));
      if (!feedRes.ok) throw new Error(feedRes.error ?? 'Publish failed');

      const deployRes = await deploySite(site.siteId, { apiUrl: API_URL, gatewayUrl, wocoAppUrl: WOCO_APP_URL, site: $state.snapshot(site) });
      if (!deployRes.ok || !deployRes.data) {
        throw new Error(deployRes.ok ? 'Deploy returned no data' : (deployRes.error ?? 'Deploy failed'));
      }

      deployedUrl = deployRes.data.siteUrl;
      if (deployRes.data.feedManifestHash) {
        feedHash = deployRes.data.feedManifestHash;
        localStorage.setItem(FEED_HASH_KEY, feedHash);
      }
      localStorage.setItem(LAST_SITE_KEY, site.siteId);

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

      publishState = 'done';
    } catch (err) {
      publishError = err instanceof Error ? err.message : 'Publish failed';
      publishState = 'error';
      setTimeout(() => {
        // Only auto-clear if still showing this same error — don't clobber
        // a subsequent publish the user already started.
        if (publishState === 'error') publishState = 'idle';
      }, 5000);
    }
  }

  /** Open a site from the My Sites registry. Always fetches latest from Swarm. */
  async function handleOpenSite(rec: MySiteRecord) {
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

  /** Start a brand-new site — open template picker so user chooses style first. */
  function handleNewSite() {
    site = newSiteFromTemplate({ siteId: uid(), ownerAddress: '0x0', templateId: 'pub-venue-v1', idGen: uid });
    siteEvents = [];
    deployedUrl = '';
    feedHash = '';
    publishState = 'idle';
    localStorage.removeItem(FEED_HASH_KEY);
    screen = 'builder';
    tab = 'template'; // show template picker first on new sites
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
  {#if !auth.ready}
    <!-- Auth restoring from IndexedDB — avoid flashing the sign-in screen -->
    <div class="auth-loading" aria-label="Loading…"></div>

  {:else if screen === 'my-sites'}
    <MySitesScreen
      sites={mySites}
      gatewayUrl={gatewayUrl}
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
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M9 2L4 7l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="back-label">Sites</span>
        </button>

        <!-- Desktop: horizontal tab pills -->
        <nav class="tab-nav" aria-label="Builder sections">
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

        <!-- Mobile: select dropdown -->
        <select
          class="tab-select-mobile"
          value={tab}
          onchange={(e) => { tab = (e.currentTarget as HTMLSelectElement).value as typeof tab; }}
          aria-label="Current section"
        >
          {#each TABS as t}
            <option value={t.id}>{t.label}{t.id === 'events' && siteEvents.length > 0 ? ` (${siteEvents.length})` : ''}</option>
          {/each}
        </select>
      </div>

      <div class="tab-bar-right">
        <button class="preview-btn" onclick={openPreview} title="Open preview in new tab">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M6 2H2v10h10V8M9 2h3v3M8 6l4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="preview-label">Preview</span>
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
            <span class="pub-spinner" aria-hidden="true"></span><span class="pub-label">Publishing…</span>
          {:else if publishState === 'done'}
            ✓ <span class="pub-label">Published</span>
          {:else if publishState === 'error'}
            ✗ <span class="pub-label">Failed</span>
          {:else}
            <span class="pub-label">Publish</span>
          {/if}
        </button>
      </div>
    </div>

    <div class="gateway-row">
      <label class="gateway-label" for="ms-gw-picker">Deploy gateway</label>
      <div class="gateway-input"><GatewayPicker bind:value={gatewayUrl} /></div>
      <span class="gateway-hint">
        {gatewayUrl === ETHERNA_URL
          ? 'Etherna serves your site — uses your batch'
          : 'Testing only — uses platform WoCo batch'}
      </span>
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
        <BrandTab bind:site bind:pendingLogoBase64 {gatewayUrl} />
      {:else if tab === 'pages'}
        <PagesTab bind:site {gatewayUrl} />
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

<PurchaseBatchModal
  open={purchaseOpen}
  onclose={handlePurchaseClose}
  onpurchased={handlePurchased}
/>

<style>
  .builder {
    margin: 0 -1.25rem;
    min-height: calc(100vh - 10rem);
    display: flex;
    flex-direction: column;
  }

  /* ── Auth loading ── */
  .auth-loading {
    flex: 1;
    min-height: 12rem;
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
    gap: 0.3rem;
    padding: 0.5rem 0.625rem 0.5rem 0.5rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--muted);
    border-right: 1px solid var(--border);
    margin-right: 0.25rem;
    white-space: nowrap;
    transition: color 150ms ease;
  }

  .back-btn:hover { color: var(--text); }

  .tab-nav {
    display: flex;
    gap: 0;
    overflow-x: auto;
    scrollbar-width: none;
    /* Fade hint on right edge to suggest scrollability */
    -webkit-mask-image: linear-gradient(to right, black calc(100% - 24px), transparent 100%);
    mask-image: linear-gradient(to right, black calc(100% - 24px), transparent 100%);
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

  /* Mobile tab select — hidden on desktop, shown on mobile */
  .tab-select-mobile {
    display: none; /* toggled to flex via media query */
    padding: 0.4rem 2rem 0.4rem 0.625rem;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text);
    background: var(--bg-elevated);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5l3.5 3 3.5-3' stroke='%23888' stroke-width='1.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.5rem center;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    -webkit-appearance: none;
    appearance: none;
    outline: none;
    cursor: pointer;
    color-scheme: dark;
  }
  .tab-select-mobile:focus {
    border-color: var(--accent);
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
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.4375rem 0.75rem;
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

  /* ── Gateway row ── */
  .gateway-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 1.5rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
    flex-wrap: wrap;
  }
  .gateway-label {
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .gateway-input { min-width: 16rem; flex: 0 1 18rem; }
  .gateway-hint { font-size: 0.75rem; color: var(--text-muted); }

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

  /* Mobile: swap tab nav for select, compress actions */
  @media (max-width: 639px) {
    .tab-nav { display: none; }
    .tab-select-mobile { display: flex; flex: 1; min-width: 0; max-width: 180px; }
    .preview-label { display: none; }
    .preview-btn {
      padding: 0.4375rem 0.5rem;
      gap: 0;
    }
    .pub-label { display: none; }
    .publish-btn {
      padding: 0.4375rem 0.625rem;
      min-width: 2.25rem;
      justify-content: center;
    }
    .tab-bar { padding: 0 0.5rem; gap: 0.375rem; }
    .tab-bar-right { gap: 0.375rem; }
    .back-label { display: none; }
    .back-btn {
      padding: 0.5rem 0.625rem;
      margin-right: 0;
    }
  }

  @media (min-width: 640px) {
    .tab-bar { padding: 0 1.75rem 0 0.5rem; }
    .tab-content { padding: 1.75rem 1.75rem 2rem; }
    .tab-btn { padding: 0.8125rem 1rem; }
  }
</style>
