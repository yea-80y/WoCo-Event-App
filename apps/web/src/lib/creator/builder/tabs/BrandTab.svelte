<script lang="ts">
  import type { Site, FontFamilyId, RadiusScale, SitePalette, NavStyleId, LogoSize } from "@woco/shared";
  import { compressImage, imgPreset } from "../../../utils.js";

  interface Props {
    site: Site;
    gatewayUrl?: string;
    pendingLogoBase64?: string | null;
  }

  let { site = $bindable(), gatewayUrl, pendingLogoBase64 = $bindable(null) }: Props = $props();

  // ── Logo ──────────────────────────────────────────────────────────────────
  let logoPreviewUrl = $state<string | null>(null);
  let logoError = $state('');
  let fileInput: HTMLInputElement | undefined = $state();

  const WOCO_GATEWAY = (import.meta as { env?: Record<string, string> }).env?.VITE_GATEWAY_URL ?? 'https://gateway.woco-net.com';

  function existingLogoUrl(): string | null {
    const ref = site.theme.logoSwarmRef;
    if (!ref || /^0+$/.test(ref)) return null;
    return `${gatewayUrl || WOCO_GATEWAY}/bytes/${ref}`;
  }

  async function handleLogoFile(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      logoError = 'Please select an image file';
      return;
    }

    logoError = '';
    logoPreviewUrl = URL.createObjectURL(file);
    pendingLogoBase64 = await compressImage(file, imgPreset.logo);
  }

  function removeLogo() {
    site.theme.logoSwarmRef = undefined;
    pendingLogoBase64 = null;
    logoPreviewUrl = null;
    logoError = '';
    if (fileInput) fileInput.value = '';
  }

  const displayLogoUrl = $derived(logoPreviewUrl ?? existingLogoUrl());
  const logoPending = $derived(!!pendingLogoBase64);

  const FONT_OPTIONS: { id: FontFamilyId; label: string; sample: string }[] = [
    { id: 'system', label: 'System', sample: 'Aa' },
    { id: 'serif', label: 'Serif', sample: 'Aa' },
    { id: 'display', label: 'Display', sample: 'Aa' },
  ];

  const RADIUS_OPTIONS: { id: RadiusScale; label: string; desc: string }[] = [
    { id: 'sm', label: 'Sharp', desc: '4px' },
    { id: 'md', label: 'Rounded', desc: '8px' },
    { id: 'lg', label: 'Pill', desc: '12px' },
  ];

  const LOGO_SIZE_OPTIONS: { id: LogoSize; label: string; navH: number; introBarH: number }[] = [
    { id: 'sm',  label: 'Small',   navH: 28, introBarH: 8  },
    { id: 'md',  label: 'Medium',  navH: 44, introBarH: 14 },
    { id: 'lg',  label: 'Large',   navH: 60, introBarH: 21 },
    { id: 'xl',  label: 'X-Large', navH: 80, introBarH: 28 },
  ];

  const NAV_OPTIONS: { id: NavStyleId; label: string; desc: string }[] = [
    { id: 'topbar',        label: 'Top Bar',        desc: 'Logo left, links right. Classic and scannable.' },
    { id: 'center-logo',   label: 'Center Logo',    desc: 'Brand centered, hamburger opens a fullscreen overlay. Optional logo-split intro animation.' },
    { id: 'overlay-drawer', label: 'Overlay Drawer', desc: 'Minimal header, hamburger opens a fullscreen menu from the right on all devices.' },
  ];

  const FONT_SAMPLE_STYLE: Record<FontFamilyId, string> = {
    system: "system-ui, -apple-system, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    display: "'Playfair Display', Georgia, serif",
  };

  const PRESETS: { name: string; palette: SitePalette }[] = [
    { name: 'Dark Pub',  palette: { bg:'#0d0a06', text:'#f2ede4', muted:'#9a8f7c', accent:'#c8860a', accentHover:'#a96e06', border:'#2e2318', cardBg:'#1a1208' } },
    { name: 'WoCo Dark', palette: { bg:'#09090f', text:'#eeeff5', muted:'#6a6a80', accent:'#7c6cf0', accentHover:'#6b5ad8', border:'#232340', cardBg:'#12121e' } },
    { name: 'Forest',    palette: { bg:'#0a0d0a', text:'#e8f0e8', muted:'#7a9070', accent:'#5c9e46', accentHover:'#4a8436', border:'#1e2e1e', cardBg:'#111811' } },
    { name: 'Ocean',     palette: { bg:'#050d14', text:'#e8f4f8', muted:'#6890a0', accent:'#2090c0', accentHover:'#1878a0', border:'#0e2030', cardBg:'#0a1820' } },
    { name: 'Rose',      palette: { bg:'#0f090b', text:'#f5eff0', muted:'#9a7a80', accent:'#d04060', accentHover:'#b03050', border:'#2a1218', cardBg:'#1a0c10' } },
    { name: 'Light',     palette: { bg:'#ffffff', text:'#111111', muted:'#666666', accent:'#2563eb', accentHover:'#1d4ed8', border:'#e5e7eb', cardBg:'#f9fafb' } },
  ];

  const TOKEN_LABELS: { key: keyof SitePalette; label: string }[] = [
    { key: 'bg',         label: 'Background' },
    { key: 'text',       label: 'Text' },
    { key: 'muted',      label: 'Muted text' },
    { key: 'accent',     label: 'Accent' },
    { key: 'accentHover',label: 'Accent hover' },
    { key: 'border',     label: 'Border' },
    { key: 'cardBg',     label: 'Card background' },
  ];

  function applyPreset(palette: SitePalette) {
    Object.assign(site.theme.palette, palette);
  }
</script>

<div class="brand-tab">
  <!-- Brand name -->
  <section class="section">
    <h3 class="section-title">Brand name</h3>
    <input
      class="input"
      type="text"
      value={site.theme.brandName}
      placeholder="Your Venue"
      oninput={(e) => { site.theme.brandName = (e.currentTarget as HTMLInputElement).value; }}
    />
  </section>

  <!-- Site description (SEO) -->
  <section class="section">
    <h3 class="section-title">Site description</h3>
    <p class="section-desc">Appears in search results and social sharing previews. Aim for 120–160 characters.</p>
    <textarea
      class="input textarea"
      rows="3"
      maxlength="200"
      placeholder="A welcoming neighbourhood pub with great food, live music and craft ales…"
      value={site.theme.siteDescription ?? ''}
      oninput={(e) => {
        const v = (e.currentTarget as HTMLTextAreaElement).value;
        site.theme.siteDescription = v || undefined;
      }}
    ></textarea>
    {#if (site.theme.siteDescription ?? '').length > 0}
      <span class="char-count">{(site.theme.siteDescription ?? '').length}/200</span>
    {/if}
  </section>

  <!-- Logo -->
  <section class="section">
    <h3 class="section-title">Logo</h3>
    <p class="section-desc">Replaces the brand name text in the site nav. PNG or SVG recommended, transparent background.</p>

    {#if displayLogoUrl}
      <div class="logo-preview-wrap">
        <img class="logo-preview" src={displayLogoUrl} alt="Logo preview" />
        <div class="logo-actions">
          {#if logoPending}
            <span class="logo-status">Ready — will upload on publish</span>
          {:else if site.theme.logoSwarmRef}
            <span class="logo-status ok">Saved to Swarm</span>
          {:else}
            <span class="logo-status">Local preview</span>
          {/if}
          <button class="logo-remove-btn" onclick={removeLogo}>Remove</button>
        </div>
      </div>
    {:else}
      <div class="logo-upload-area">
        <label class="logo-upload-label" for="logo-file-input">Choose logo image</label>
        <input
          id="logo-file-input"
          type="file"
          accept="image/*"
          class="logo-file-input"
          bind:this={fileInput}
          onchange={handleLogoFile}
        />
      </div>
    {/if}

    {#if logoError}
      <p class="logo-error">{logoError}</p>
    {/if}

    <!-- Logo size in nav -->
    <div class="logo-size-row">
      <span class="logo-size-label">Nav logo size</span>
      <div class="logo-size-options">
        {#each LOGO_SIZE_OPTIONS as opt}
          <button
            class="logo-size-btn"
            class:active={(site.theme.logoSize ?? 'md') === opt.id}
            onclick={() => { site.theme.logoSize = opt.id; }}
            title="{opt.label} — {opt.navH}px nav height"
          >
            <div class="logo-size-bar" style="height: {Math.round(opt.navH * 0.45)}px"></div>
            <span>{opt.label}</span>
          </button>
        {/each}
      </div>
    </div>
  </section>

  <!-- Font family -->
  <section class="section">
    <h3 class="section-title">Font family</h3>
    <div class="option-cards">
      {#each FONT_OPTIONS as opt}
        <button
          class="option-card"
          class:active={site.theme.fontFamily === opt.id}
          onclick={() => { site.theme.fontFamily = opt.id; }}
        >
          <span class="font-sample" style="font-family: {FONT_SAMPLE_STYLE[opt.id]}">{opt.sample}</span>
          <span class="option-label">{opt.label}</span>
        </button>
      {/each}
    </div>
  </section>

  <!-- Border radius -->
  <section class="section">
    <h3 class="section-title">Border radius</h3>
    <div class="option-cards">
      {#each RADIUS_OPTIONS as opt}
        <button
          class="option-card"
          class:active={site.theme.radius === opt.id}
          onclick={() => { site.theme.radius = opt.id; }}
        >
          <div class="radius-preview" style="border-radius: {opt.desc}"></div>
          <span class="option-label">{opt.label}</span>
          <span class="option-sub">{opt.desc}</span>
        </button>
      {/each}
    </div>
  </section>

  <!-- Navigation style -->
  <section class="section">
    <h3 class="section-title">Navigation style</h3>
    <p class="section-desc">How the menu is displayed on your published site. Can be changed at any time without affecting your pages.</p>
    <div class="nav-style-cards">
      {#each NAV_OPTIONS as opt}
        <button
          class="nav-style-card"
          class:active={( site.theme.navStyle ?? 'topbar') === opt.id}
          onclick={() => { site.theme.navStyle = opt.id; }}
        >
          <!-- Tiny visual thumbnail -->
          <div class="nsv-thumb nsv-{opt.id.replace('-', '-')}">
            {#if opt.id === 'topbar'}
              <div class="nsv-bar nsv-bar-topbar">
                <div class="nsv-dot"></div>
                <div class="nsv-links"><div></div><div></div><div></div></div>
              </div>
            {:else if opt.id === 'center-logo'}
              <div class="nsv-bar nsv-bar-center">
                <div class="nsv-hb"><div></div><div></div></div>
                <div class="nsv-dot nsv-dot-center"></div>
                <div class="nsv-spacer"></div>
              </div>
            {:else}
              <div class="nsv-bar nsv-bar-drawer">
                <div class="nsv-dot"></div>
                <div class="nsv-hb-right"><div></div><div></div></div>
              </div>
            {/if}
            <div class="nsv-body">
              <div class="nsv-h1"></div>
              <div class="nsv-h2"></div>
            </div>
          </div>
          <div class="ns-info">
            <span class="ns-label">{opt.label}</span>
            <span class="ns-desc">{opt.desc}</span>
          </div>
        </button>
      {/each}
    </div>

    {#if (site.theme.navStyle ?? 'topbar') === 'center-logo'}
      <label class="intro-toggle">
        <input
          type="checkbox"
          checked={site.theme.introAnimation !== false}
          onchange={(e) => { site.theme.introAnimation = (e.currentTarget as HTMLInputElement).checked; }}
        />
        <span>Show logo-split intro animation on page load</span>
      </label>

      {#if site.theme.introAnimation !== false}
        <div class="logo-size-row logo-size-row--indent">
          <span class="logo-size-label">Intro logo size</span>
          <div class="logo-size-options">
            {#each LOGO_SIZE_OPTIONS as opt}
              <button
                class="logo-size-btn"
                class:active={(site.theme.introLogoSize ?? 'lg') === opt.id}
                onclick={() => { site.theme.introLogoSize = opt.id; }}
                title="{opt.label} — ~{opt.introH} screen height"
              >
                <div class="logo-size-bar logo-size-bar--intro" style="height: {opt.introBarH}px"></div>
                <span>{opt.label}</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}
    {/if}
  </section>

  <!-- Colour palette -->
  <section class="section">
    <h3 class="section-title">Colour palette</h3>

    <div class="preset-grid">
      {#each PRESETS as preset}
        <button
          class="preset-card"
          onclick={() => applyPreset(preset.palette)}
          title="Apply {preset.name} preset"
        >
          <div class="preset-swatches">
            {#each [preset.palette.bg, preset.palette.cardBg, preset.palette.accent, preset.palette.text] as color}
              <div class="swatch" style="background: {color}"></div>
            {/each}
          </div>
          <span class="preset-name">{preset.name}</span>
        </button>
      {/each}
    </div>

    <div class="token-grid">
      {#each TOKEN_LABELS as { key, label }}
        <div class="token-row">
          <label class="token-label" for="color-{key}">{label}</label>
          <div class="token-inputs">
            <input
              id="color-{key}"
              type="color"
              class="color-swatch-input"
              value={site.theme.palette[key]}
              oninput={(e) => { site.theme.palette[key] = (e.currentTarget as HTMLInputElement).value; }}
            />
            <input
              class="input hex-input"
              type="text"
              value={site.theme.palette[key]}
              placeholder="#000000"
              oninput={(e) => {
                const v = (e.currentTarget as HTMLInputElement).value;
                if (/^#[0-9a-fA-F]{6}$/.test(v)) {
                  site.theme.palette[key] = v;
                }
              }}
            />
          </div>
        </div>
      {/each}
    </div>
  </section>
</div>

<style>
  .brand-tab {
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .section-title {
    font-size: 0.875rem;
    font-weight: 700;
    color: var(--text);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0;
  }

  .section-desc {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: -0.25rem 0 0;
  }

  /* ── Logo ── */
  .logo-preview-wrap {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .logo-preview {
    height: 48px;
    max-width: 200px;
    width: auto;
    object-fit: contain;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 4px;
    background: var(--bg-surface);
  }

  .logo-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .logo-status {
    font-size: 0.8125rem;
    color: var(--text-muted);
  }

  .logo-status.ok {
    color: #22c55e;
  }

  .logo-remove-btn {
    font-size: 0.8125rem;
    font-weight: 600;
    color: #ef4444;
    padding: 0.25rem 0.625rem;
    border: 1px solid color-mix(in srgb, #ef4444 30%, transparent);
    border-radius: var(--radius-sm);
    transition: background var(--transition);
  }

  .logo-remove-btn:hover {
    background: color-mix(in srgb, #ef4444 10%, transparent);
  }

  .logo-upload-area {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .logo-upload-label {
    display: inline-flex;
    align-items: center;
    padding: 0.5rem 1rem;
    background: var(--bg-surface);
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.875rem;
    color: var(--text-muted);
    cursor: pointer;
    transition: all var(--transition);
  }

  .logo-upload-label:hover {
    border-color: var(--accent);
    color: var(--text);
  }

  .logo-file-input {
    display: none;
  }

  .logo-error {
    font-size: 0.8125rem;
    color: #ef4444;
    margin: 0;
  }

  /* ── Logo size controls ── */
  .logo-size-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    padding-top: 0.25rem;
  }

  .logo-size-row--indent {
    margin-top: 0.75rem;
    padding-left: 1.625rem;
  }

  .logo-size-label {
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    white-space: nowrap;
    min-width: 7rem;
  }

  .logo-size-options {
    display: flex;
    gap: 0.375rem;
  }

  .logo-size-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    gap: 0.25rem;
    padding: 0.5rem 0.75rem 0.375rem;
    border: 2px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    color: var(--text-muted);
    font-size: 0.6875rem;
    font-weight: 600;
    min-width: 3.5rem;
    height: 3.5rem;
    transition: all var(--transition);
    cursor: pointer;
  }

  .logo-size-btn:hover {
    border-color: var(--border-hover);
    color: var(--text);
  }

  .logo-size-btn.active {
    border-color: var(--accent);
    color: var(--accent-text);
    background: var(--accent-subtle);
  }

  .logo-size-bar {
    width: 28px;
    background: currentColor;
    border-radius: 2px;
    min-height: 3px;
    opacity: 0.8;
  }

  .logo-size-bar--intro {
    width: 22px;
  }

  .input {
    padding: 0.5625rem 0.875rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 0.9375rem;
    font-family: inherit;
    transition: border-color var(--transition);
    width: 100%;
    box-sizing: border-box;
  }

  .input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .textarea {
    resize: vertical;
    min-height: 5rem;
    font-size: 0.875rem;
    line-height: 1.5;
  }

  .char-count {
    font-size: 0.75rem;
    color: var(--text-muted);
    align-self: flex-end;
  }

  /* ── Font / radius option cards ── */
  .option-cards {
    display: flex;
    gap: 0.625rem;
    flex-wrap: wrap;
  }

  .option-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 0.75rem 1rem;
    border: 2px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    cursor: pointer;
    transition: all var(--transition);
    min-width: 5rem;
  }

  .option-card:hover {
    border-color: var(--border-hover);
    background: var(--bg-elevated);
  }

  .option-card.active {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--bg-surface));
  }

  .font-sample {
    font-size: 1.5rem;
    line-height: 1;
    color: var(--text);
  }

  .option-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .option-sub {
    font-size: 0.6875rem;
    color: var(--text-muted);
  }

  .radius-preview {
    width: 2rem;
    height: 1.25rem;
    background: var(--accent);
    opacity: 0.7;
  }

  /* ── Nav style cards ── */
  .nav-style-cards {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.625rem;
  }

  @media (min-width: 500px) {
    .nav-style-cards {
      grid-template-columns: repeat(3, 1fr);
    }
  }

  .nav-style-card {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding: 0.75rem;
    border: 2px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    cursor: pointer;
    text-align: left;
    transition: all var(--transition);
  }

  .nav-style-card:hover {
    border-color: var(--border-hover);
    background: var(--bg-elevated);
  }

  .nav-style-card.active {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 7%, var(--bg-surface));
  }

  /* Thumbnail */
  .nsv-thumb {
    height: 48px;
    border-radius: 4px;
    overflow: hidden;
    background: #111;
    border: 1px solid rgba(255,255,255,0.06);
    display: flex;
    flex-direction: column;
  }

  .nsv-bar {
    display: flex;
    align-items: center;
    height: 14px;
    padding: 0 5px;
    gap: 3px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    background: rgba(255,255,255,0.02);
    flex-shrink: 0;
  }

  .nsv-bar-topbar { justify-content: space-between; }
  .nsv-bar-center { justify-content: space-between; }
  .nsv-bar-drawer { justify-content: space-between; }

  .nsv-dot {
    width: 18px;
    height: 4px;
    background: var(--accent);
    border-radius: 2px;
  }

  .nsv-dot-center {
    margin: 0 auto;
  }

  .nsv-links {
    display: flex;
    gap: 2px;
  }

  .nsv-links div {
    width: 8px;
    height: 3px;
    background: rgba(255,255,255,0.3);
    border-radius: 1px;
  }

  .nsv-hb, .nsv-hb-right {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .nsv-hb div, .nsv-hb-right div {
    width: 8px;
    height: 1.5px;
    background: rgba(255,255,255,0.5);
    border-radius: 1px;
  }

  .nsv-spacer { width: 16px; }

  .nsv-body {
    flex: 1;
    padding: 5px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .nsv-h1 {
    width: 70%;
    height: 4px;
    background: rgba(255,255,255,0.4);
    border-radius: 2px;
  }

  .nsv-h2 {
    width: 50%;
    height: 3px;
    background: rgba(255,255,255,0.15);
    border-radius: 2px;
  }

  .ns-info {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .ns-label {
    font-size: 0.8125rem;
    font-weight: 700;
    color: var(--text);
  }

  .ns-desc {
    font-size: 0.6875rem;
    color: var(--text-muted);
    line-height: 1.4;
  }

  .intro-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: var(--text-secondary);
    cursor: pointer;
    padding: 0.625rem 0.875rem;
    background: color-mix(in srgb, var(--accent) 7%, var(--bg-surface));
    border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
    border-radius: var(--radius-sm);
  }

  .intro-toggle input[type="checkbox"] {
    accent-color: var(--accent);
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
  }

  /* ── Presets ── */
  .preset-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.5rem;
  }

  @media (min-width: 500px) {
    .preset-grid {
      grid-template-columns: repeat(6, 1fr);
    }
  }

  .preset-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    cursor: pointer;
    transition: all var(--transition);
  }

  .preset-card:hover {
    border-color: var(--accent);
    background: var(--bg-elevated);
  }

  .preset-swatches {
    display: flex;
    gap: 2px;
    border-radius: 4px;
    overflow: hidden;
    width: 100%;
    height: 1.25rem;
  }

  .swatch {
    flex: 1;
  }

  .preset-name {
    font-size: 0.625rem;
    font-weight: 600;
    color: var(--text-muted);
    text-align: center;
    white-space: nowrap;
  }

  /* ── Token grid ── */
  .token-grid {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin-top: 0.25rem;
  }

  .token-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .token-label {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    width: 8rem;
    flex-shrink: 0;
  }

  .token-inputs {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex: 1;
  }

  .color-swatch-input {
    width: 2rem;
    height: 2rem;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
    flex-shrink: 0;
    background: none;
  }

  .color-swatch-input::-webkit-color-swatch-wrapper {
    padding: 2px;
  }

  .color-swatch-input::-webkit-color-swatch {
    border: none;
    border-radius: 2px;
  }

  .hex-input {
    font-family: monospace;
    font-size: 0.8125rem;
    max-width: 7rem;
    padding: 0.375rem 0.5rem;
  }
</style>
