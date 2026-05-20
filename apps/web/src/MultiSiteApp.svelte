<script lang="ts">
  import { onMount } from 'svelte';
  import type { Site, SiteRuntimeConfig, NavStyleId } from '@woco/shared';
  import SectionRenderer from './lib/components/site/sections/SectionRenderer.svelte';
  import EventPage from './lib/components/site/EventPage.svelte';
  // Try to get config from localStorage (same-origin case).
  // Returns null if nothing is found — postMessage handler will fill it in.
  function getInitialConfig(): SiteRuntimeConfig | null {
    if (typeof window === 'undefined') return null;
    const tsRaw = localStorage.getItem('woco:preview-timestamp');
    const isBuilderPreview = tsRaw !== null && (Date.now() - parseInt(tsRaw, 10)) < 300_000;
    if (!isBuilderPreview && window.SITE_CONFIG?.site) return window.SITE_CONFIG as SiteRuntimeConfig;
    const preview = localStorage.getItem('woco:site-preview');
    if (preview) {
      try {
        const c = JSON.parse(preview) as SiteRuntimeConfig;
        if (c?.site) return c;
      } catch {}
    }
    return null;
  }

  let config = $state<SiteRuntimeConfig | null>(getInitialConfig());
  const site       = $derived(config?.site as Site | undefined);
  const gatewayUrl = $derived(config?.gatewayUrl ?? (import.meta.env.VITE_GATEWAY_URL ?? 'https://gateway.woco-net.com'));
  const apiUrl     = $derived(config?.apiUrl ?? (import.meta.env.VITE_API_URL ?? 'http://localhost:3001'));
  const navStyle   = $derived<NavStyleId>((site?.theme?.navStyle as NavStyleId) ?? 'topbar');

  function logoUrl(): string | null {
    if (config?.previewLogoDataUrl) return config.previewLogoDataUrl;
    const ref = site?.theme?.logoSwarmRef;
    if (!ref || /^0+$/.test(ref)) return null;
    return `${gatewayUrl}/bytes/${ref}`;
  }

  type Route =
    | { type: 'page'; slug: string }
    | { type: 'event'; eventId: string };

  let route      = $state<Route>({ type: 'page', slug: '/' });
  let menuOpen   = $state(false);
  let logoFailed = $state(false);
  let showIntro  = $state(false);
  let configReady = $state(false);

  function parseHash(): Route {
    const raw = window.location.hash.replace(/^#/, '') || '/';
    const h = raw.split('?')[0];
    const m = h.match(/^\/events\/([^/]+)$/);
    if (m) return { type: 'event', eventId: m[1] };
    return { type: 'page', slug: h || '/' };
  }

  function currentPage(slug: string) {
    return site?.pages.find(p => p.slug === slug) ?? site?.pages.find(p => p.slug === '/');
  }

  function applyTheme() {
    if (!site) return;
    const root = document.documentElement;
    const { palette, fontFamily, radius } = site.theme;
    root.style.setProperty('--bg', palette.bg);
    root.style.setProperty('--text', palette.text);
    root.style.setProperty('--muted', palette.muted);
    root.style.setProperty('--accent', palette.accent);
    root.style.setProperty('--accent-hover', palette.accentHover);
    root.style.setProperty('--border', palette.border);
    root.style.setProperty('--card-bg', palette.cardBg);
    root.style.setProperty('--bg-base', palette.bg);
    root.style.setProperty('--bg-surface', palette.cardBg);
    root.style.setProperty('--bg-elevated', palette.cardBg);
    root.style.setProperty('--text-primary', palette.text);
    root.style.setProperty('--text-secondary', palette.muted);
    root.style.setProperty('--text-muted', palette.muted);
    root.style.setProperty('--border-hover', palette.accent);
    root.style.setProperty('--accent-text', palette.accent);
    root.style.setProperty('--success', '#4ade80');
    root.style.setProperty('--error', '#ef4444');
    root.style.setProperty('--transition', '0.15s ease');

    const fontMap: Record<string, string> = {
      system: "system-ui, -apple-system, sans-serif",
      serif:  "Georgia, 'Times New Roman', serif",
      display: "'Playfair Display', Georgia, serif",
    };
    root.style.setProperty('--font-family', fontMap[fontFamily] ?? fontMap.system);

    const radiusMap: Record<string, string> = { sm: '4px', md: '8px', lg: '12px' };
    const r = radiusMap[radius] ?? '4px';
    root.style.setProperty('--radius-sm', r);
    root.style.setProperty('--radius-md', radius === 'lg' ? '12px' : radius === 'md' ? '8px' : '6px');
    root.style.setProperty('--radius-lg', radius === 'lg' ? '18px' : radius === 'md' ? '12px' : '8px');

    document.title = site.theme.brandName;

    const logoNavH: Record<string, string> = { sm: '28px', md: '44px', lg: '68px', xl: '100px' };
    const logoIntroH: Record<string, string> = {
      sm: 'clamp(80px,  15vh, 180px)',
      md: 'clamp(160px, 32vh, 360px)',
      lg: 'clamp(220px, 48vh, 560px)',
      xl: 'clamp(300px, 65vh, 780px)',
    };
    root.style.setProperty('--logo-nav-h',   logoNavH[site.theme.logoSize   ?? 'md'] ?? '44px');
    root.style.setProperty('--logo-intro-h', logoIntroH[site.theme.introLogoSize ?? 'lg'] ?? logoIntroH.lg);
  }

  function activateSite() {
    if (configReady) return;
    configReady = true;
    window.SITE_CONFIG = config!;
    route = parseHash();
    const intro = navStyle === 'center-logo' && (site?.theme?.introAnimation !== false);
    applyTheme(); // must run before showIntro so CSS vars are set before the intro renders
    showIntro = intro;
    if (intro) setTimeout(() => { showIntro = false; }, 2400);
    window.addEventListener('hashchange', () => {
      route = parseHash();
      menuOpen = false;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  onMount(() => {
    if (site) {
      activateSite();
      return;
    }
    // Config not in localStorage — wait for postMessage from builder window.
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'woco-preview' && e.data.data) {
        try {
          const c = JSON.parse(e.data.data) as SiteRuntimeConfig;
          if (c?.site) {
            config = c;
            window.removeEventListener('message', handler);
          }
        } catch {}
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  });

  // Fires when config arrives asynchronously via postMessage
  $effect(() => {
    if (site && !configReady) activateSite();
  });

  // Lock body scroll when overlay/drawer menu is open
  $effect(() => {
    if (typeof document !== 'undefined') {
      document.body.style.overflow = menuOpen ? 'hidden' : '';
    }
  });

  $effect(() => {
    if (!site || route.type !== 'page') return;
    const page = currentPage(route.slug);
    if (page) {
      document.title = page.title ?? site.theme.brandName;
      const desc = page.metaDescription || site.theme.siteDescription || '';
      let metaDesc = document.querySelector<HTMLMetaElement>('meta[name="description"]');
      if (!metaDesc) {
        metaDesc = document.createElement('meta');
        metaDesc.name = 'description';
        document.head.appendChild(metaDesc);
      }
      metaDesc.content = desc;
    }
  });
</script>

{#if site}

<!-- ── Logo-split intro curtain (center-logo nav only) ──────────────── -->
{#if showIntro}
  <div class="intro-curtain" aria-hidden="true">
    <div class="intro-half intro-left">
      {#if logoUrl() && !logoFailed}
        <img class="intro-split-logo intro-split-left" src={logoUrl()!} alt="" onerror={() => { logoFailed = true; }} />
      {:else}
        <span class="intro-split-text intro-split-text-left">{site.theme.brandName}</span>
      {/if}
    </div>
    <div class="intro-half intro-right">
      {#if logoUrl() && !logoFailed}
        <img class="intro-split-logo intro-split-right" src={logoUrl()!} alt={site.theme.brandName} />
      {:else}
        <span class="intro-split-text intro-split-text-right">{site.theme.brandName}</span>
      {/if}
    </div>
  </div>
{/if}

<div class="site">

  <!-- ── Top-bar nav (default) ─────────────────────────────────────── -->
  {#if navStyle === 'topbar'}
    <nav class="site-nav nav-topbar">
      <div class="nav-inner">
        <a class="brand" href="#/">
          {#if logoUrl() && !logoFailed}
            <img class="brand-logo" src={logoUrl()!} alt={site.theme.brandName} onerror={() => { logoFailed = true; }} />
          {:else}
            {site.theme.brandName}
          {/if}
        </a>

        <button class="hamburger" aria-label={menuOpen ? 'Close menu' : 'Open menu'} onclick={() => (menuOpen = !menuOpen)}>
          <span class:bar-open={menuOpen}></span>
          <span class:bar-open={menuOpen}></span>
          <span class:bar-open={menuOpen}></span>
        </button>

        <ul class="nav-links" class:open={menuOpen}>
          {#each site.nav as item}
            <li>
              <a
                href={'#' + item.pageSlug}
                class:active={route.type === 'page' && route.slug === item.pageSlug}
                onclick={() => { menuOpen = false; }}
              >{item.label}</a>
            </li>
          {/each}
        </ul>
      </div>
    </nav>

  <!-- ── Center-logo nav with fullscreen overlay ───────────────────── -->
  {:else if navStyle === 'center-logo'}
    <nav class="site-nav nav-center">
      <div class="nav-inner-center">
        <button
          class="hamburger hamburger-center"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          onclick={() => (menuOpen = !menuOpen)}
        >
          <span class:bar-open={menuOpen}></span>
          <span class:bar-open={menuOpen}></span>
          <span class:bar-open={menuOpen}></span>
        </button>

        <a class="brand brand-center" href="#/" onclick={() => { menuOpen = false; }}>
          {#if logoUrl() && !logoFailed}
            <img class="brand-logo" src={logoUrl()!} alt={site.theme.brandName} onerror={() => { logoFailed = true; }} />
          {:else}
            {site.theme.brandName}
          {/if}
        </a>

        <div class="nav-spacer" aria-hidden="true"></div>
      </div>

      <!-- Fullscreen overlay menu (slides from left) -->
      <div class="overlay-menu" class:overlay-open={menuOpen} aria-hidden={!menuOpen}>
        <button class="overlay-close" aria-label="Close menu" onclick={() => (menuOpen = false)}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M4 4l12 12M16 4L4 16" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>
          </svg>
        </button>
        <ul class="overlay-links">
          {#each site.nav as item, i}
            <li style="--i: {i}">
              <a
                href={'#' + item.pageSlug}
                class:active={route.type === 'page' && route.slug === item.pageSlug}
                onclick={() => { menuOpen = false; }}
              >{item.label}</a>
            </li>
          {/each}
        </ul>
      </div>
    </nav>

  <!-- ── Overlay-drawer nav (hamburger only, consistent on all sizes) ─ -->
  {:else}
    <nav class="site-nav nav-drawer">
      <div class="nav-inner-drawer">
        <a class="brand" href="#/" onclick={() => { menuOpen = false; }}>
          {#if logoUrl() && !logoFailed}
            <img class="brand-logo" src={logoUrl()!} alt={site.theme.brandName} onerror={() => { logoFailed = true; }} />
          {:else}
            {site.theme.brandName}
          {/if}
        </a>

        <button
          class="hamburger hamburger-drawer"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          onclick={() => (menuOpen = !menuOpen)}
        >
          <span class:bar-open={menuOpen}></span>
          <span class:bar-open={menuOpen}></span>
          <span class:bar-open={menuOpen}></span>
        </button>
      </div>

      <!-- Full-screen drawer (slides from right) -->
      <div class="drawer-menu" class:drawer-open={menuOpen} aria-hidden={!menuOpen}>
        <button class="overlay-close" aria-label="Close menu" onclick={() => (menuOpen = false)}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M4 4l12 12M16 4L4 16" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>
          </svg>
        </button>
        <ul class="drawer-links">
          {#each site.nav as item, i}
            <li style="--i: {i}">
              <a
                href={'#' + item.pageSlug}
                class:active={route.type === 'page' && route.slug === item.pageSlug}
                onclick={() => { menuOpen = false; }}
              >{item.label}</a>
            </li>
          {/each}
        </ul>
      </div>
    </nav>
  {/if}

  <!-- ── Page / event content ──────────────────────────────────────── -->
  {#if route.type === 'event'}
    <main>
      <EventPage eventId={route.eventId} {apiUrl} onback={() => history.back()} />
    </main>
  {:else}
    {#key route.slug}
      {@const page = currentPage(route.slug)}
      {#if page}
        <main>
          {#each page.sections as section (section.id)}
            <SectionRenderer {section} {site} {gatewayUrl} {apiUrl} />
          {/each}
        </main>
      {:else}
        <main class="not-found">
          <h1>Page not found</h1>
          <a href="#/">← Home</a>
        </main>
      {/if}
    {/key}
  {/if}

  <footer class="site-footer">
    <div class="footer-inner">
      <span class="footer-brand">{site.theme.brandName}</span>
      {#if site.contact.address}
        <span class="footer-address">{site.contact.address}</span>
      {/if}
      {#if site.contact.email}
        <a class="footer-link" href="mailto:{site.contact.email}">{site.contact.email}</a>
      {/if}
      <span class="footer-powered">Powered by <a href="https://woco.eth.limo" target="_blank" rel="noopener">WoCo</a></span>
    </div>
  </footer>
</div>

{:else}
  <div class="preview-waiting">
    <p>Preparing preview…</p>
  </div>
{/if}

<style>
  /* ── Logo-split intro curtain ──────────────────────────────────────── */
  .intro-curtain {
    position: fixed;
    inset: 0;
    z-index: 9999;
    pointer-events: none;
  }

  .intro-half {
    position: fixed;
    top: 0;
    bottom: 0;
    overflow: hidden;
    background: var(--bg);
    animation-duration: 0.85s;
    animation-timing-function: cubic-bezier(0.76, 0, 0.24, 1);
    animation-delay: 1.2s;
    animation-fill-mode: forwards;
  }

  .intro-left  { left: 0; width: 50%; animation-name: curtain-left; }
  .intro-right { left: 50%; right: 0; animation-name: curtain-right; }

  /* Same logo image in both panels — each panel clips its respective half.
     Logo center sits at the boundary (50vw) so halves separate cleanly. */
  .intro-split-logo {
    position: absolute;
    top: 50%;
    height: var(--logo-intro-h, clamp(220px, 48vh, 560px));
    width: auto;
    max-width: min(780px, 80vw);
    object-fit: contain;
    animation: intro-logo-appear 0.7s cubic-bezier(0.22, 1, 0.36, 1) 0.15s both;
  }

  .intro-split-left  { right: 0; transform: translate(50%, -50%); }
  .intro-split-right { left: 0;  transform: translate(-50%, -50%); }

  .intro-split-text {
    position: absolute;
    top: 50%;
    font-size: clamp(2rem, 6vw, 4.5rem);
    font-weight: 900;
    color: var(--text);
    letter-spacing: -0.03em;
    font-family: var(--font-family);
    white-space: nowrap;
    animation: intro-logo-appear 0.7s cubic-bezier(0.22, 1, 0.36, 1) 0.15s both;
  }

  .intro-split-text-left  { right: 0; transform: translate(50%, -50%); }
  .intro-split-text-right { left: 0;  transform: translate(-50%, -50%); }

  @keyframes curtain-left {
    from { transform: translateX(0); }
    to   { transform: translateX(-100%); }
  }
  @keyframes curtain-right {
    from { transform: translateX(0); }
    to   { transform: translateX(100%); }
  }
  @keyframes intro-logo-appear {
    from { opacity: 0; filter: blur(8px); }
    to   { opacity: 1; filter: blur(0px); }
  }

  /* ── Shared site shell ─────────────────────────────────────────────── */
  .site {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    overflow-x: hidden;
  }

  /* ── Shared nav chrome ─────────────────────────────────────────────── */
  .site-nav {
    position: sticky;
    top: 0;
    z-index: 100;
    background: var(--bg);
  }

  .brand {
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--text);
    white-space: nowrap;
    flex-shrink: 0;
    text-decoration: none;
  }
  .brand:hover { color: var(--accent); }

  .brand-logo {
    height: var(--logo-nav-h, 44px);
    width: auto;
    max-width: 240px;
    object-fit: contain;
    display: block;
  }

  /* Hamburger (shared across nav styles) */
  .hamburger {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 0.5rem;
    cursor: pointer;
    flex-shrink: 0;
    background: none;
    border: none;
  }

  .hamburger span {
    display: block;
    width: 22px;
    height: 2px;
    background: var(--text);
    border-radius: 2px;
    transition: transform 0.25s ease, opacity 0.2s ease;
    transform-origin: center;
  }

  /* Hamburger → X animation */
  .hamburger span:nth-child(1).bar-open { transform: translateY(7px) rotate(45deg); }
  .hamburger span:nth-child(2).bar-open { opacity: 0; transform: scaleX(0); }
  .hamburger span:nth-child(3).bar-open { transform: translateY(-7px) rotate(-45deg); }

  /* Close button inside overlay/drawer */
  .overlay-close {
    position: absolute;
    top: 1.25rem;
    right: 1.5rem;
    padding: 0.5rem;
    color: var(--muted);
    background: none;
    border: none;
    cursor: pointer;
    transition: color 0.15s ease;
    z-index: 10;
  }
  .overlay-close:hover { color: var(--text); }

  /* ── TOP-BAR nav ───────────────────────────────────────────────────── */
  .nav-topbar {
    border-bottom: 1px solid var(--border);
  }

  .nav-inner {
    max-width: 1100px;
    margin: 0 auto;
    padding: 0 1.5rem;
    height: 60px;
    display: flex;
    align-items: center;
    gap: 2rem;
  }

  .nav-links {
    display: flex;
    gap: 0;
    list-style: none;
    margin: 0 0 0 auto;
    padding: 0;
  }

  .nav-links a {
    display: block;
    padding: 0.375rem 0.875rem;
    font-size: 0.9rem;
    color: var(--muted);
    transition: color var(--transition);
    text-decoration: none;
    border-radius: var(--radius-sm);
  }

  .nav-links a:hover,
  .nav-links a.active { color: var(--text); }
  .nav-links a.active  { color: var(--accent); }

  .hamburger {
    display: none;
  }

  @media (max-width: 640px) {
    .hamburger { display: flex; margin-left: auto; }

    .nav-links {
      display: none;
      position: absolute;
      top: 60px;
      left: 0;
      right: 0;
      background: var(--bg);
      border-bottom: 1px solid var(--border);
      flex-direction: column;
      padding: 0.75rem 1.5rem;
      gap: 0;
      margin-left: 0;
    }

    .nav-links.open { display: flex; }

    .nav-links li { width: 100%; }

    .nav-links a {
      padding: 0.75rem 0;
      border-radius: 0;
      border-bottom: 1px solid var(--border);
    }

    .nav-links li:last-child a { border-bottom: none; }
  }

  /* ── CENTER-LOGO nav ───────────────────────────────────────────────── */
  .nav-center {
    border-bottom: 1px solid var(--border);
  }

  .nav-inner-center {
    max-width: 1100px;
    margin: 0 auto;
    padding: 0 1.5rem;
    height: 64px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .hamburger-center {
    display: flex;
    z-index: 200;
    position: relative;
  }

  .brand-center {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
  }

  .nav-spacer {
    width: 38px; /* mirrors hamburger width for centering */
    flex-shrink: 0;
  }

  /* Fullscreen overlay from left */
  .overlay-menu {
    position: fixed;
    inset: 0;
    z-index: 150;
    background: var(--bg);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 4rem 3rem;
    transform: translateX(-100%);
    transition: transform 0.55s cubic-bezier(0.76, 0, 0.24, 1),
                visibility 0s linear 0.55s;
    visibility: hidden;
  }

  .overlay-menu.overlay-open {
    transform: translateX(0);
    visibility: visible;
    transition: transform 0.55s cubic-bezier(0.76, 0, 0.24, 1),
                visibility 0s;
  }

  .overlay-links {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .overlay-links li {
    transform: translateX(-40px);
    opacity: 0;
    transition: transform 0.45s cubic-bezier(0.34, 1.36, 0.64, 1),
                opacity 0.35s ease;
    transition-delay: calc(var(--i) * 0.07s);
  }

  .overlay-menu.overlay-open .overlay-links li {
    transform: translateX(0);
    opacity: 1;
    transition-delay: calc(var(--i) * 0.07s + 0.2s);
  }

  .overlay-links a {
    display: block;
    font-size: clamp(2rem, 6vw, 3.5rem);
    font-weight: 900;
    color: var(--text);
    text-decoration: none;
    letter-spacing: -0.04em;
    line-height: 1.1;
    transition: color 0.15s ease;
    padding: 0.15em 0;
  }
  .overlay-links a:hover  { color: var(--accent); }
  .overlay-links a.active { color: var(--accent); }

  /* ── OVERLAY-DRAWER nav ────────────────────────────────────────────── */
  .nav-drawer {
    border-bottom: 1px solid var(--border);
  }

  .nav-inner-drawer {
    max-width: 1100px;
    margin: 0 auto;
    padding: 0 1.5rem;
    height: 60px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: relative;
    z-index: 200;
  }

  .hamburger-drawer {
    display: flex;
  }

  /* Full-screen drawer from right */
  .drawer-menu {
    position: fixed;
    inset: 0;
    z-index: 150;
    background: var(--bg);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    transform: translateX(100%);
    transition: transform 0.55s cubic-bezier(0.76, 0, 0.24, 1),
                visibility 0s linear 0.55s;
    visibility: hidden;
  }

  .drawer-menu.drawer-open {
    transform: translateX(0);
    visibility: visible;
    transition: transform 0.55s cubic-bezier(0.76, 0, 0.24, 1),
                visibility 0s;
  }

  .drawer-links {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
  }

  .drawer-links li {
    transform: translateX(40px);
    opacity: 0;
    transition: transform 0.45s cubic-bezier(0.34, 1.36, 0.64, 1),
                opacity 0.35s ease;
    transition-delay: calc(var(--i) * 0.07s);
  }

  .drawer-menu.drawer-open .drawer-links li {
    transform: translateX(0);
    opacity: 1;
    transition-delay: calc(var(--i) * 0.07s + 0.2s);
  }

  .drawer-links a {
    display: block;
    font-size: clamp(2rem, 6vw, 3.5rem);
    font-weight: 900;
    color: var(--text);
    text-decoration: none;
    letter-spacing: -0.04em;
    line-height: 1.1;
    transition: color 0.15s ease;
    padding: 0.15em 0;
    text-align: center;
  }
  .drawer-links a:hover  { color: var(--accent); }
  .drawer-links a.active { color: var(--accent); }

  /* ── Main ─────────────────────────────────────────────────────────── */
  main { flex: 1; }

  .not-found {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 6rem 1.5rem;
    gap: 1rem;
    text-align: center;
  }

  .not-found h1 {
    font-size: 2rem;
    color: var(--text);
    margin: 0;
  }

  /* ── Footer ───────────────────────────────────────────────────────── */
  .site-footer {
    border-top: 1px solid var(--border);
    padding: 2rem 1.5rem;
    margin-top: auto;
  }

  .footer-inner {
    max-width: 1100px;
    margin: 0 auto;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 1.25rem;
    font-size: 0.875rem;
    color: var(--muted);
  }

  .footer-brand {
    font-weight: 700;
    color: var(--text);
  }

  .footer-address { white-space: pre-line; }

  .footer-link { color: var(--muted); }
  .footer-link:hover { color: var(--accent); }

  .footer-powered { margin-left: auto; }
  .footer-powered a { color: var(--accent); }

  .preview-waiting {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    color: #888;
    font-family: system-ui, sans-serif;
  }
</style>
