<script lang="ts">
  import type { TemplateId } from "@woco/shared";

  interface Props {
    currentTemplateId: TemplateId;
    onselect: (id: TemplateId) => void;
  }

  let { currentTemplateId, onselect }: Props = $props();

  type NavType = 'topbar' | 'overlay' | 'drawer';
  type Tpl = {
    id: TemplateId;
    name: string;
    navLabel: string;
    navType: NavType;
    description: string;
    bestFor: string[];
    accent: string;
    sampleBrand: string;
    sampleHeadline: string;
    sampleTagline: string;
    motionLabel: string;
  };

  const templates: Tpl[] = [
    {
      id: 'pub-venue-v1' as TemplateId,
      name: 'Pub & Venue',
      navLabel: 'Top Bar',
      navType: 'topbar',
      description: 'Warm, atmospheric hospitality site with gold accents. Multi-page structure: home, what\'s on, visit, and contact.',
      bestFor: ['Pubs', 'Bars', 'Restaurants', 'Music Venues'],
      accent: '#d4af37',
      sampleBrand: 'The Old Vine',
      sampleHeadline: 'Live music & craft beer',
      sampleTagline: 'Every Friday from 8pm',
      motionLabel: 'Top-bar cascade reveal',
    },
    {
      id: 'nightlife-v1' as TemplateId,
      name: 'Nightlife & Club',
      navLabel: 'Center Logo + Overlay',
      navType: 'overlay',
      description: 'Dramatic dark design with a logo-split intro animation and fullscreen overlay menu. Built for maximum impression.',
      bestFor: ['Nightclubs', 'DJs', 'Promoters', 'Festivals'],
      accent: '#a855f7',
      sampleBrand: 'PULSE',
      sampleHeadline: 'After dark',
      sampleTagline: 'Sat 22:00 — late',
      motionLabel: 'Logo-split curtain reveal',
    },
    {
      id: 'clean-modern-v1' as TemplateId,
      name: 'Clean & Modern',
      navLabel: 'Overlay Drawer',
      navType: 'drawer',
      description: 'Light, airy and minimal with generous whitespace. Versatile for arts, galleries, festivals, and cultural organisations.',
      bestFor: ['Arts Venues', 'Galleries', 'Festivals', 'Cultural Orgs'],
      accent: '#2563eb',
      sampleBrand: 'Atelier',
      sampleHeadline: 'Now showing',
      sampleTagline: 'Group exhibition · open daily',
      motionLabel: 'Drawer slide-in reveal',
    },
  ];

  // ── State ────────────────────────────────────────────────────────────
  let viewMode = $state<'desktop' | 'mobile'>('desktop');
  let replayKey = $state<Record<string, number>>({
    'pub-venue-v1': 0,
    'nightlife-v1': 0,
    'clean-modern-v1': 0,
  });
  const autoPlayed = new Set<string>();

  function replay(id: string) {
    replayKey[id] = (replayKey[id] ?? 0) + 1;
  }

  // IntersectionObserver action: autoplay once when card scrolls into view
  function autoplay(node: HTMLElement, id: string) {
    if (typeof IntersectionObserver === 'undefined') return {};
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio >= 0.4 && !autoPlayed.has(id)) {
            autoPlayed.add(id);
            replay(id);
          }
        }
      },
      { threshold: [0.4] },
    );
    io.observe(node);
    return { destroy() { io.disconnect(); } };
  }

  // Switching view mode replays all previews so the new frame fills in immediately
  let lastView: 'desktop' | 'mobile' | null = null;
  $effect(() => {
    if (lastView !== null && lastView !== viewMode) {
      for (const t of templates) replay(t.id);
    }
    lastView = viewMode;
  });
</script>

<div class="template-tab">
  <header class="tab-header">
    <div class="header-row">
      <div>
        <h2>Choose a template</h2>
        <p>Templates set the default pages, layout, and visual style. You can switch at any time — your brand name, logo, and colours are always preserved.</p>
      </div>
      <div class="view-toggle" role="tablist" aria-label="Preview viewport">
        <button
          class="vt-btn"
          class:vt-active={viewMode === 'desktop'}
          role="tab"
          aria-selected={viewMode === 'desktop'}
          onclick={() => (viewMode = 'desktop')}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <rect x="1" y="2" width="12" height="8" rx="1" stroke="currentColor" stroke-width="1.2"/>
            <path d="M5 12h4M7 10v2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
          Desktop
        </button>
        <button
          class="vt-btn"
          class:vt-active={viewMode === 'mobile'}
          role="tab"
          aria-selected={viewMode === 'mobile'}
          onclick={() => (viewMode = 'mobile')}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <rect x="3" y="1" width="8" height="12" rx="1.3" stroke="currentColor" stroke-width="1.2"/>
            <circle cx="7" cy="11" r="0.6" fill="currentColor"/>
          </svg>
          Mobile
        </button>
      </div>
    </div>
  </header>

  <div class="template-grid" class:grid-mobile-mode={viewMode === 'mobile'}>
    {#each templates as t}
      {@const active = t.id === currentTemplateId}
      <div
        class="tpl-card"
        class:is-active={active}
        style="--tpl-accent: {t.accent}"
      >
        <!-- Whole card surface selects the template -->
        <button
          class="select-overlay"
          aria-label="Select {t.name} template"
          aria-pressed={active}
          onclick={() => onselect(t.id)}
        ></button>

        <!-- ── Animated preview ── mouseenter only replays the decorative
             animation; autoplay covers keyboard/touch users. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="preview-wrap"
          class:wrap-mobile={viewMode === 'mobile'}
          use:autoplay={t.id}
          onmouseenter={() => replay(t.id)}
        >
          <!-- Device chrome -->
          {#if viewMode === 'desktop'}
            <div class="chrome-desktop" aria-hidden="true">
              <span class="dot dot-r"></span>
              <span class="dot dot-y"></span>
              <span class="dot dot-g"></span>
              <span class="url-bar">{t.sampleBrand.toLowerCase().replace(/\s+/g, '')}.eth.limo</span>
            </div>
          {:else}
            <div class="chrome-mobile-notch" aria-hidden="true"></div>
          {/if}

          {#key replayKey[t.id]}
            <div class="preview preview-{t.navType}" data-view={viewMode}>

              <!-- ════════════════ PUB & VENUE — Golden Atmosphere ════════════════ -->
              {#if t.navType === 'topbar'}
                <div class="pv-nav">
                  <div class="pv-brand pv-fade-down" style="--d:0.05s">{t.sampleBrand}</div>
                  {#if viewMode === 'desktop'}
                    <div class="pv-links">
                      <span class="pv-link pv-fade-down" style="--d:0.22s">Home</span>
                      <span class="pv-link pv-fade-down" style="--d:0.30s">What's on</span>
                      <span class="pv-link pv-fade-down pv-link-active" style="--d:0.38s">Visit</span>
                      <span class="pv-link pv-fade-down" style="--d:0.46s">Contact</span>
                    </div>
                  {:else}
                    <div class="pv-burger pv-fade-down" style="--d:0.22s">
                      <span></span><span></span><span></span>
                    </div>
                  {/if}
                </div>

                <div class="pv-hero">
                  <div class="pv-headline pv-rise" style="--d:0.75s">{t.sampleHeadline}</div>
                  <div class="pv-tagline pv-rise" style="--d:0.95s">{t.sampleTagline}</div>
                  <div class="pv-cta pv-pop" style="--d:1.15s">Book a table</div>
                </div>

                <div class="pv-cards">
                  <div class="pv-event pv-rise-up" style="--d:1.4s">
                    <div class="pv-event-img"></div>
                    <div class="pv-event-title"></div>
                    <div class="pv-event-meta"></div>
                  </div>
                  <div class="pv-event pv-rise-up" style="--d:1.52s">
                    <div class="pv-event-img"></div>
                    <div class="pv-event-title"></div>
                    <div class="pv-event-meta"></div>
                  </div>
                  {#if viewMode === 'desktop'}
                    <div class="pv-event pv-rise-up" style="--d:1.64s">
                      <div class="pv-event-img"></div>
                      <div class="pv-event-title"></div>
                      <div class="pv-event-meta"></div>
                    </div>
                  {/if}
                </div>

              <!-- ════════════════ NIGHTLIFE — Logo-Split Curtain ════════════════ -->
              {:else if t.navType === 'overlay'}
                <!-- Final-state nav (revealed after curtain splits) -->
                <div class="nl-nav">
                  <div class="nl-burger nl-fade-in" style="--d:1.45s">
                    <span></span><span></span><span></span>
                  </div>
                  <div class="nl-brand-small nl-fade-in" style="--d:1.45s">{t.sampleBrand}</div>
                  <div class="nl-burger nl-spacer" aria-hidden="true"></div>
                </div>

                <div class="nl-hero">
                  <div class="nl-headline nl-slide-up" style="--d:1.65s">{t.sampleHeadline}</div>
                  <div class="nl-tagline nl-slide-up" style="--d:1.85s">{t.sampleTagline}</div>
                  <div class="nl-cta nl-fade-in-cta" style="--d:2.05s">See what's on</div>
                </div>

                <!-- The intro curtain — two halves that split apart after holding the logo -->
                <div class="nl-curtain nl-curtain-left" aria-hidden="true"></div>
                <div class="nl-curtain nl-curtain-right" aria-hidden="true"></div>
                <div class="nl-intro-logo" aria-hidden="true">
                  <span class="nl-intro-text">{t.sampleBrand}</span>
                </div>

                <!-- Overlay menu enters at end of timeline -->
                <div class="nl-overlay" aria-hidden="true">
                  <div class="nl-ol-x">×</div>
                  <div class="nl-ol-link nl-ol-active" style="--i:0">Home</div>
                  <div class="nl-ol-link" style="--i:1">Events</div>
                  <div class="nl-ol-link" style="--i:2">Gallery</div>
                  <div class="nl-ol-link" style="--i:3">Contact</div>
                </div>

              <!-- ════════════════ CLEAN & MODERN — Light Drawer ════════════════ -->
              {:else}
                <div class="cm-nav">
                  <div class="cm-brand cm-fade-down" style="--d:0.05s">{t.sampleBrand}</div>
                  <div class="cm-burger cm-fade-down cm-pulse" style="--d:0.25s">
                    <span></span><span></span><span></span>
                  </div>
                </div>

                <div class="cm-hero">
                  <div class="cm-headline cm-rise" style="--d:0.5s">{t.sampleHeadline}</div>
                  <div class="cm-tagline cm-rise" style="--d:0.7s">{t.sampleTagline}</div>
                  <div class="cm-cta cm-pop" style="--d:0.95s">What's On</div>
                </div>

                <div class="cm-cards">
                  <div class="cm-card cm-rise-up" style="--d:1.25s">
                    <div class="cm-card-img"></div>
                    <div class="cm-card-title"></div>
                    <div class="cm-card-meta"></div>
                  </div>
                  <div class="cm-card cm-rise-up" style="--d:1.4s">
                    <div class="cm-card-img"></div>
                    <div class="cm-card-title"></div>
                    <div class="cm-card-meta"></div>
                  </div>
                  {#if viewMode === 'desktop'}
                    <div class="cm-card cm-rise-up" style="--d:1.55s">
                      <div class="cm-card-img"></div>
                      <div class="cm-card-title"></div>
                      <div class="cm-card-meta"></div>
                    </div>
                  {/if}
                </div>

                <!-- Drawer slides in from right at end of timeline -->
                <div class="cm-drawer" aria-hidden="true">
                  <div class="cm-dr-x">×</div>
                  <div class="cm-dr-link cm-dr-active" style="--i:0">Home</div>
                  <div class="cm-dr-link" style="--i:1">Exhibitions</div>
                  <div class="cm-dr-link" style="--i:2">Events</div>
                  <div class="cm-dr-link" style="--i:3">Visit</div>
                </div>
              {/if}

              {#if active}
                <div class="preview-active-mark" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="8" fill="{t.accent}"/>
                    <path d="M4.5 8l2.2 2.2 4.8-4.8" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </div>
              {/if}
            </div>
          {/key}

          <!-- Motion caption + replay -->
          <div class="motion-bar">
            <span class="motion-dot" style="background:{t.accent}"></span>
            <span class="motion-label">{t.motionLabel}</span>
            <button
              class="replay-btn"
              type="button"
              aria-label="Replay animation"
              onclick={(e) => { e.stopPropagation(); replay(t.id); }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M2 6a4 4 0 1 0 1.2-2.85" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                <path d="M3.2 1.5v2h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              Replay
            </button>
          </div>
        </div>

        <!-- ── Card info ── -->
        <div class="card-body">
          <div class="card-top">
            <span class="card-name">{t.name}</span>
            {#if active}
              <span class="active-pill" style="background: {t.accent}">Active</span>
            {/if}
          </div>

          <div class="nav-badge" style="color: {t.accent}">
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

          {#if !active}
            <button
              class="card-select-btn"
              type="button"
              onclick={() => onselect(t.id)}
            >Use this template</button>
          {/if}
        </div>
      </div>
    {/each}
  </div>

  <p class="legend-tip">
    Switch the <strong>Desktop / Mobile</strong> toggle above to see how each layout adapts.
    The navigation style can be changed any time under the <strong>Brand</strong> tab.
  </p>

  <p class="reset-warn">
    Selecting a different template will replace all current pages and sections with template defaults. Your brand name, logo, and colours are always preserved.
  </p>
</div>

<style>
  /* ══════════════════════════════════════════════════════════════════════
     Layout
     ══════════════════════════════════════════════════════════════════════ */
  .template-tab {
    display: flex;
    flex-direction: column;
    gap: 1.75rem;
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

  .header-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1.25rem;
    flex-wrap: wrap;
  }

  /* View toggle */
  .view-toggle {
    display: inline-flex;
    padding: 3px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 999px;
    gap: 2px;
    flex-shrink: 0;
  }

  .vt-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.85rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
    background: transparent;
    border: none;
    border-radius: 999px;
    cursor: pointer;
    transition: background 0.18s ease, color 0.18s ease;
  }
  .vt-btn:hover { color: var(--text); }
  .vt-btn.vt-active {
    background: var(--bg-surface);
    color: var(--text);
    box-shadow: 0 1px 3px rgba(0,0,0,0.18);
  }

  /* Grid */
  .template-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1.25rem;
  }

  @media (min-width: 720px) {
    .template-grid {
      grid-template-columns: repeat(3, 1fr);
    }
  }

  /* In the builder's side rail (live canvas open) the three-up grid has no
     room — stack the template cards full-width instead. */
  @container builder-rail (max-width: 719px) {
    .template-grid {
      grid-template-columns: 1fr;
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
     Template card
     ══════════════════════════════════════════════════════════════════════ */
  .tpl-card {
    position: relative;
    display: flex;
    flex-direction: column;
    background: var(--bg-surface);
    border: 2px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.15s ease;
  }
  .tpl-card:hover {
    border-color: color-mix(in srgb, var(--tpl-accent) 55%, transparent);
    transform: translateY(-2px);
    box-shadow: 0 10px 30px rgba(0,0,0,0.2);
  }
  .tpl-card.is-active {
    border-color: var(--tpl-accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--tpl-accent) 18%, transparent);
  }

  .select-overlay {
    position: absolute;
    inset: 0;
    background: transparent;
    border: none;
    cursor: pointer;
    z-index: 1;
    /* Sits BEHIND interactive children (replay, select btn) which are z-index:2+ */
  }
  .select-overlay:focus-visible {
    outline: 2px solid var(--tpl-accent);
    outline-offset: -4px;
    border-radius: var(--radius-md);
  }

  /* ══════════════════════════════════════════════════════════════════════
     Device chrome + preview wrap
     ══════════════════════════════════════════════════════════════════════ */
  .preview-wrap {
    position: relative;
    z-index: 2;          /* above .select-overlay so replay-btn / motion-bar are clickable */
    padding: 0.875rem;
    background:
      radial-gradient(circle at 50% 30%, rgba(255,255,255,0.04), transparent 60%),
      linear-gradient(180deg, var(--bg-elevated), color-mix(in srgb, var(--bg-elevated) 70%, #000 30%));
    border-bottom: 1px solid var(--border);
  }

  .wrap-mobile {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  /* Desktop browser chrome */
  .chrome-desktop {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 10px;
    background: #1a1a1a;
    border: 1px solid rgba(255,255,255,0.08);
    border-bottom: none;
    border-radius: 6px 6px 0 0;
  }
  .chrome-desktop .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .dot-r { background: #ff5f57; }
  .dot-y { background: #febc2e; }
  .dot-g { background: #28c840; }
  .url-bar {
    margin-left: 12px;
    flex: 1;
    height: 13px;
    padding: 1px 8px;
    background: #0a0a0a;
    border-radius: 3px;
    font-size: 9px;
    font-family: 'SF Mono', ui-monospace, monospace;
    color: rgba(255,255,255,0.45);
    line-height: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Mobile notch */
  .chrome-mobile-notch {
    width: 232px;
    height: 18px;
    background: #1a1a1a;
    border: 1px solid rgba(255,255,255,0.08);
    border-bottom: none;
    border-radius: 22px 22px 0 0;
    position: relative;
  }
  .chrome-mobile-notch::after {
    content: '';
    position: absolute;
    top: 6px;
    left: 50%;
    transform: translateX(-50%);
    width: 48px;
    height: 5px;
    background: #000;
    border-radius: 999px;
  }

  /* The preview canvas */
  .preview {
    position: relative;
    overflow: hidden;
    height: 280px;
    background: #0f0f0f;
    border: 1px solid rgba(255,255,255,0.08);
    border-top: none;
    border-radius: 0 0 6px 6px;
  }

  .wrap-mobile .preview {
    width: 232px;
    height: 410px;
    border-radius: 0 0 22px 22px;
    border: 1px solid rgba(255,255,255,0.08);
    border-top: none;
  }

  .preview-topbar  { background: #0f0f0f; }
  .preview-overlay { background: #050505; }
  .preview-drawer  { background: #fafafa; }

  .preview-active-mark {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 50;
    filter: drop-shadow(0 2px 6px rgba(0,0,0,0.5));
  }

  /* Motion caption + replay button */
  .motion-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.625rem;
    padding: 0 2px;
  }
  .motion-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    box-shadow: 0 0 8px currentColor;
  }
  .motion-label {
    font-size: 0.7rem;
    color: var(--text-muted);
    flex: 1;
    letter-spacing: 0.02em;
  }
  .replay-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.25rem 0.6rem;
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 999px;
    cursor: pointer;
    transition: color 0.18s ease, border-color 0.18s ease, background 0.18s ease;
    position: relative;
    z-index: 3;
  }
  .replay-btn:hover {
    color: var(--text);
    border-color: var(--tpl-accent);
    background: color-mix(in srgb, var(--tpl-accent) 10%, transparent);
  }

  /* ══════════════════════════════════════════════════════════════════════
     Shared animation primitives
     ══════════════════════════════════════════════════════════════════════ */
  @keyframes fade-down {
    from { opacity: 0; transform: translateY(-6px); }
    to   { opacity: 1; transform: translateY(0);    }
  }
  @keyframes fade-up {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0);   }
  }
  @keyframes rise-soft {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0);    }
  }
  @keyframes pop-in {
    0%   { opacity: 0; transform: scale(0.85); }
    70%  { opacity: 1; transform: scale(1.04); }
    100% { opacity: 1; transform: scale(1);    }
  }
  @keyframes fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  /* ══════════════════════════════════════════════════════════════════════
     PUB & VENUE — Golden Atmosphere
     ══════════════════════════════════════════════════════════════════════ */
  .pv-nav {
    display: flex;
    justify-content: space-between;
    align-items: center;
    height: 32px;
    padding: 0 14px;
    background: rgba(0,0,0,0.45);
    border-bottom: 1px solid rgba(212,175,55,0.18);
    position: relative;
    z-index: 2;
  }
  .pv-brand {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 13px;
    font-weight: 700;
    color: #d4af37;
    letter-spacing: 0.04em;
  }
  .pv-links { display: flex; gap: 14px; }
  .pv-link {
    font-size: 9.5px;
    color: rgba(255,255,255,0.55);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 500;
  }
  .pv-link-active { color: #d4af37; }
  .pv-burger { display: flex; flex-direction: column; gap: 3px; }
  .pv-burger span {
    display: block; width: 14px; height: 1.5px;
    background: #d4af37; border-radius: 1px;
  }

  .pv-fade-down {
    opacity: 0;
    animation: fade-down 0.55s cubic-bezier(0.16, 1, 0.3, 1) var(--d) both;
  }

  /* Real hero: linear-gradient(160deg, var(--card-bg) 0%, var(--bg) 100%), centered */
  .pv-hero {
    padding: 26px 16px 18px;
    background: linear-gradient(160deg, #1a1a1a 0%, #0f0f0f 100%);
    text-align: center;
  }
  .pv-headline {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 18px;
    font-weight: 700;
    color: #f5f5f5;
    letter-spacing: -0.02em;
    line-height: 1.1;
  }
  .pv-tagline {
    margin-top: 6px;
    font-size: 10px;
    color: #a0a0a0;
    line-height: 1.55;
  }
  .pv-cta {
    display: inline-block;
    margin-top: 10px;
    padding: 6px 16px;
    font-size: 10px;
    font-weight: 600;
    color: #fff;
    background: #d4af37;
    border-radius: 3px;
  }
  .pv-rise {
    opacity: 0;
    animation: rise-soft 0.6s cubic-bezier(0.16, 1, 0.3, 1) var(--d) both;
  }
  .pv-pop {
    opacity: 0;
    animation: pop-in 0.55s cubic-bezier(0.34, 1.5, 0.64, 1) var(--d) both;
  }

  .pv-cards {
    display: flex;
    gap: 7px;
    padding: 10px 14px;
    background: #0f0d0a;
  }
  .pv-event {
    flex: 1;
    background: rgba(212,175,55,0.06);
    border: 1px solid rgba(212,175,55,0.18);
    border-radius: 3px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .pv-event-img {
    height: 22px;
    background: linear-gradient(135deg, rgba(212,175,55,0.4), rgba(212,175,55,0.1));
    border-radius: 2px;
  }
  .pv-event-title {
    height: 4px;
    width: 80%;
    background: rgba(245,233,201,0.6);
    border-radius: 1px;
  }
  .pv-event-meta {
    height: 3px;
    width: 55%;
    background: rgba(212,175,55,0.5);
    border-radius: 1px;
  }
  .pv-rise-up {
    opacity: 0;
    animation: rise-soft 0.55s cubic-bezier(0.16, 1, 0.3, 1) var(--d) both;
  }

  /* ══════════════════════════════════════════════════════════════════════
     NIGHTLIFE — Logo-Split Curtain Reveal
     ══════════════════════════════════════════════════════════════════════ */
  .nl-nav {
    display: flex;
    justify-content: space-between;
    align-items: center;
    height: 32px;
    padding: 0 14px;
    background: rgba(0,0,0,0.65);
    border-bottom: 1px solid rgba(168,85,247,0.2);
    position: relative;
    z-index: 2;
  }
  .nl-burger { display: flex; flex-direction: column; gap: 3px; }
  .nl-burger span {
    display: block; width: 14px; height: 1.5px;
    background: rgba(255,255,255,0.85); border-radius: 1px;
  }
  .nl-brand-small {
    font-family: 'Helvetica Neue', sans-serif;
    font-size: 11px;
    font-weight: 900;
    color: #fff;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }
  .nl-spacer { visibility: hidden; }
  .nl-fade-in {
    opacity: 0;
    animation: fade-in 0.5s ease var(--d) both;
  }

  /* Real hero: linear-gradient(160deg, card-bg → bg), centered, white text */
  .nl-hero {
    padding: 32px 16px 18px;
    background: linear-gradient(160deg, #0d0d0d 0%, #050505 100%);
    text-align: center;
  }
  .nl-headline {
    font-family: 'Helvetica Neue', sans-serif;
    font-size: 22px;
    font-weight: 700;
    color: #fff;
    letter-spacing: -0.02em;
    line-height: 1.1;
  }
  .nl-slide-up {
    opacity: 0;
    animation: rise-soft 0.6s cubic-bezier(0.16, 1, 0.3, 1) var(--d) both;
  }
  .nl-tagline {
    margin-top: 6px;
    font-size: 10px;
    color: #888;
    line-height: 1.55;
  }
  .nl-cta {
    display: inline-block;
    margin-top: 12px;
    padding: 6px 16px;
    font-size: 10px;
    font-weight: 600;
    color: #fff;
    background: #a855f7;
    border-radius: 3px;
  }
  .nl-fade-in-cta {
    opacity: 0;
    animation: pop-in 0.55s cubic-bezier(0.34, 1.5, 0.64, 1) var(--d) both;
  }

  /* The curtain — two halves filling the preview, splitting outward */
  .nl-curtain {
    position: absolute;
    top: 0; bottom: 0;
    width: 50%;
    background: #000;
    z-index: 10;
    animation-duration: 0.9s;
    animation-timing-function: cubic-bezier(0.76, 0, 0.24, 1);
    animation-delay: 1.15s;
    animation-fill-mode: forwards;
    box-shadow: 0 0 30px rgba(168,85,247,0.25);
  }
  .nl-curtain-left  { left: 0;  animation-name: nl-curtain-out-left;  }
  .nl-curtain-right { right: 0; animation-name: nl-curtain-out-right; }
  @keyframes nl-curtain-out-left {
    from { transform: translateX(0); }
    to   { transform: translateX(-100%); }
  }
  @keyframes nl-curtain-out-right {
    from { transform: translateX(0); }
    to   { transform: translateX(100%); }
  }

  /* Real intro: brand fades in (0.5s ease, 0.15s delay) + scales from 0.92,
     fades out (0.3s ease, 1.0s delay). No rim/ring. */
  .nl-intro-logo {
    position: absolute;
    left: 50%;
    top: 50%;
    z-index: 11;
    pointer-events: none;
    animation: nl-intro-show 0.5s ease 0.15s both, nl-intro-hide 0.3s ease 1.0s forwards;
    white-space: nowrap;
  }
  .nl-intro-text {
    font-family: 'Helvetica Neue', sans-serif;
    font-size: 26px;
    font-weight: 900;
    color: #fff;
    letter-spacing: -0.02em;
  }
  @keyframes nl-intro-show {
    from { opacity: 0; transform: translate(-50%, -50%) scale(0.92); }
    to   { opacity: 1; transform: translate(-50%, -50%) scale(1);    }
  }
  @keyframes nl-intro-hide {
    from { opacity: 1; }
    to   { opacity: 0; }
  }

  /* Overlay menu (appears at end of timeline) */
  .nl-overlay {
    position: absolute;
    inset: 0;
    background: rgba(5,5,5,0.97);
    z-index: 20;
    padding: 28px 22px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 6px;
    transform: translateX(-100%);
    animation: nl-overlay-slide 0.55s cubic-bezier(0.76, 0, 0.24, 1) 2.5s forwards;
    border-right: 2px solid rgba(168,85,247,0.4);
  }
  @keyframes nl-overlay-slide {
    to { transform: translateX(0); }
  }
  .nl-ol-x {
    position: absolute;
    top: 10px;
    right: 14px;
    color: rgba(255,255,255,0.5);
    font-size: 18px;
    line-height: 1;
  }
  .nl-ol-link {
    font-family: 'Helvetica Neue', sans-serif;
    font-size: 18px;
    font-weight: 900;
    color: #fff;
    letter-spacing: -0.02em;
    opacity: 0;
    transform: translateX(-20px);
    animation: nl-ol-in 0.45s cubic-bezier(0.34, 1.36, 0.64, 1) forwards;
    animation-delay: calc(2.7s + var(--i) * 0.08s);
  }
  .nl-ol-active { color: #a855f7; }
  @keyframes nl-ol-in {
    to { opacity: 1; transform: translateX(0); }
  }

  /* ══════════════════════════════════════════════════════════════════════
     CLEAN & MODERN — Light, airy, drawer
     ══════════════════════════════════════════════════════════════════════ */
  .cm-nav {
    display: flex;
    justify-content: space-between;
    align-items: center;
    height: 36px;
    padding: 0 16px;
    background: #fff;
    border-bottom: 1px solid rgba(0,0,0,0.06);
  }
  .cm-brand {
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 13px;
    font-weight: 800;
    color: #0a0a0a;
    letter-spacing: -0.02em;
  }
  .cm-burger { display: flex; flex-direction: column; gap: 3px; }
  .cm-burger span {
    display: block; width: 16px; height: 1.5px;
    background: #0a0a0a; border-radius: 1px;
  }
  .cm-pulse { animation: cm-burger-pulse 2.2s ease-in-out 2.0s infinite; }
  @keyframes cm-burger-pulse {
    0%, 100% { transform: scale(1);   filter: drop-shadow(0 0 0 transparent); }
    50%      { transform: scale(1.1); filter: drop-shadow(0 0 4px rgba(37,99,235,0.5)); }
  }
  .cm-fade-down {
    opacity: 0;
    animation: fade-down 0.5s cubic-bezier(0.16, 1, 0.3, 1) var(--d) both;
  }

  /* Real hero: linear-gradient(160deg, card-bg → bg), centered, dark text on white */
  .cm-hero {
    padding: 26px 18px 18px;
    background: linear-gradient(160deg, #f9fafb 0%, #ffffff 100%);
    text-align: center;
  }
  .cm-headline {
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 20px;
    font-weight: 700;
    color: #1a1a1a;
    letter-spacing: -0.02em;
    line-height: 1.1;
  }
  .cm-tagline {
    margin-top: 6px;
    font-size: 10px;
    color: #6b7280;
    line-height: 1.55;
  }
  .cm-cta {
    display: inline-block;
    margin-top: 10px;
    padding: 6px 16px;
    font-size: 10px;
    font-weight: 600;
    color: #fff;
    background: #2563eb;
    border-radius: 6px;
  }
  .cm-rise {
    opacity: 0;
    animation: rise-soft 0.55s cubic-bezier(0.16, 1, 0.3, 1) var(--d) both;
  }
  .cm-pop {
    opacity: 0;
    animation: pop-in 0.5s cubic-bezier(0.34, 1.5, 0.64, 1) var(--d) both;
  }

  .cm-cards {
    display: flex;
    gap: 8px;
    padding: 12px 16px;
    background: #fff;
  }
  .cm-card {
    flex: 1;
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 5px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .cm-card-img {
    height: 28px;
    background: linear-gradient(135deg, #e5e7eb, #cbd5e1);
    border-radius: 4px;
  }
  .cm-card-title {
    height: 4px;
    width: 80%;
    background: #1a1a1a;
    border-radius: 1px;
  }
  .cm-card-meta {
    height: 3px;
    width: 55%;
    background: #6b7280;
    border-radius: 1px;
  }
  .cm-rise-up {
    opacity: 0;
    animation: rise-soft 0.5s cubic-bezier(0.16, 1, 0.3, 1) var(--d) both;
  }

  /* Drawer slides in from right; items align center (matches MultiSiteApp drawer) */
  .cm-drawer {
    position: absolute;
    inset: 0;
    background: #fff;
    z-index: 20;
    padding: 32px 16px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    transform: translateX(100%);
    animation: cm-drawer-slide 0.55s cubic-bezier(0.76, 0, 0.24, 1) 2.2s forwards;
  }
  @keyframes cm-drawer-slide {
    to { transform: translateX(0); }
  }
  .cm-dr-x {
    position: absolute;
    top: 10px;
    right: 14px;
    color: rgba(0,0,0,0.4);
    font-size: 18px;
    line-height: 1;
  }
  .cm-dr-link {
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 18px;
    font-weight: 800;
    color: #1a1a1a;
    letter-spacing: -0.025em;
    opacity: 0;
    transform: translateX(18px);
    animation: cm-dr-in 0.45s cubic-bezier(0.34, 1.36, 0.64, 1) forwards;
    animation-delay: calc(2.55s + var(--i) * 0.07s);
  }
  .cm-dr-active { color: #2563eb; }
  @keyframes cm-dr-in {
    to { opacity: 1; transform: translateX(0); }
  }

  /* ══════════════════════════════════════════════════════════════════════
     Card body
     ══════════════════════════════════════════════════════════════════════ */
  .card-body {
    position: relative;
    padding: 1rem 1.125rem 1.125rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    z-index: 2;
    pointer-events: none;  /* Let .select-overlay receive clicks here */
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

  .card-select-btn {
    margin-top: 0.5rem;
    padding: 0.5rem 0.875rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--tpl-accent);
    background: color-mix(in srgb, var(--tpl-accent) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--tpl-accent) 35%, transparent);
    border-radius: var(--radius-sm);
    cursor: pointer;
    pointer-events: auto;
    position: relative;
    z-index: 3;
    transition: background 0.18s ease, border-color 0.18s ease;
  }
  .card-select-btn:hover {
    background: color-mix(in srgb, var(--tpl-accent) 18%, transparent);
    border-color: var(--tpl-accent);
  }

  /* ══════════════════════════════════════════════════════════════════════
     Tips
     ══════════════════════════════════════════════════════════════════════ */
  .legend-tip {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0;
    padding: 0.875rem 1.125rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    line-height: 1.55;
  }
  .legend-tip strong { color: var(--text); }

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

  /* Reduce motion support */
  @media (prefers-reduced-motion: reduce) {
    .pv-fade-down, .pv-rise, .pv-pop, .pv-rise-up,
    .nl-fade-in, .nl-slide-up, .nl-fade-in-cta,
    .nl-curtain, .nl-intro-logo, .nl-overlay, .nl-ol-link,
    .cm-fade-down, .cm-rise, .cm-pop, .cm-rise-up, .cm-pulse, .cm-drawer, .cm-dr-link {
      animation: none !important;
      opacity: 1 !important;
      transform: none !important;
    }
    .nl-curtain, .nl-intro-logo { display: none; }
    .nl-overlay { transform: translateX(-100%); }
    .cm-drawer { transform: translateX(100%); }
  }
</style>
