<script lang="ts">
  import type { MySiteRecord } from './types.js';

  interface Props {
    sites: MySiteRecord[];
    gatewayUrl: string;
    onopen: (record: MySiteRecord) => void;
    onnew: () => void;
    onloadbyid: (id: string) => void;
    loadingId?: string;
  }

  let { sites, gatewayUrl, onopen, onnew, onloadbyid, loadingId }: Props = $props();

  let showAdvanced = $state(false);
  let advancedId = $state('');
  let advancedState = $state<'idle' | 'loading' | 'error'>('idle');
  let advancedError = $state('');

  function logoUrl(rec: MySiteRecord): string | undefined {
    if (!rec.logoSwarmRef || /^0+$/.test(rec.logoSwarmRef)) return undefined;
    return `${gatewayUrl}/bytes/${rec.logoSwarmRef}`;
  }

  function timeAgo(ts: number): string {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60_000);
    if (mins < 2) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    const months = Math.floor(days / 30);
    return months === 1 ? 'a month ago' : `${months} months ago`;
  }

  function initial(name: string): string {
    return name.trim().charAt(0).toUpperCase() || '?';
  }

  async function handleAdvancedLoad() {
    const id = advancedId.trim();
    if (!id) return;
    advancedState = 'loading';
    advancedError = '';
    try {
      await onloadbyid(id);
      advancedState = 'idle';
    } catch (e) {
      advancedError = e instanceof Error ? e.message : 'Site not found';
      advancedState = 'error';
    }
  }
</script>

<div class="screen">
  <header class="header">
    <div class="header-inner">
      <div class="header-text">
        <h1 class="title">Your websites</h1>
        <p class="subtitle">Click a site to open the builder and make changes.</p>
      </div>
      <button class="new-btn" onclick={onnew}>
        <span class="new-icon">+</span>
        New site
      </button>
    </div>
  </header>

  <main class="main">
    {#if sites.length === 0}
      <!-- Empty state -->
      <div class="empty">
        <div class="empty-icon" aria-hidden="true">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
            <rect x="4" y="8" width="40" height="32" rx="4" stroke="currentColor" stroke-width="2" fill="none" opacity=".3"/>
            <rect x="4" y="8" width="40" height="10" rx="4" stroke="currentColor" stroke-width="2" fill="none"/>
            <circle cx="10" cy="13" r="2" fill="currentColor" opacity=".5"/>
            <circle cx="16" cy="13" r="2" fill="currentColor" opacity=".5"/>
            <line x1="14" y1="26" x2="34" y2="26" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".4"/>
            <line x1="14" y1="32" x2="28" y2="32" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".3"/>
          </svg>
        </div>
        <h2 class="empty-title">No websites yet</h2>
        <p class="empty-desc">Build your venue's website in minutes — we'll walk you through it step by step.</p>
        <button class="empty-cta" onclick={onnew}>
          Create your first website →
        </button>
      </div>

    {:else}
      <div class="grid">
        {#each sites as rec (rec.siteId)}
          {@const img = logoUrl(rec)}
          {@const isLoading = loadingId === rec.siteId}
          <article class="card" style="--site-accent: {rec.accentColor};">
            <!-- Card banner -->
            <div class="card-banner">
              {#if img}
                <img class="card-logo" src={img} alt={rec.brandName} />
              {:else}
                <div class="card-initial" aria-hidden="true">{initial(rec.brandName)}</div>
              {/if}
            </div>

            <!-- Card body -->
            <div class="card-body">
              <div class="card-header-row">
                <h2 class="card-name">{rec.brandName}</h2>
                {#if rec.publishedAt}
                  <span class="card-badge live">
                    <span class="live-dot" aria-hidden="true"></span>
                    Live
                  </span>
                {:else}
                  <span class="card-badge draft">Draft</span>
                {/if}
              </div>

              {#if rec.publishedAt}
                <p class="card-meta">Published {timeAgo(rec.publishedAt)}</p>
              {:else}
                <p class="card-meta">Not yet published</p>
              {/if}

              {#if rec.deployedUrl}
                <a
                  class="card-url"
                  href={rec.deployedUrl}
                  target="_blank"
                  rel="noopener"
                  title={rec.deployedUrl}
                >
                  <span class="card-url-icon" aria-hidden="true">↗</span>
                  {rec.deployedUrl.replace(/^https?:\/\//, '').slice(0, 42)}{rec.deployedUrl.length > 52 ? '…' : ''}
                </a>
              {/if}
            </div>

            <!-- Card footer -->
            <div class="card-footer">
              <button
                class="open-btn"
                class:loading={isLoading}
                onclick={() => onopen(rec)}
                disabled={isLoading}
                aria-label="Open builder for {rec.brandName}"
              >
                {#if isLoading}
                  <span class="btn-spinner" aria-hidden="true"></span>
                  Opening…
                {:else}
                  Open Builder →
                {/if}
              </button>
            </div>
          </article>
        {/each}

        <!-- Add another site tile -->
        <button class="add-card" onclick={onnew} aria-label="Create a new website">
          <span class="add-icon" aria-hidden="true">+</span>
          <span class="add-label">New website</span>
        </button>
      </div>
    {/if}

    <!-- Advanced: load by Site ID (hidden by default) -->
    <div class="advanced-section">
      <button
        class="advanced-toggle"
        onclick={() => { showAdvanced = !showAdvanced; }}
        aria-expanded={showAdvanced}
      >
        {showAdvanced ? '▲' : '▼'} Load a site from another device
      </button>

      {#if showAdvanced}
        <div class="advanced-panel">
          <p class="advanced-hint">
            If you built a site on a different device, enter the Site ID shown in the deploy banner to load it here.
          </p>
          <div class="advanced-row">
            <input
              class="advanced-input"
              type="text"
              placeholder="Paste Site ID…"
              bind:value={advancedId}
              onkeydown={(e) => { if (e.key === 'Enter') handleAdvancedLoad(); }}
            />
            <button
              class="advanced-load-btn"
              onclick={handleAdvancedLoad}
              disabled={advancedState === 'loading' || !advancedId.trim()}
            >
              {advancedState === 'loading' ? 'Loading…' : 'Load'}
            </button>
          </div>
          {#if advancedState === 'error'}
            <p class="advanced-error">{advancedError}</p>
          {/if}
        </div>
      {/if}
    </div>
  </main>
</div>

<style>
  .screen {
    min-height: calc(100vh - 10rem);
    display: flex;
    flex-direction: column;
    background: var(--bg-surface);
  }

  /* ── Header ───────────────────────────────────────────────────────── */
  .header {
    border-bottom: 1px solid var(--border);
    background: var(--bg-elevated);
    padding: 2rem 1.5rem 1.5rem;
  }

  .header-inner {
    max-width: 960px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .title {
    font-size: clamp(1.5rem, 3vw, 2rem);
    font-weight: 800;
    color: var(--text);
    margin: 0 0 0.25rem;
    letter-spacing: -0.02em;
  }

  .subtitle {
    font-size: 0.9375rem;
    color: var(--muted);
    margin: 0;
  }

  /* New site button */
  .new-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.625rem 1.25rem;
    background: var(--accent);
    color: #fff;
    border-radius: var(--radius-md);
    font-size: 0.9375rem;
    font-weight: 700;
    transition: background 150ms ease, transform 100ms ease;
    white-space: nowrap;
  }

  .new-btn:hover {
    background: var(--accent-hover);
    transform: translateY(-1px);
  }

  .new-icon {
    font-size: 1.125rem;
    line-height: 1;
    font-weight: 400;
  }

  /* ── Main ─────────────────────────────────────────────────────────── */
  .main {
    flex: 1;
    padding: 2rem 1.5rem 3rem;
    max-width: 960px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
  }

  /* ── Empty state ──────────────────────────────────────────────────── */
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 4rem 1rem;
    gap: 1rem;
  }

  .empty-icon {
    color: var(--muted);
    opacity: 0.6;
    margin-bottom: 0.5rem;
  }

  .empty-title {
    font-size: 1.375rem;
    font-weight: 700;
    color: var(--text);
    margin: 0;
  }

  .empty-desc {
    font-size: 0.9375rem;
    color: var(--muted);
    max-width: 380px;
    line-height: 1.6;
    margin: 0;
  }

  .empty-cta {
    margin-top: 0.5rem;
    padding: 0.75rem 1.75rem;
    background: var(--accent);
    color: #fff;
    border-radius: var(--radius-md);
    font-size: 1rem;
    font-weight: 700;
    transition: background 150ms ease, transform 100ms ease;
  }

  .empty-cta:hover {
    background: var(--accent-hover);
    transform: translateY(-1px);
  }

  /* ── Card grid ────────────────────────────────────────────────────── */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 1.25rem;
  }

  /* ── Site card ────────────────────────────────────────────────────── */
  .card {
    display: flex;
    flex-direction: column;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    transition: transform 200ms ease, box-shadow 200ms ease;
  }

  .card:hover {
    transform: translateY(-3px);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
  }

  /* Card banner — coloured gradient using the site's accent */
  .card-banner {
    height: 110px;
    background: linear-gradient(
      135deg,
      color-mix(in srgb, var(--site-accent) 40%, #000) 0%,
      color-mix(in srgb, var(--site-accent) 20%, #000) 100%
    );
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    border-bottom: 1px solid color-mix(in srgb, var(--site-accent) 30%, transparent);
  }

  .card-logo {
    width: 64px;
    height: 64px;
    object-fit: contain;
    border-radius: var(--radius-md);
    background: rgba(255,255,255,0.08);
    padding: 4px;
  }

  .card-initial {
    width: 64px;
    height: 64px;
    border-radius: var(--radius-md);
    background: rgba(255,255,255,0.12);
    color: #fff;
    font-size: 2rem;
    font-weight: 800;
    display: flex;
    align-items: center;
    justify-content: center;
    letter-spacing: -0.02em;
  }

  /* Card body */
  .card-body {
    flex: 1;
    padding: 1rem 1.125rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .card-header-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .card-name {
    font-size: 1.0625rem;
    font-weight: 700;
    color: var(--text);
    margin: 0;
    line-height: 1.3;
    flex: 1;
  }

  .card-badge {
    flex-shrink: 0;
    font-size: 0.6875rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0.2em 0.55em;
    border-radius: 9999px;
    display: flex;
    align-items: center;
    gap: 0.3em;
    margin-top: 2px;
  }

  .card-badge.live {
    background: color-mix(in srgb, #22c55e 15%, transparent);
    color: #4ade80;
    border: 1px solid color-mix(in srgb, #22c55e 30%, transparent);
  }

  .card-badge.draft {
    background: color-mix(in srgb, var(--muted) 15%, transparent);
    color: var(--muted);
    border: 1px solid var(--border);
  }

  .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #4ade80;
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.4; }
  }

  .card-meta {
    font-size: 0.8125rem;
    color: var(--muted);
    margin: 0;
  }

  .card-url {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: var(--accent);
    text-decoration: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 0.125rem;
  }

  .card-url:hover { text-decoration: underline; }

  .card-url-icon {
    flex-shrink: 0;
    font-size: 0.75rem;
  }

  /* Card footer */
  .card-footer {
    padding: 0.75rem 1.125rem 1rem;
    border-top: 1px solid var(--border);
  }

  .open-btn {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    padding: 0.5625rem 1rem;
    background: var(--site-accent);
    color: #fff;
    border-radius: var(--radius-sm);
    font-size: 0.875rem;
    font-weight: 700;
    transition: opacity 150ms ease, transform 100ms ease;
    white-space: nowrap;
  }

  .open-btn:hover:not(:disabled) {
    opacity: 0.88;
    transform: translateY(-1px);
  }

  .open-btn:disabled {
    cursor: not-allowed;
    opacity: 0.7;
  }

  .open-btn.loading {
    opacity: 0.75;
  }

  .btn-spinner {
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    display: inline-block;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* ── Add-another tile ─────────────────────────────────────────────── */
  .add-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.625rem;
    min-height: 230px;
    border: 2px dashed var(--border);
    border-radius: var(--radius-lg);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    transition: border-color 200ms ease, color 200ms ease, background 200ms ease;
  }

  .add-card:hover {
    border-color: var(--accent);
    color: var(--text);
    background: color-mix(in srgb, var(--accent) 5%, transparent);
  }

  .add-icon {
    font-size: 2rem;
    font-weight: 300;
    line-height: 1;
  }

  .add-label {
    font-size: 0.875rem;
    font-weight: 600;
  }

  /* ── Advanced / load by ID ────────────────────────────────────────── */
  .advanced-section {
    margin-top: 3rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--border);
  }

  .advanced-toggle {
    font-size: 0.8125rem;
    color: var(--muted);
    background: none;
    padding: 0;
    cursor: pointer;
    transition: color 150ms ease;
  }

  .advanced-toggle:hover { color: var(--text); }

  .advanced-panel {
    margin-top: 1rem;
    padding: 1rem 1.125rem;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .advanced-hint {
    font-size: 0.8125rem;
    color: var(--muted);
    margin: 0;
    line-height: 1.5;
  }

  .advanced-row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .advanced-input {
    flex: 1;
    min-width: 12rem;
    padding: 0.375rem 0.625rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 0.8125rem;
    font-family: monospace;
  }

  .advanced-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .advanced-load-btn {
    padding: 0.375rem 0.875rem;
    font-size: 0.8125rem;
    font-weight: 600;
    background: var(--accent);
    color: #fff;
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }

  .advanced-load-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .advanced-error {
    font-size: 0.8125rem;
    color: #ef4444;
    margin: 0;
  }
</style>
