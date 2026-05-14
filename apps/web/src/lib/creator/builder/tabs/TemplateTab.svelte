<script lang="ts">
  import type { TemplateId } from "@woco/shared";

  interface Props {
    currentTemplateId: TemplateId;
    onselect: (id: TemplateId) => void;
  }

  let { currentTemplateId, onselect }: Props = $props();

  const templates = [
    {
      id: 'pub-venue-v1' as TemplateId,
      name: 'Pub & Venue',
      navLabel: 'Top Bar',
      navType: 'topbar' as const,
      description: 'Warm, atmospheric hospitality site with gold accents. Multi-page structure: home, what\'s on, visit, and contact.',
      bestFor: ['Pubs', 'Bars', 'Restaurants', 'Music Venues'],
      accent: '#d4af37',
    },
    {
      id: 'nightlife-v1' as TemplateId,
      name: 'Nightlife & Club',
      navLabel: 'Center Logo + Overlay',
      navType: 'overlay' as const,
      description: 'Dramatic dark design with a logo-split intro animation and fullscreen overlay menu. Built for maximum impression.',
      bestFor: ['Nightclubs', 'DJs', 'Promoters', 'Festivals'],
      accent: '#a855f7',
    },
    {
      id: 'clean-modern-v1' as TemplateId,
      name: 'Clean & Modern',
      navLabel: 'Overlay Drawer',
      navType: 'drawer' as const,
      description: 'Light, airy and minimal with generous whitespace. Versatile for arts, galleries, festivals, and cultural organisations.',
      bestFor: ['Arts Venues', 'Galleries', 'Festivals', 'Cultural Orgs'],
      accent: '#2563eb',
    },
  ] as const;
</script>

<div class="template-tab">
  <header class="tab-header">
    <h2>Choose a template</h2>
    <p>Templates set the default pages, layout, and visual style. You can switch at any time — your brand name, logo, and colours are always preserved.</p>
  </header>

  <div class="template-grid">
    {#each templates as t}
      {@const active = t.id === currentTemplateId}
      <button
        class="tpl-card"
        class:is-active={active}
        style="--tpl-accent: {t.accent}"
        onclick={() => onselect(t.id)}
        aria-pressed={active}
      >
        <!-- ── Animated mini-preview ── -->
        <div class="preview preview-{t.navType}">

          {#if t.navType === 'topbar'}
            <!-- Top-bar: logo left, links right, gold shimmer on heading -->
            <div class="pv-nav pv-nav-topbar">
              <div class="pv-logo pv-logo-gold"></div>
              <div class="pv-links">
                <div class="pv-link"></div>
                <div class="pv-link"></div>
                <div class="pv-link pv-link-active-gold"></div>
              </div>
            </div>
            <div class="pv-hero pv-hero-dark">
              <div class="pv-h1 pv-h1-shimmer"></div>
              <div class="pv-h2 pv-h2-dim"></div>
              <div class="pv-cta pv-cta-gold"></div>
            </div>
            <div class="pv-rows">
              <div class="pv-row" style="width:88%"></div>
              <div class="pv-row" style="width:65%"></div>
              <div class="pv-row" style="width:77%"></div>
            </div>

          {:else if t.navType === 'overlay'}
            <!-- Center-logo: centered brand, hamburger left, overlay menu animates in -->
            <div class="pv-nav pv-nav-center">
              <div class="pv-hb"><span></span><span></span><span></span></div>
              <div class="pv-logo pv-logo-white"></div>
              <div class="pv-hb" style="opacity:0" aria-hidden="true"><span></span><span></span><span></span></div>
            </div>
            <div class="pv-hero pv-hero-black">
              <div class="pv-h1 pv-h1-neon"></div>
              <div class="pv-h2 pv-h2-dim" style="width:50%"></div>
              <div class="pv-cta pv-cta-neon"></div>
            </div>
            <!-- Overlay slides in and out on loop -->
            <div class="pv-overlay">
              <div class="pv-ol-item pv-ol-accent" style="--od:0s"></div>
              <div class="pv-ol-item" style="--od:0.14s; width:58%"></div>
              <div class="pv-ol-item" style="--od:0.28s; width:52%"></div>
              <div class="pv-ol-item" style="--od:0.42s; width:62%"></div>
            </div>

          {:else}
            <!-- Overlay drawer: logo left, hamburger right, drawer slides from right -->
            <div class="pv-nav pv-nav-drawer">
              <div class="pv-logo pv-logo-dark"></div>
              <div class="pv-hb pv-hb-dark"><span></span><span></span><span></span></div>
            </div>
            <div class="pv-hero pv-hero-light">
              <div class="pv-h1 pv-h1-dark" style="width:70%"></div>
              <div class="pv-h2 pv-h2-light" style="width:50%"></div>
              <div class="pv-cta pv-cta-outline"></div>
            </div>
            <!-- Cards row -->
            <div class="pv-cards">
              <div class="pv-card"></div>
              <div class="pv-card"></div>
              <div class="pv-card"></div>
            </div>
            <!-- Drawer slides in from right on loop -->
            <div class="pv-drawer">
              <div class="pv-dr-item pv-dr-accent" style="--od:0s"></div>
              <div class="pv-dr-item" style="--od:0.14s; width:55%"></div>
              <div class="pv-dr-item" style="--od:0.28s; width:50%"></div>
              <div class="pv-dr-item" style="--od:0.42s; width:58%"></div>
            </div>
          {/if}

          <!-- Active overlay tick -->
          {#if active}
            <div class="preview-active-mark" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <circle cx="7" cy="7" r="7" fill="{t.accent}"/>
                <path d="M4 7l2 2 4-4" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
          {/if}
        </div>

        <!-- ── Card info ── -->
        <div class="card-body">
          <div class="card-top">
            <span class="card-name">{t.name}</span>
            {#if active}
              <span class="active-pill" style="background: {t.accent}">Active</span>
            {:else}
              <span class="select-hint">Select →</span>
            {/if}
          </div>

          <div class="nav-badge" style="color: {t.accent}">
            <!-- nav style icon -->
            <svg width="12" height="9" viewBox="0 0 12 9" fill="none" aria-hidden="true">
              {#if t.navType === 'topbar'}
                <rect y="0" width="12" height="2" rx="1" fill="currentColor"/>
                <rect y="4" width="8" height="1.5" rx=".75" fill="currentColor" opacity=".5"/>
                <rect y="7" width="5" height="1.5" rx=".75" fill="currentColor" opacity=".3"/>
              {:else if t.navType === 'overlay'}
                <rect x="3" y="0" width="6" height="2" rx="1" fill="currentColor"/>
                <rect x="0" y="0" width="2.5" height="1.5" rx=".75" fill="currentColor" opacity=".6"/>
                <rect x="0" y="4" width="10" height="1.5" rx=".75" fill="currentColor" opacity=".4"/>
                <rect x="0" y="7" width="8" height="1.5" rx=".75" fill="currentColor" opacity=".25"/>
              {:else}
                <rect x="0" y="0" width="8" height="2" rx="1" fill="currentColor"/>
                <rect x="10" y="0" width="2" height="1.5" rx=".75" fill="currentColor" opacity=".8"/>
                <rect x="10" y="3.5" width="2" height="1.5" rx=".75" fill="currentColor" opacity=".8"/>
                <rect x="0" y="4" width="9" height="1.5" rx=".75" fill="currentColor" opacity=".4"/>
                <rect x="0" y="7" width="6" height="1.5" rx=".75" fill="currentColor" opacity=".25"/>
              {/if}
            </svg>
            <span>{t.navLabel}</span>
          </div>

          <p class="card-desc">{t.description}</p>

          <div class="card-tags">
            {#each t.bestFor as tag}
              <span class="tag">{tag}</span>
            {/each}
          </div>
        </div>
      </button>
    {/each}
  </div>

  <!-- ── Nav style legend ── -->
  <div class="nav-legend">
    <h3>Navigation styles explained</h3>
    <div class="legend-rows">
      <div class="legend-item">
        <div class="lt lt-topbar">
          <div class="lt-logo"></div>
          <div class="lt-links-row"><div></div><div></div><div></div></div>
        </div>
        <div class="legend-text">
          <strong>Top Bar</strong>
          <span>Logo left, links right. Hamburger on mobile. The familiar, highly usable standard.</span>
        </div>
      </div>
      <div class="legend-item">
        <div class="lt lt-center">
          <div class="lt-hb"><div></div><div></div><div></div></div>
          <div class="lt-center-logo"></div>
          <div class="lt-spacer"></div>
        </div>
        <div class="legend-text">
          <strong>Center Logo + Overlay</strong>
          <span>Brand centered in the header. Hamburger opens a dramatic fullscreen menu that slides in. Includes an optional logo-split curtain animation on page load.</span>
        </div>
      </div>
      <div class="legend-item">
        <div class="lt lt-drawer">
          <div class="lt-logo"></div>
          <div class="lt-hb-right"><div></div><div></div><div></div></div>
        </div>
        <div class="legend-text">
          <strong>Overlay Drawer</strong>
          <span>Minimal header with logo and hamburger. Clicking opens a full-screen menu that slides in from the right — same on desktop and mobile.</span>
        </div>
      </div>
    </div>
    <p class="legend-tip">
      You can change the navigation style at any time under the <strong>Brand</strong> tab without touching your pages or content.
    </p>
  </div>

  <p class="reset-warn">
    Selecting a different template will replace all current pages and sections with template defaults. Your brand name, logo, and colours are always preserved.
  </p>
</div>

<style>
  /* ── Layout ─────────────────────────────────────────────────────────── */
  .template-tab {
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .tab-header h2 {
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--text);
    margin: 0 0 0.375rem;
  }

  .tab-header p {
    font-size: 0.875rem;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }

  /* ── Grid ────────────────────────────────────────────────────────────── */
  .template-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1rem;
  }

  @media (min-width: 640px) {
    .template-grid {
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    }
  }

  /* ── Template card ───────────────────────────────────────────────────── */
  .tpl-card {
    display: flex;
    flex-direction: column;
    background: var(--bg-surface);
    border: 2px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    text-align: left;
    cursor: pointer;
    transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.15s ease;
    position: relative;
  }

  .tpl-card:hover {
    border-color: color-mix(in srgb, var(--tpl-accent) 55%, transparent);
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.18);
  }

  .tpl-card.is-active {
    border-color: var(--tpl-accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--tpl-accent) 18%, transparent);
  }

  .tpl-card:focus-visible {
    outline: 2px solid var(--tpl-accent);
    outline-offset: 2px;
  }

  /* ── Preview container ───────────────────────────────────────────────── */
  .preview {
    position: relative;
    height: 190px;
    overflow: hidden;
    flex-shrink: 0;
  }

  .preview-topbar  { background: #0f0f0f; }
  .preview-overlay { background: #050505; }
  .preview-drawer  { background: #fafafa; }

  .preview-active-mark {
    position: absolute;
    top: 0.625rem;
    right: 0.625rem;
    z-index: 30;
    filter: drop-shadow(0 2px 4px rgba(0,0,0,0.4));
  }

  /* ── Preview nav bars ────────────────────────────────────────────────── */
  .pv-nav {
    display: flex;
    align-items: center;
    height: 22px;
    padding: 0 10px;
  }

  .pv-nav-topbar {
    justify-content: space-between;
    background: rgba(255,255,255,0.03);
    border-bottom: 1px solid rgba(255,255,255,0.07);
  }

  .pv-nav-center {
    justify-content: space-between;
    background: rgba(255,255,255,0.02);
    border-bottom: 1px solid rgba(255,255,255,0.05);
  }

  .pv-nav-drawer {
    justify-content: space-between;
    background: rgba(255,255,255,0.97);
    border-bottom: 1px solid rgba(0,0,0,0.08);
  }

  .pv-logo {
    height: 7px;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .pv-logo-gold   { width: 32px; background: #d4af37; }
  .pv-logo-white  { width: 40px; background: rgba(255,255,255,0.9); margin: 0 auto; }
  .pv-logo-dark   { width: 32px; background: rgba(0,0,0,0.7); }

  .pv-links {
    display: flex;
    gap: 5px;
    align-items: center;
  }

  .pv-link {
    width: 16px;
    height: 5px;
    background: rgba(255,255,255,0.25);
    border-radius: 2px;
  }

  .pv-link-active-gold { background: #d4af37; }

  .pv-hb {
    display: flex;
    flex-direction: column;
    gap: 2.5px;
  }

  .pv-hb span, .pv-hb-dark span {
    display: block;
    width: 11px;
    height: 1.5px;
    border-radius: 1px;
  }

  .pv-hb span      { background: rgba(255,255,255,0.65); }
  .pv-hb-dark span { background: rgba(0,0,0,0.55); }

  /* ── Preview heroes ──────────────────────────────────────────────────── */
  .pv-hero {
    padding: 14px 10px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .pv-hero-dark  { background: #0f0f0f; }
  .pv-hero-black { background: #050505; }
  .pv-hero-light { background: #fafafa; }

  .pv-h1 {
    width: 78%;
    height: 10px;
    border-radius: 3px;
  }

  .pv-h2 {
    width: 55%;
    height: 6px;
    border-radius: 2px;
  }

  /* Gold shimmer heading */
  .pv-h1-shimmer {
    background: linear-gradient(90deg, #b8962b 0%, #f0d060 40%, #d4af37 60%, #b8962b 100%);
    background-size: 250% 100%;
    animation: gold-shimmer 2.8s linear infinite;
  }

  @keyframes gold-shimmer {
    0%   { background-position: 200% center; }
    100% { background-position: -200% center; }
  }

  /* Nightlife neon heading */
  .pv-h1-neon {
    background: linear-gradient(90deg, #a855f7 0%, #ec4899 60%, #a855f7 100%);
    background-size: 200% 100%;
    animation: neon-slide 3s ease-in-out infinite;
    width: 75%;
  }

  @keyframes neon-slide {
    0%, 100% { background-position: 0% center; }
    50%       { background-position: 100% center; }
  }

  /* Clean dark heading */
  .pv-h1-dark { background: rgba(0,0,0,0.75); }

  .pv-h2-dim   { background: rgba(255,255,255,0.2); }
  .pv-h2-light { background: rgba(0,0,0,0.25); }

  /* CTAs */
  .pv-cta {
    width: 42px;
    height: 12px;
    border-radius: 3px;
    margin-top: 2px;
  }

  .pv-cta-gold    { background: #d4af37; }
  .pv-cta-neon    { background: #a855f7; box-shadow: 0 0 8px rgba(168,85,247,0.55); }
  .pv-cta-outline { background: transparent; border: 1.5px solid rgba(0,0,0,0.35); width: 52px; }

  /* ── Content rows (pub/venue) ────────────────────────────────────────── */
  .pv-rows {
    padding: 0 10px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    background: #0f0f0f;
  }

  .pv-row {
    height: 4px;
    background: rgba(255,255,255,0.1);
    border-radius: 2px;
  }

  /* ── Cards row (clean modern) ────────────────────────────────────────── */
  .pv-cards {
    display: flex;
    gap: 5px;
    padding: 8px 10px;
    background: #fafafa;
  }

  .pv-card {
    flex: 1;
    height: 30px;
    background: rgba(0,0,0,0.06);
    border-radius: 3px;
    border: 1px solid rgba(0,0,0,0.07);
  }

  /* ── Nightlife overlay menu animation ───────────────────────────────── */
  .pv-overlay {
    position: absolute;
    inset: 0;
    background: rgba(5,5,5,0.97);
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 9px;
    padding: 0 14px;
    animation: overlay-curtain 5.5s ease-in-out infinite;
    transform-origin: left center;
    border-left: 2px solid rgba(168,85,247,0.35);
  }

  @keyframes overlay-curtain {
    0%, 8%   { transform: translateX(-100%); }
    18%, 72% { transform: translateX(0); }
    82%, 100% { transform: translateX(-100%); }
  }

  .pv-ol-item {
    width: 66%;
    height: 7px;
    border-radius: 2px;
    background: rgba(255,255,255,0.7);
    animation: ol-slide 5.5s ease-out infinite;
    animation-delay: calc(var(--od) + 0.25s);
    transform: translateX(-28px);
    opacity: 0;
  }

  .pv-ol-accent { background: #a855f7; width: 72%; }

  @keyframes ol-slide {
    0%, 22%  { transform: translateX(-28px); opacity: 0; }
    32%, 68% { transform: translateX(0);      opacity: 1; }
    78%, 100% { transform: translateX(-28px); opacity: 0; }
  }

  /* ── Clean drawer animation ─────────────────────────────────────────── */
  .pv-drawer {
    position: absolute;
    inset: 0;
    background: rgba(250,250,250,0.98);
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: flex-end;
    gap: 9px;
    padding: 0 14px;
    animation: drawer-curtain 5.5s ease-in-out infinite;
    transform-origin: right center;
    border-right: 2px solid rgba(37,99,235,0.3);
  }

  @keyframes drawer-curtain {
    0%, 8%   { transform: translateX(100%); }
    18%, 72% { transform: translateX(0); }
    82%, 100% { transform: translateX(100%); }
  }

  .pv-dr-item {
    width: 62%;
    height: 7px;
    border-radius: 2px;
    background: rgba(0,0,0,0.55);
    animation: dr-slide 5.5s ease-out infinite;
    animation-delay: calc(var(--od) + 0.25s);
    transform: translateX(28px);
    opacity: 0;
  }

  .pv-dr-accent { background: #2563eb; width: 70%; }

  @keyframes dr-slide {
    0%, 22%  { transform: translateX(28px); opacity: 0; }
    32%, 68% { transform: translateX(0);     opacity: 1; }
    78%, 100% { transform: translateX(28px); opacity: 0; }
  }

  /* ── Card body ───────────────────────────────────────────────────────── */
  .card-body {
    padding: 1rem 1.125rem 1.125rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .card-name {
    font-size: 0.9375rem;
    font-weight: 700;
    color: var(--text);
  }

  .active-pill {
    font-size: 0.6875rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.125rem 0.5625rem;
    color: #fff;
    border-radius: 9999px;
    flex-shrink: 0;
  }

  .select-hint {
    font-size: 0.75rem;
    color: var(--tpl-accent);
    opacity: 0;
    transition: opacity 0.15s ease;
    flex-shrink: 0;
  }

  .tpl-card:hover .select-hint { opacity: 1; }

  .nav-badge {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.75rem;
    font-weight: 600;
  }

  .card-desc {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    line-height: 1.55;
    margin: 0;
  }

  .card-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-top: 0.125rem;
  }

  .tag {
    font-size: 0.6875rem;
    padding: 0.1875rem 0.5rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 9999px;
    color: var(--text-muted);
  }

  /* ── Nav legend ──────────────────────────────────────────────────────── */
  .nav-legend {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1.25rem 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.125rem;
  }

  .nav-legend h3 {
    font-size: 0.8125rem;
    font-weight: 700;
    color: var(--text);
    margin: 0;
    text-transform: uppercase;
    letter-spacing: 0.065em;
  }

  .legend-rows {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .legend-item {
    display: flex;
    align-items: flex-start;
    gap: 0.875rem;
  }

  /* Legend thumbs */
  .lt {
    flex-shrink: 0;
    width: 58px;
    height: 40px;
    border-radius: 4px;
    overflow: hidden;
    display: flex;
    align-items: center;
    padding: 6px;
    box-sizing: border-box;
  }

  .lt-topbar {
    background: #111;
    border: 1px solid rgba(255,255,255,0.08);
    justify-content: space-between;
    align-items: center;
    flex-direction: row;
  }

  .lt-topbar .lt-logo {
    width: 16px;
    height: 5px;
    background: #d4af37;
    border-radius: 2px;
  }

  .lt-links-row {
    display: flex;
    gap: 2px;
  }

  .lt-links-row div {
    width: 8px;
    height: 3px;
    background: rgba(255,255,255,0.3);
    border-radius: 1px;
  }

  .lt-center {
    background: #050505;
    border: 1px solid rgba(255,255,255,0.06);
    justify-content: space-between;
    align-items: center;
    flex-direction: row;
  }

  .lt-hb {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .lt-hb div, .lt-hb-right div {
    width: 9px;
    height: 1.5px;
    border-radius: 1px;
  }

  .lt-hb div { background: rgba(168,85,247,0.8); }

  .lt-center-logo {
    width: 20px;
    height: 5px;
    background: rgba(255,255,255,0.8);
    border-radius: 2px;
  }

  .lt-spacer { width: 14px; }

  .lt-drawer {
    background: #fafafa;
    border: 1px solid rgba(0,0,0,0.1);
    justify-content: space-between;
    align-items: center;
    flex-direction: row;
  }

  .lt-drawer .lt-logo {
    width: 14px;
    height: 4px;
    background: rgba(0,0,0,0.65);
    border-radius: 2px;
  }

  .lt-hb-right {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .lt-hb-right div { background: rgba(0,0,0,0.45); }

  .legend-text strong {
    display: block;
    font-size: 0.8125rem;
    font-weight: 700;
    color: var(--text);
    margin-bottom: 0.2rem;
  }

  .legend-text span {
    font-size: 0.75rem;
    color: var(--text-muted);
    line-height: 1.5;
  }

  .legend-tip {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0;
    padding-top: 0.875rem;
    border-top: 1px solid var(--border);
    line-height: 1.5;
  }

  .legend-tip strong { color: var(--text); }

  /* ── Reset warning ───────────────────────────────────────────────────── */
  .reset-warn {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0;
    padding: 0.75rem 1rem;
    background: color-mix(in srgb, #f59e0b 7%, var(--bg-surface));
    border: 1px solid color-mix(in srgb, #f59e0b 22%, transparent);
    border-radius: var(--radius-sm);
    line-height: 1.5;
  }
</style>
