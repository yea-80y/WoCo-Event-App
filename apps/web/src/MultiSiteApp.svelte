<script lang="ts">
  import { onMount } from 'svelte';
  import type { Site, SiteRuntimeConfig } from '@woco/shared';
  import SectionRenderer from './lib/components/site/sections/SectionRenderer.svelte';
  import blackPrinceSite from '../Black-Prince/site.json';

  const DEV_FALLBACK: SiteRuntimeConfig = {
    site: blackPrinceSite as unknown as Site,
    gatewayUrl: import.meta.env.VITE_GATEWAY_URL ?? 'https://gateway.woco-net.com',
    apiUrl: import.meta.env.VITE_API_URL ?? 'http://localhost:3001',
  };

  const rawConfig = typeof window !== 'undefined' ? window.SITE_CONFIG : undefined;
  const config: SiteRuntimeConfig = rawConfig?.site ? rawConfig : DEV_FALLBACK;
  const site = config.site as Site;
  const gatewayUrl = config.gatewayUrl;
  const apiUrl = config.apiUrl ?? 'http://localhost:3001';

  let currentSlug = $state(parseHash());
  let menuOpen = $state(false);

  function parseHash(): string {
    const h = window.location.hash.replace(/^#/, '') || '/';
    const [slug] = h.split('/events');
    return slug || '/';
  }

  function currentPage() {
    return site.pages.find(p => p.slug === currentSlug) ?? site.pages.find(p => p.slug === '/');
  }

  function applyTheme() {
    const root = document.documentElement;
    const { palette, fontFamily, radius } = site.theme;
    root.style.setProperty('--bg', palette.bg);
    root.style.setProperty('--text', palette.text);
    root.style.setProperty('--muted', palette.muted);
    root.style.setProperty('--accent', palette.accent);
    root.style.setProperty('--accent-hover', palette.accentHover);
    root.style.setProperty('--border', palette.border);
    root.style.setProperty('--card-bg', palette.cardBg);

    const fontMap: Record<string, string> = {
      system: "system-ui, -apple-system, sans-serif",
      serif: "Georgia, 'Times New Roman', serif",
      display: "'Playfair Display', Georgia, serif",
    };
    root.style.setProperty('--font-family', fontMap[fontFamily] ?? fontMap.system);

    const radiusMap: Record<string, string> = { sm: '4px', md: '8px', lg: '12px' };
    const r = radiusMap[radius] ?? '4px';
    root.style.setProperty('--radius-sm', r);
    root.style.setProperty('--radius-md', radius === 'lg' ? '12px' : radius === 'md' ? '8px' : '6px');
    root.style.setProperty('--radius-lg', radius === 'lg' ? '18px' : radius === 'md' ? '12px' : '8px');

    document.title = site.theme.brandName;
  }

  onMount(() => {
    applyTheme();
    window.addEventListener('hashchange', () => {
      currentSlug = parseHash();
      menuOpen = false;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  $effect(() => {
    const page = currentPage();
    if (page) document.title = page.title ?? site.theme.brandName;
  });
</script>

<div class="site">
  <nav class="site-nav">
    <div class="nav-inner">
      <a class="brand" href="#/">{site.theme.brandName}</a>

      <button class="hamburger" aria-label="Menu" onclick={() => (menuOpen = !menuOpen)}>
        <span></span><span></span><span></span>
      </button>

      <ul class="nav-links" class:open={menuOpen}>
        {#each site.nav as item}
          <li>
            <a
              href={'#' + item.pageSlug}
              class:active={currentSlug === item.pageSlug}
            >{item.label}</a>
          </li>
        {/each}
      </ul>
    </div>
  </nav>

  {#key currentSlug}
    {@const page = currentPage()}
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

<style>
  .site {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  /* ── Nav ─────────────────────────────────────────────────────────────────── */
  .site-nav {
    position: sticky;
    top: 0;
    z-index: 100;
    background: var(--bg);
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

  .brand {
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--text);
    white-space: nowrap;
    flex-shrink: 0;
    text-decoration: none;
  }
  .brand:hover { text-decoration: none; color: var(--accent); }

  .nav-links {
    display: flex;
    gap: 0;
    list-style: none;
    margin: 0;
    padding: 0;
    margin-left: auto;
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
  .nav-links a.active {
    color: var(--text);
    text-decoration: none;
  }

  .nav-links a.active {
    color: var(--accent);
  }

  .hamburger {
    display: none;
    flex-direction: column;
    gap: 5px;
    padding: 0.5rem;
    margin-left: auto;
    cursor: pointer;
  }

  .hamburger span {
    display: block;
    width: 22px;
    height: 2px;
    background: var(--text);
    border-radius: 2px;
    transition: opacity var(--transition);
  }

  @media (max-width: 640px) {
    .hamburger { display: flex; }

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

  /* ── Main ────────────────────────────────────────────────────────────────── */
  main {
    flex: 1;
  }

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

  /* ── Footer ──────────────────────────────────────────────────────────────── */
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

  .footer-address {
    white-space: pre-line;
  }

  .footer-link {
    color: var(--muted);
  }
  .footer-link:hover { color: var(--accent); }

  .footer-powered {
    margin-left: auto;
  }

  .footer-powered a {
    color: var(--accent);
  }
</style>
