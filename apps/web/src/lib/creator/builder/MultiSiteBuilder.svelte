<script lang="ts">
  import type { Site, SiteEventEntry, TemplateId } from "@woco/shared";
  import { newSiteFromTemplate, siteConfigTopic } from "@woco/shared";
  import { logFeedToManifest } from "../../manifest/feed-log.js";
  import { onMount } from 'svelte';
  import { publishSite, deploySite, loadSite, getSiteEvents, uploadSiteImage } from "../../api/sites.js";
  import { getMySitesSWR } from "../../api/creator-cache.js";
  import { cacheGet, cacheSet, cacheKey, TTL } from "../../cache/cache.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import type { MySiteRecord } from './types.js';
  import MySitesScreen from './MySitesScreen.svelte';
  import LivePreviewPane from './LivePreviewPane.svelte';
  import TemplateTab from "./tabs/TemplateTab.svelte";
  import BrandTab from "./tabs/BrandTab.svelte";
  import PagesTab from "./tabs/PagesTab.svelte";
  import NavTab from "./tabs/NavTab.svelte";
  import EventsTab from "./tabs/EventsTab.svelte";
  import ShopTab from "./tabs/ShopTab.svelte";
  import GatewayPicker from "./GatewayPicker.svelte";
  import { GATEWAYS } from "./gateways.js";
  import PurchaseBatchModal from "./PurchaseBatchModal.svelte";
  import DomainLinker from "./DomainLinker.svelte";
  import DomainTab from "./DomainTab.svelte";
  import SubENSPicker from "./SubENSPicker.svelte";
  import StripeConnectModal from "../dashboard/StripeConnectModal.svelte";
  import { getStripeAccountStatus } from "../../api/stripe.js";

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
  let tab        = $state<'template' | 'brand' | 'pages' | 'nav' | 'events' | 'shop' | 'domain'>('brand');

  type PublishState = 'idle' | 'publishing' | 'done' | 'error';
  let publishState = $state<PublishState>('idle');
  let publishError = $state('');
  let deployedUrl       = $state('');
  let deployedHash      = $state(
    typeof window !== 'undefined'
      ? (localStorage.getItem(`woco:site-content-hash:${localStorage.getItem(LAST_SITE_KEY) ?? ''}`) ?? '')
      : ''
  );
  let feedHash          = $state(typeof window !== 'undefined' ? (localStorage.getItem(FEED_HASH_KEY) ?? '') : '');

  let gatewayUrl        = $state(DEFAULT_GATEWAY);
  let purchaseOpen      = $state(false);
  let pendingLogoBase64 = $state<string | null>(null);

  let openingId = $state<string | undefined>(undefined); // card spinner
  let openError = $state(''); // surfaced when a draft can't be opened

  // Stripe status — fetched lazily when domain tab opens; passed to SubENSPicker
  let stripeConnected = $state<boolean | undefined>(undefined);
  let stripeModalOpen = $state(false);
  let _stripeChecked  = $state(false);

  // Fetch stripe status once when domain tab is opened and user is logged in
  $effect(() => {
    if (tab !== 'domain' || !auth.isConnected || _stripeChecked) return;
    _stripeChecked = true;
    getStripeAccountStatus().then((s) => {
      stripeConnected = !!(s.ok && s.onboardingComplete);
    }).catch(() => { stripeConnected = false; });
  });

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
  // Latest snapshot served to the preview tab on demand. The preview tab pulls
  // via a `woco-preview-request` handshake (see onMount below) — this removes
  // the timing-sensitive broadcast that races slow bundle loads on cold cache.
  let lastPreviewData: string | null = null;

  function buildPreviewData(): string {
    return JSON.stringify({
      site: $state.snapshot(site),
      gatewayUrl,
      apiUrl: API_URL,
      previewEvents: $state.snapshot(siteEvents),
      previewLogoDataUrl: pendingLogoBase64 ?? undefined,
    });
  }

  function openPreview() {
    if (typeof window === 'undefined') return;
    const data = buildPreviewData();
    lastPreviewData = data;
    // localStorage fast-path (same-origin only; can quota-fail with large logo base64).
    try {
      localStorage.setItem(PREVIEW_KEY, data);
      localStorage.setItem('woco:preview-timestamp', String(Date.now()));
    } catch {}
    window.open('./multi-site.html', '_blank');
    // No timed postMessage — preview tab requests on ready (handler in onMount).
  }

  // Reply to handshake requests from any preview surface this builder owns —
  // the full-tab preview it opened AND the inline canvas iframe. Falls back to
  // a fresh snapshot so a request can never arrive "too early".
  onMount(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type !== 'woco-preview-request') return;
      if (!e.source) return;
      const data = lastPreviewData ?? buildPreviewData();
      (e.source as Window).postMessage({ type: 'woco-preview', data }, '*');
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  });

  // ── Live canvas ───────────────────────────────────────────────────────────────
  // Debounced snapshot pushed to the inline preview iframe on every edit. The
  // synchronous buildPreviewData() call is what establishes deep reactivity on
  // the whole draft; only the assignment is deferred.
  let previewData = $state('');
  let mobilePreviewOpen = $state(false);
  let canvasWide = $state(false);
  let tabBarH = $state(46); // measured — the sticky canvas sits exactly below it

  const CANVAS_COLLAPSED_KEY = 'woco:builder-canvas-collapsed';
  let canvasCollapsed = $state(
    typeof window !== 'undefined' && localStorage.getItem(CANVAS_COLLAPSED_KEY) === '1'
  );
  function setCanvasCollapsed(v: boolean): void {
    canvasCollapsed = v;
    try { localStorage.setItem(CANVAS_COLLAPSED_KEY, v ? '1' : '0'); } catch { /* quota */ }
  }

  $effect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(min-width: 1100px)');
    canvasWide = mq.matches;
    const onchange = (e: MediaQueryListEvent) => { canvasWide = e.matches; };
    mq.addEventListener('change', onchange);
    return () => mq.removeEventListener('change', onchange);
  });

  $effect(() => {
    if (screen !== 'builder') return;
    const snap = buildPreviewData();
    const t = setTimeout(() => {
      previewData = snap;
      lastPreviewData = snap;
    }, 180);
    return () => clearTimeout(t);
  });

  /** Sentinel errors for the gates the SERVER may raise on a deploy. The client
   * never pre-decides: with free hosting on, most publishes need no batch at
   * all, so the old "check batch, open the purchase modal first" flow blocked
   * users the server was happy to host for free. */
  class BatchPurchaseNeeded extends Error {}
  class StripeVerificationNeeded extends Error {}

  /** Open the batch purchase modal; resolves true once purchased, false if closed. */
  function requestBatchPurchase(): Promise<boolean> {
    purchaseOpen = true;
    return new Promise<boolean>((resolve) => {
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

    /** Logo upload → publish config/feeds → deploy. Throws the sentinel errors
     * above when the server raises a gate, so the outer flow can react (open
     * the right modal) and retry. */
    const publishSequence = async () => {
      if (pendingLogoBase64) {
        const imgRes = await uploadSiteImage(pendingLogoBase64, gatewayUrl);
        if (!imgRes.ok) {
          if (imgRes.code === 'BATCH_PURCHASE_REQUIRED') throw new BatchPurchaseNeeded();
          if (imgRes.code === 'STRIPE_VERIFICATION_REQUIRED') throw new StripeVerificationNeeded(imgRes.error);
          throw new Error(imgRes.error ?? 'Logo upload failed');
        }
        site.theme.logoSwarmRef = imgRes.data!.imageRef;
        pendingLogoBase64 = null;
      }

      // Phase B: with a content-feed signer the site config becomes a
      // CLIENT-OWNED SOC (null → legacy platform-written path).
      const feedSigner = await auth.getContentFeedSigner();
      const feedRes = await publishSite($state.snapshot(site), $state.snapshot(siteEvents), feedSigner, gatewayUrl);
      if (!feedRes.ok) throw new Error(feedRes.error ?? 'Publish failed');

      const deployRes = await deploySite(site.siteId, { apiUrl: API_URL, gatewayUrl, wocoAppUrl: WOCO_APP_URL, site: $state.snapshot(site) }, feedSigner);
      if (!deployRes.ok || !deployRes.data) {
        if (deployRes.code === 'BATCH_PURCHASE_REQUIRED') throw new BatchPurchaseNeeded();
        if (deployRes.code === 'STRIPE_VERIFICATION_REQUIRED') throw new StripeVerificationNeeded(deployRes.error);
        throw new Error(deployRes.ok ? 'Deploy returned no data' : (deployRes.error ?? 'Deploy failed'));
      }
      return deployRes.data;
    };

    try {
      let deployed;
      try {
        deployed = await publishSequence();
      } catch (err) {
        if (err instanceof BatchPurchaseNeeded) {
          const purchased = await requestBatchPurchase();
          if (!purchased) {
            // User cancelled the purchase modal — not an error, just a no-op.
            publishState = 'idle';
            return;
          }
          deployed = await publishSequence();
        } else if (err instanceof StripeVerificationNeeded) {
          // Free hosting needs a verified Stripe account — open the connect
          // modal; the user verifies there and publishes again.
          stripeModalOpen = true;
          throw new Error(err.message || 'Free hosting requires a verified Stripe account.');
        } else {
          throw err;
        }
      }

      deployedUrl  = deployed.siteUrl;
      deployedHash = deployed.contentHash;
      localStorage.setItem(`woco:site-content-hash:${site.siteId}`, deployedHash);
      if (deployed.feedManifestHash) {
        feedHash = deployed.feedManifestHash;
        localStorage.setItem(FEED_HASH_KEY, feedHash);
      }
      localStorage.setItem(LAST_SITE_KEY, site.siteId);

      upsertSiteRecord({
        siteId: site.siteId,
        brandName: site.theme.brandName || 'Untitled site',
        logoSwarmRef: site.theme.logoSwarmRef,
        accentColor: site.theme.palette.accent,
        feedHash: feedHash || deployed.feedManifestHash,
        deployedUrl: deployed.siteUrl,
        publishedAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Refresh the instant-open copy — what was just published IS the latest.
      cacheSet(cacheKey.siteConfig(site.siteId), $state.snapshot(site), TTL.SITE_CONFIG);
      cacheSet(cacheKey.siteEventsIndex(site.siteId), $state.snapshot(siteEvents), TTL.SITE_CONFIG);

      // Manifest feed log (fire-and-forget; no-op without a feed signer). The
      // superseded deploy's contentHash is displaced → trash by the merge.
      void logFeedToManifest({
        kind: "site",
        topic: siteConfigTopic(site.siteId),
        label: site.theme.brandName || 'Untitled site',
        siteMeta: {
          contentHash: deployed.contentHash,
          ...(deployed.feedManifestHash ? { feedManifestHash: deployed.feedManifestHash } : {}),
        },
        target: gatewayUrl.includes("woco-net.com") ? "woco" : "etherna",
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

  /** The on-device draft (single slot), or null. A never-published site only
   *  exists here — there's nothing on Swarm to load. */
  function localDraftFor(siteId: string): Site | null {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return null;
      const draft = JSON.parse(raw) as Site;
      return draft?.siteId === siteId ? draft : null;
    } catch { return null; }
  }

  /** Enter the builder with a loaded site + events, stamping all the per-site
   *  localStorage anchors the rest of the flow relies on. */
  function enterBuilder(rec: MySiteRecord, loaded: Site, events: SiteEventEntry[] | null) {
    site = loaded;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(loaded));
    localStorage.setItem(LAST_SITE_KEY, rec.siteId);
    localStorage.setItem(FEED_HASH_KEY, rec.feedHash ?? '');
    feedHash = rec.feedHash ?? '';
    deployedUrl = rec.deployedUrl ?? '';
    deployedHash =
      localStorage.getItem(`woco:site-content-hash:${rec.siteId}`) ??
      (rec.deployedUrl ?? '').match(/\/bzz\/([a-f0-9]{64})\//)?.[1] ??
      '';
    if (events) {
      siteEvents = events;
      localStorage.setItem(EVENTS_KEY, JSON.stringify(events));
    }
    screen = 'builder';
    tab = 'brand';
  }

  /** Open a site from the My Sites registry.
   *
   *  Fast path: a locally known copy (instant-open cache from a previous open/
   *  publish, or the on-device draft) opens the builder IMMEDIATELY; the
   *  published copy is fetched in the background and swapped in only while the
   *  user hasn't edited yet — an edit made in those first seconds always wins.
   *
   *  Slow path (first open on this device): blocking fetch with card spinner. */
  async function handleOpenSite(rec: MySiteRecord) {
    openError = '';
    const cachedSite =
      cacheGet<Site>(cacheKey.siteConfig(rec.siteId)) ?? localDraftFor(rec.siteId);

    if (cachedSite) {
      const cachedEvents =
        cacheGet<SiteEventEntry[]>(cacheKey.siteEventsIndex(rec.siteId)) ?? loadEventsDraft();
      enterBuilder(rec, cachedSite, cachedEvents);
      const openedSite = JSON.stringify($state.snapshot(site));
      const openedEvents = JSON.stringify($state.snapshot(siteEvents));

      void (async () => {
        const [siteRes, eventsRes] = await Promise.all([
          loadSite(rec.siteId),
          getSiteEvents(rec.siteId),
        ]);
        if (siteRes.ok && siteRes.data) {
          cacheSet(cacheKey.siteConfig(rec.siteId), siteRes.data, TTL.SITE_CONFIG);
          if (
            site.siteId === rec.siteId && screen === 'builder' &&
            JSON.stringify($state.snapshot(site)) === openedSite
          ) {
            site = siteRes.data;
            localStorage.setItem(DRAFT_KEY, JSON.stringify(siteRes.data));
          }
        }
        if (eventsRes.ok && eventsRes.data) {
          cacheSet(cacheKey.siteEventsIndex(rec.siteId), eventsRes.data.events, TTL.SITE_CONFIG);
          if (
            site.siteId === rec.siteId && screen === 'builder' &&
            JSON.stringify($state.snapshot(siteEvents)) === openedEvents
          ) {
            siteEvents = eventsRes.data.events;
            localStorage.setItem(EVENTS_KEY, JSON.stringify(eventsRes.data.events));
          }
        }
      })();
      return;
    }

    openingId = rec.siteId;
    try {
      const [siteRes, eventsRes] = await Promise.all([
        loadSite(rec.siteId),
        getSiteEvents(rec.siteId),
      ]);

      const loaded = (siteRes.ok && siteRes.data) ? siteRes.data : null;
      if (!loaded) {
        openError = `“${rec.brandName}” hasn't been published yet and isn't saved on this device. Open it on the device where you created it, or start a new site.`;
        return;
      }
      cacheSet(cacheKey.siteConfig(rec.siteId), loaded, TTL.SITE_CONFIG);
      const events = (eventsRes.ok && eventsRes.data) ? eventsRes.data.events : null;
      if (events) cacheSet(cacheKey.siteEventsIndex(rec.siteId), events, TTL.SITE_CONFIG);
      enterBuilder(rec, loaded, events);
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
    cacheSet(cacheKey.siteConfig(id), siteRes.data, TTL.SITE_CONFIG);
    if (eventsRes.ok && eventsRes.data) {
      siteEvents = eventsRes.data.events;
      localStorage.setItem(EVENTS_KEY, JSON.stringify(eventsRes.data.events));
      cacheSet(cacheKey.siteEventsIndex(id), eventsRes.data.events, TTL.SITE_CONFIG);
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

  type TabId = 'template' | 'brand' | 'pages' | 'nav' | 'events' | 'shop' | 'domain';

  const TABS: { id: TabId; label: string }[] = [
    { id: 'template', label: 'Template' },
    { id: 'brand',    label: 'Brand' },
    { id: 'pages',    label: 'Pages' },
    { id: 'nav',      label: 'Navigation' },
    { id: 'events',   label: 'Events' },
    { id: 'shop',     label: 'Shop' },
    { id: 'domain',   label: 'Domain' },
  ];

  // Per-site shopId — persisted in localStorage so it survives page reloads.
  let siteShopId = $state<string | null>(
    typeof window !== 'undefined' ? (localStorage.getItem(`woco:site-shopid:${loadDraft().siteId}`) ?? null) : null,
  );
  $effect(() => {
    if (typeof window === 'undefined') return;
    if (siteShopId) localStorage.setItem(`woco:site-shopid:${site.siteId}`, siteShopId);
  });
</script>

<div class="builder" class:canvas-collapsed={canvasCollapsed}>
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
      error={openError}
    />

  {:else}
    <!-- Builder header -->
    <div class="tab-bar" bind:clientHeight={tabBarH}>
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
        <button
          class="preview-btn"
          onclick={() => { if (canvasWide) openPreview(); else mobilePreviewOpen = true; }}
          title="Draft preview — only visible to you. Publish to get a shareable link."
        >
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

    <div class="editor-split">
    <div class="editor-rail">
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
          published={!!feedHash || publishState === 'done'}
          onsiteeventschange={(ev) => siteEvents = ev}
        />
      {:else if tab === 'shop'}
        <ShopTab
          siteId={site.siteId}
          shopId={siteShopId}
          onshopchange={(id) => { siteShopId = id; }}
        />
      {:else if tab === 'domain'}
        <SubENSPicker
          bind:claimedLabel={site.subEnsLabel}
          deployedHash={deployedHash}
          onclaim={(label) => { site.subEnsLabel = label; }}
          stripeConnected={stripeConnected}
          onstripesetup={() => { stripeModalOpen = true; }}
        />
        <DomainTab feedHash={feedHash} onpublish={handlePublish}>
          <DomainLinker
            siteId={site.siteId}
            contentHash={deployedHash}
            feedManifestHash={feedHash}
          />
        </DomainTab>
      {/if}
    </div>
    </div>

    {#if canvasWide && !canvasCollapsed}
      <div class="editor-canvas" style="top: {tabBarH}px; height: calc(100vh - {tabBarH}px);">
        <LivePreviewPane
          data={previewData}
          onopenfull={openPreview}
          onminimize={() => setCanvasCollapsed(true)}
        />
      </div>
    {/if}
    </div>

    {#if canvasWide && canvasCollapsed}
      <button class="canvas-restore" onclick={() => setCanvasCollapsed(false)} title="Show live preview">
        <span class="restore-dot" aria-hidden="true"></span>
        <span class="restore-label">Live preview</span>
      </button>
    {/if}
  {/if}
</div>

{#if mobilePreviewOpen && screen === 'builder'}
  <LivePreviewPane
    overlay
    data={previewData}
    onclose={() => (mobilePreviewOpen = false)}
    onopenfull={openPreview}
  />
{/if}

<PurchaseBatchModal
  open={purchaseOpen}
  onclose={handlePurchaseClose}
  onpurchased={handlePurchased}
/>

<StripeConnectModal
  bind:open={stripeModalOpen}
  onconnected={() => { stripeConnected = true; stripeModalOpen = false; }}
  onclose={() => { stripeModalOpen = false; }}
/>

<style>
  .builder {
    margin: 0 -1.25rem;
    min-height: calc(100vh - 10rem);
    display: flex;
    flex-direction: column;
  }

  /* ── Editor split: controls rail + live canvas ── */
  .editor-split {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .editor-rail {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .editor-canvas {
    display: none;
  }

  @media (min-width: 1100px) {
    /* Break out of the 840px shell — a split editor needs the whole viewport.
       The 100vw overshoot (scrollbar width) is clipped via body overflow.
       With the canvas collapsed the split is gone, so the builder returns to
       the centred shell instead of stretching a lone rail across the screen. */
    .builder:not(.canvas-collapsed) {
      margin-left: calc(50% - 50vw);
      margin-right: calc(50% - 50vw);
    }

    :global(body:has(.builder)) {
      overflow-x: clip;
    }

    .editor-split {
      flex-direction: row;
      align-items: stretch;
    }

    .builder:not(.canvas-collapsed) .editor-rail {
      flex: 0 0 31rem;
      max-width: 31rem;
      border-right: 1px solid var(--border);
    }

    .editor-canvas {
      display: block;
      flex: 1;
      min-width: 0;
      position: sticky; /* top/height inline — measured from the tab bar */
    }
  }

  /* Edge tab that restores the collapsed live canvas. */
  .canvas-restore {
    position: fixed;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
    z-index: 40;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.4375rem;
    padding: 0.75rem 0.375rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-right: 0;
    border-radius: var(--radius-sm) 0 0 var(--radius-sm);
    transition: all var(--transition);
  }

  .canvas-restore:hover {
    background: var(--accent-subtle);
    border-color: var(--border-hover);
  }

  .restore-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }

  .restore-label {
    writing-mode: vertical-rl;
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .canvas-restore:hover .restore-label {
    color: var(--text);
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

  /* Tab content — a named container so tabs (PagesTab) can adapt to the rail's
     width, not the viewport's. */
  .tab-content {
    flex: 1;
    padding: 1.5rem;
    max-width: 1200px;
    width: 100%;
    margin: 0 auto;
    box-sizing: border-box;
    container: builder-rail / inline-size;
  }

  /* Mobile: two-row tab bar — nav controls on row 1, action buttons on row 2 */
  @media (max-width: 639px) {
    .tab-bar {
      flex-wrap: wrap;
      padding: 0;
      gap: 0;
      border-bottom: none;
    }

    /* Row 1: back + tab select */
    .tab-bar-left {
      flex: 1 0 100%;
      padding: 0.375rem 0.5rem;
      border-bottom: 1px solid var(--border);
      gap: 0.375rem;
    }

    .tab-nav { display: none; }
    .tab-select-mobile { display: flex; flex: 1; min-width: 0; }
    .back-label { display: none; }
    .back-btn { padding: 0.375rem 0.5rem; margin-right: 0; }

    /* Row 2: preview + publish side by side, full width, labeled */
    .tab-bar-right {
      flex: 1 0 100%;
      padding: 0.5rem;
      gap: 0.5rem;
      border-bottom: 1px solid var(--border);
    }

    .preview-btn {
      flex: 1;
      justify-content: center;
      padding: 0.5625rem 0.75rem;
    }

    .publish-btn {
      flex: 1;
      justify-content: center;
      padding: 0.5625rem 0.75rem;
    }
  }

  @media (min-width: 640px) {
    .tab-bar { padding: 0 1.75rem 0 0.5rem; }
    .tab-content { padding: 1.75rem 1.75rem 2rem; }
    .tab-btn { padding: 0.8125rem 1rem; }
  }
</style>
