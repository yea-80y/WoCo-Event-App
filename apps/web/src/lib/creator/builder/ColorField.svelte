<script lang="ts">
  /**
   * ColorField — a custom hex/HSV/Pantone colour picker.
   *
   * Replaces the native `<input type="color">` which: (a) fires `input` events
   * inconsistently across browsers (Firefox: only on close → previews lag),
   * (b) has a generic platform look that does not fit the rest of the builder.
   *
   * This component drives `bind:value` as a 6-char hex string with leading `#`.
   */
  import { PANTONE_COATED, lookupPantone, type PantoneEntry } from './pantone-coated.js';

  interface Props {
    value: string;
    label?: string;
    /** Optional list of recent colours to surface above the curated palette. */
    recents?: string[];
    id?: string;
  }

  let { value = $bindable('#000000'), label, recents = [], id }: Props = $props();

  // ── Curated palette — distinct, brand-friendly hues (no generic blue grid) ──
  const PALETTE: string[] = [
    // Row 1 — neutrals
    '#0A0A0A', '#1F1F1F', '#3D3D3D', '#6B6B6B', '#9A9A9A', '#CFCFCF', '#F2F2F2', '#FFFFFF',
    // Row 2 — acid + bright accents (matches "Concrete & Acid")
    '#C7F23A', '#A3E635', '#22D3A8', '#06B6D4', '#3B82F6', '#6366F1', '#8B5CF6', '#D946EF',
    // Row 3 — warm
    '#F472B6', '#EF4444', '#F97316', '#F59E0B', '#EAB308', '#84CC16', '#10B981', '#14B8A6',
    // Row 4 — deep / muted
    '#1E3A8A', '#312E81', '#581C87', '#831843', '#7F1D1D', '#78350F', '#365314', '#064E3B',
  ];

  // ── Local HSV state (single source of truth while user is interacting) ───
  let h = $state(0);  // 0–360
  let s = $state(0);  // 0–1
  let v = $state(0);  // 0–1
  let hexInput = $state(value);

  // Re-derive HSV whenever the bound `value` changes from outside (e.g. preset
  // applied, or a paired text input we don't own). We guard with a string
  // compare so internal HSV->hex updates don't trigger a feedback loop.
  let _lastHex = '';
  $effect(() => {
    if (!isHex(value)) return;
    if (value.toLowerCase() === _lastHex.toLowerCase()) return;
    const { h: nh, s: ns, v: nv } = hexToHsv(value);
    h = nh; s = ns; v = nv;
    hexInput = value.toUpperCase();
    _lastHex = value;
  });

  function commitFromHsv() {
    const hex = hsvToHex(h, s, v);
    _lastHex = hex;
    value = hex;
    hexInput = hex.toUpperCase();
  }

  // ── UI state ───────────────────────────────────────────────────────────
  let open = $state(false);
  let triggerEl: HTMLButtonElement | undefined = $state();
  let popoverEl: HTMLDivElement | undefined = $state();
  let pantoneOpen = $state(false);
  let pantoneQuery = $state('');
  const pantoneMatch = $derived<PantoneEntry | null>(
    pantoneQuery ? lookupPantone(pantoneQuery) : null,
  );

  const hasEyeDropper = typeof window !== 'undefined' && 'EyeDropper' in window;

  function toggle() {
    open = !open;
    if (open) {
      // Re-sync from value on open in case it changed during a quick edit cycle.
      if (isHex(value)) {
        const { h: nh, s: ns, v: nv } = hexToHsv(value);
        h = nh; s = ns; v = nv;
        hexInput = value.toUpperCase();
      }
    }
  }

  function handleDocPointer(e: PointerEvent) {
    if (!open) return;
    const tgt = e.target as Node;
    if (popoverEl?.contains(tgt)) return;
    if (triggerEl?.contains(tgt)) return;
    open = false;
  }

  function handleKey(e: KeyboardEvent) {
    if (open && e.key === 'Escape') {
      open = false;
      triggerEl?.focus();
    }
  }

  $effect(() => {
    if (open) {
      document.addEventListener('pointerdown', handleDocPointer, true);
      document.addEventListener('keydown', handleKey);
      return () => {
        document.removeEventListener('pointerdown', handleDocPointer, true);
        document.removeEventListener('keydown', handleKey);
      };
    }
  });

  // ── SV (saturation/value) plane drag handling ───────────────────────────
  let svEl: HTMLDivElement | undefined = $state();
  let svDragging = false;

  function svPick(e: PointerEvent) {
    if (!svEl) return;
    const rect = svEl.getBoundingClientRect();
    const x = clamp01((e.clientX - rect.left) / rect.width);
    const y = clamp01((e.clientY - rect.top) / rect.height);
    s = x;
    v = 1 - y;
    commitFromHsv();
  }

  function onSvDown(e: PointerEvent) {
    svDragging = true;
    svEl?.setPointerCapture(e.pointerId);
    svPick(e);
  }
  function onSvMove(e: PointerEvent) {
    if (!svDragging) return;
    svPick(e);
  }
  function onSvUp(e: PointerEvent) {
    svDragging = false;
    try { svEl?.releasePointerCapture(e.pointerId); } catch {/* noop */}
  }

  // ── Hue strip drag handling ─────────────────────────────────────────────
  let hueEl: HTMLDivElement | undefined = $state();
  let hueDragging = false;

  function huePick(e: PointerEvent) {
    if (!hueEl) return;
    const rect = hueEl.getBoundingClientRect();
    const x = clamp01((e.clientX - rect.left) / rect.width);
    h = Math.round(x * 360);
    commitFromHsv();
  }

  function onHueDown(e: PointerEvent) {
    hueDragging = true;
    hueEl?.setPointerCapture(e.pointerId);
    huePick(e);
  }
  function onHueMove(e: PointerEvent) {
    if (!hueDragging) return;
    huePick(e);
  }
  function onHueUp(e: PointerEvent) {
    hueDragging = false;
    try { hueEl?.releasePointerCapture(e.pointerId); } catch {/* noop */}
  }

  // ── Hex input ──────────────────────────────────────────────────────────
  function onHexInput(e: Event) {
    const raw = (e.currentTarget as HTMLInputElement).value;
    hexInput = raw;
    const normalised = normaliseHex(raw);
    if (normalised) {
      _lastHex = normalised;
      value = normalised;
      const { h: nh, s: ns, v: nv } = hexToHsv(normalised);
      h = nh; s = ns; v = nv;
    }
  }

  function onHexBlur() {
    // If user typed something invalid, snap input back to the canonical value.
    if (!normaliseHex(hexInput)) hexInput = value.toUpperCase();
  }

  function applyHex(hex: string) {
    const n = normaliseHex(hex);
    if (!n) return;
    _lastHex = n;
    value = n;
    hexInput = n.toUpperCase();
    const { h: nh, s: ns, v: nv } = hexToHsv(n);
    h = nh; s = ns; v = nv;
  }

  async function eyedrop() {
    try {
      // Chromium-only API. Cast through unknown to keep TS happy without lib types.
      const Ctor = (window as unknown as { EyeDropper: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper;
      const result = await new Ctor().open();
      applyHex(result.sRGBHex);
    } catch {
      // user cancelled — silent
    }
  }

  // ── Pantone search ─────────────────────────────────────────────────────
  function applyPantone(entry: PantoneEntry) {
    applyHex(entry.hex);
    pantoneQuery = `${entry.code}${entry.name ? ` · ${entry.name}` : ''}`;
  }

  // Show 4 recent Pantone suggestions when the field is empty (common codes).
  const PANTONE_SUGGESTIONS: PantoneEntry[] = [
    PANTONE_COATED.find((e) => e.code === '286')!,
    PANTONE_COATED.find((e) => e.code === '485')!,
    PANTONE_COATED.find((e) => e.code === '348')!,
    PANTONE_COATED.find((e) => e.code === 'Cool Gray 7 C')!,
  ];

  // ── Color helpers ──────────────────────────────────────────────────────
  function isHex(v: string): boolean {
    return /^#[0-9a-fA-F]{6}$/.test(v);
  }
  function normaliseHex(v: string): string | null {
    const t = v.trim();
    if (/^#?[0-9a-fA-F]{6}$/.test(t)) {
      return '#' + t.replace('#', '').toUpperCase();
    }
    if (/^#?[0-9a-fA-F]{3}$/.test(t)) {
      const c = t.replace('#', '');
      return '#' + (c[0] + c[0] + c[1] + c[1] + c[2] + c[2]).toUpperCase();
    }
    return null;
  }
  function clamp01(n: number) { return Math.min(1, Math.max(0, n)); }

  function hexToHsv(hex: string): { h: number; s: number; v: number } {
    const c = hex.replace('#', '');
    const r = parseInt(c.slice(0, 2), 16) / 255;
    const g = parseInt(c.slice(2, 4), 16) / 255;
    const b = parseInt(c.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let hh = 0;
    if (d !== 0) {
      if (max === r) hh = ((g - b) / d) % 6;
      else if (max === g) hh = (b - r) / d + 2;
      else hh = (r - g) / d + 4;
      hh = (hh * 60 + 360) % 360;
    }
    return { h: Math.round(hh), s: max === 0 ? 0 : d / max, v: max };
  }

  function hsvToHex(hh: number, ss: number, vv: number): string {
    const c = vv * ss;
    const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
    const m = vv - c;
    let r = 0, g = 0, b = 0;
    if (hh < 60)       { r = c; g = x; b = 0; }
    else if (hh < 120) { r = x; g = c; b = 0; }
    else if (hh < 180) { r = 0; g = c; b = x; }
    else if (hh < 240) { r = 0; g = x; b = c; }
    else if (hh < 300) { r = x; g = 0; b = c; }
    else               { r = c; g = 0; b = x; }
    const to2 = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
    return ('#' + to2(r) + to2(g) + to2(b)).toUpperCase();
  }

  // The hue-only base colour underneath the SV plane (full saturation, full value)
  const hueBase = $derived(hsvToHex(h, 1, 1));
</script>

<div class="cf">
  <button
    bind:this={triggerEl}
    type="button"
    class="cf-trigger"
    class:open
    onclick={toggle}
    aria-haspopup="dialog"
    aria-expanded={open}
    {id}
    title={label ? `${label} — ${value.toUpperCase()}` : value.toUpperCase()}
  >
    <span class="cf-swatch" style="background: {value};">
      <span class="cf-swatch-bg" aria-hidden="true"></span>
    </span>
    <span class="cf-hex">{value.replace('#', '').toUpperCase()}</span>
    <span class="cf-edit-icon" aria-hidden="true">
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
        <path d="M8.5 1.5l2 2-6.5 6.5-2.5.5.5-2.5 6.5-6.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
      </svg>
    </span>
  </button>

  {#if open}
    <div bind:this={popoverEl} class="cf-pop" role="dialog" aria-label="Colour picker">
      <!-- SV plane — pointer-drag surface; the hex input below is the keyboard path -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        bind:this={svEl}
        class="cf-sv"
        style="background:
          linear-gradient(to top, #000, transparent),
          linear-gradient(to right, #fff, {hueBase});"
        onpointerdown={onSvDown}
        onpointermove={onSvMove}
        onpointerup={onSvUp}
        onpointercancel={onSvUp}
      >
        <div
          class="cf-sv-thumb"
          style="left: {s * 100}%; top: {(1 - v) * 100}%; background: {value};"
        ></div>
      </div>

      <!-- Hue strip — pointer-drag surface; the hex input below is the keyboard path -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        bind:this={hueEl}
        class="cf-hue"
        onpointerdown={onHueDown}
        onpointermove={onHueMove}
        onpointerup={onHueUp}
        onpointercancel={onHueUp}
      >
        <div
          class="cf-hue-thumb"
          style="left: {(h / 360) * 100}%; background: {hsvToHex(h, 1, 1)};"
        ></div>
      </div>

      <!-- Hex + eyedropper -->
      <div class="cf-row">
        <span class="cf-prefix">#</span>
        <input
          class="cf-hex-input"
          type="text"
          value={hexInput.replace('#', '')}
          maxlength="6"
          spellcheck="false"
          autocomplete="off"
          aria-label="Hex value"
          oninput={onHexInput}
          onblur={onHexBlur}
        />
        {#if hasEyeDropper}
          <button
            type="button"
            class="cf-eye"
            title="Pick a colour from anywhere on screen"
            onclick={eyedrop}
            aria-label="Eyedropper"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M9.4 2.1l2.5 2.5L6 10.5l-2.6 0.7 0.7-2.6 5.3-6.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/>
              <path d="M8.5 3l2.5 2.5" stroke="currentColor" stroke-width="1.2"/>
            </svg>
          </button>
        {/if}
      </div>

      <!-- Curated palette -->
      {#if recents.length}
        <div class="cf-section-label">Recent</div>
        <div class="cf-grid cf-grid-recents">
          {#each recents.slice(0, 8) as c}
            <button
              type="button"
              class="cf-chip"
              class:active={c.toLowerCase() === value.toLowerCase()}
              style="background: {c};"
              title={c.toUpperCase()}
              onclick={() => applyHex(c)}
            ></button>
          {/each}
        </div>
      {/if}

      <div class="cf-section-label">Palette</div>
      <div class="cf-grid">
        {#each PALETTE as c}
          <button
            type="button"
            class="cf-chip"
            class:active={c.toLowerCase() === value.toLowerCase()}
            style="background: {c};"
            title={c.toUpperCase()}
            onclick={() => applyHex(c)}
          ></button>
        {/each}
      </div>

      <!-- Pantone (collapsible to keep the popover tight by default) -->
      <button
        type="button"
        class="cf-pantone-toggle"
        class:open={pantoneOpen}
        onclick={() => (pantoneOpen = !pantoneOpen)}
        aria-expanded={pantoneOpen}
      >
        <span class="cf-pantone-dot"></span>
        <span>Pantone reference</span>
        <span class="cf-disclosure" aria-hidden="true">{pantoneOpen ? '−' : '+'}</span>
      </button>

      {#if pantoneOpen}
        <div class="cf-pantone-body">
          <input
            class="cf-pantone-input"
            type="text"
            placeholder="e.g. PMS 286, 485 C, Cool Gray 7"
            spellcheck="false"
            autocomplete="off"
            bind:value={pantoneQuery}
            aria-label="Pantone code"
          />

          {#if pantoneMatch}
            <button type="button" class="cf-pantone-result" onclick={() => applyPantone(pantoneMatch!)}>
              <span class="cf-pantone-swatch" style="background: {pantoneMatch.hex};"></span>
              <span class="cf-pantone-meta">
                <span class="cf-pantone-code">PMS {pantoneMatch.code}{pantoneMatch.name ? ` · ${pantoneMatch.name}` : ''}</span>
                <span class="cf-pantone-hex">{pantoneMatch.hex.toUpperCase()}</span>
              </span>
              <span class="cf-pantone-apply">Apply</span>
            </button>
          {:else if pantoneQuery}
            <div class="cf-pantone-empty">No match. Try a code like “286” or “Cool Gray 7”.</div>
          {:else}
            <div class="cf-pantone-suggestions">
              {#each PANTONE_SUGGESTIONS as p}
                <button type="button" class="cf-pantone-suggest" onclick={() => applyPantone(p)} title="{p.code} → {p.hex}">
                  <span class="cf-pantone-suggest-sw" style="background: {p.hex};"></span>
                  <span class="cf-pantone-suggest-code">{p.code}</span>
                </button>
              {/each}
            </div>
          {/if}

          <p class="cf-pantone-note">
            Approximate sRGB conversion — for screen design only. Not a substitute for a Pantone print guide.
          </p>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* ── Trigger ────────────────────────────────────────────────────────── */
  .cf {
    position: relative;
    display: inline-flex;
    flex: 1;
    min-width: 0;
  }

  .cf-trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 4px 8px 4px 4px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    cursor: pointer;
    font-family: inherit;
    height: 32px;
    transition: border-color 120ms ease;
    min-width: 0;
  }
  .cf-trigger:hover  { border-color: var(--border-hover); }
  .cf-trigger.open,
  .cf-trigger:focus-visible {
    border-color: var(--accent);
    outline: none;
  }

  /* Swatch — checker bg shows through if user picks a partial-alpha color in
     future. Border ring picks up muted on dark for contrast on near-bg colors. */
  .cf-swatch {
    position: relative;
    width: 22px;
    height: 22px;
    border-radius: 2px;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08),
                inset 0 0 0 2px rgba(0, 0, 0, 0.18);
    flex-shrink: 0;
  }
  .cf-swatch-bg {
    position: absolute;
    inset: 0;
    border-radius: 2px;
    z-index: -1;
    background-image:
      linear-gradient(45deg, #444 25%, transparent 25%),
      linear-gradient(-45deg, #444 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #444 75%),
      linear-gradient(-45deg, transparent 75%, #444 75%);
    background-size: 6px 6px;
    background-position: 0 0, 0 3px, 3px -3px, -3px 0;
  }

  .cf-hex {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--text);
    white-space: nowrap;
  }

  .cf-edit-icon {
    display: inline-flex;
    align-items: center;
    color: var(--text-muted);
    opacity: 0;
    transition: opacity 150ms ease;
    margin-left: -1px;
  }

  .cf-trigger:hover .cf-edit-icon,
  .cf-trigger.open .cf-edit-icon {
    opacity: 1;
  }

  /* ── Popover ──────────────────────────────────────────────────────── */
  .cf-pop {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 1000;
    width: 264px;
    padding: 12px;
    background: var(--bg-elevated, var(--bg-surface));
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.42);
    display: flex;
    flex-direction: column;
    gap: 10px;
    /* Subtle inner texture — distinguishes from generic flat panels without being noisy */
    background-image:
      radial-gradient(circle at 1px 1px, rgba(255, 255, 255, 0.025) 1px, transparent 0);
    background-size: 14px 14px;
  }

  /* ── SV plane ─────────────────────────────────────────────────────── */
  .cf-sv {
    position: relative;
    width: 100%;
    height: 132px;
    border-radius: 4px;
    cursor: crosshair;
    touch-action: none;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.45);
  }

  .cf-sv-thumb {
    position: absolute;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    transform: translate(-50%, -50%);
    box-shadow:
      0 0 0 1.5px #fff,
      0 0 0 2.5px rgba(0, 0, 0, 0.5),
      0 1px 2px rgba(0, 0, 0, 0.4);
    pointer-events: none;
  }

  /* ── Hue strip ────────────────────────────────────────────────────── */
  .cf-hue {
    position: relative;
    width: 100%;
    height: 10px;
    border-radius: 5px;
    background: linear-gradient(
      to right,
      #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%,
      #0000ff 67%, #ff00ff 83%, #ff0000 100%
    );
    cursor: ew-resize;
    touch-action: none;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.45);
  }

  .cf-hue-thumb {
    position: absolute;
    top: 50%;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    transform: translate(-50%, -50%);
    box-shadow:
      0 0 0 2px #fff,
      0 0 0 3px rgba(0, 0, 0, 0.55);
    pointer-events: none;
  }

  /* ── Inputs row ───────────────────────────────────────────────────── */
  .cf-row {
    display: flex;
    align-items: center;
    gap: 6px;
    background: rgba(0, 0, 0, 0.25);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0 8px;
    height: 30px;
  }
  .cf-prefix {
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .cf-hex-input {
    flex: 1;
    background: transparent;
    border: 0;
    outline: 0;
    color: var(--text);
    font-family: ui-monospace, monospace;
    font-size: 0.8125rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 0;
    width: 0; /* let flex decide */
    min-width: 0;
  }
  .cf-hex-input::placeholder { color: var(--text-muted); }
  .cf-eye {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: color 120ms, border-color 120ms;
  }
  .cf-eye:hover { color: var(--text); border-color: var(--accent); }

  /* ── Sections ─────────────────────────────────────────────────────── */
  .cf-section-label {
    font-size: 0.625rem;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 2px 0 -2px;
  }

  /* ── Palette grid ─────────────────────────────────────────────────── */
  .cf-grid {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 4px;
  }
  .cf-grid-recents {
    grid-template-columns: repeat(8, 1fr);
  }
  .cf-chip {
    aspect-ratio: 1;
    width: 100%;
    border: 0;
    border-radius: 3px;
    padding: 0;
    cursor: pointer;
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.08),
      inset 0 0 0 2px rgba(0, 0, 0, 0.25);
    transition: transform 100ms ease;
  }
  .cf-chip:hover { transform: scale(1.12); }
  .cf-chip.active {
    box-shadow:
      0 0 0 1.5px var(--bg-elevated, var(--bg-surface)),
      0 0 0 3px var(--accent);
  }

  /* ── Pantone ──────────────────────────────────────────────────────── */
  .cf-pantone-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    background: transparent;
    border: 0;
    border-top: 1px dashed var(--border);
    padding: 8px 0 0;
    margin-top: 2px;
    color: var(--text-muted);
    font-family: inherit;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    cursor: pointer;
  }
  .cf-pantone-toggle:hover  { color: var(--text); }
  .cf-pantone-toggle.open   { color: var(--text); }
  .cf-pantone-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: linear-gradient(135deg, #E0457B 0%, #FFCD00 50%, #00A3E0 100%);
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.4);
  }
  .cf-disclosure {
    margin-left: auto;
    font-family: ui-monospace, monospace;
    font-size: 0.875rem;
    color: var(--text-muted);
    line-height: 1;
  }

  .cf-pantone-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .cf-pantone-input {
    background: rgba(0, 0, 0, 0.25);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: inherit;
    font-size: 0.8125rem;
    padding: 6px 8px;
    outline: none;
    transition: border-color 120ms;
  }
  .cf-pantone-input:focus { border-color: var(--accent); }
  .cf-pantone-input::placeholder { color: var(--text-muted); }

  .cf-pantone-result {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px 6px 6px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
    color: var(--text);
    font-family: inherit;
    text-align: left;
    transition: border-color 120ms;
  }
  .cf-pantone-result:hover { border-color: var(--accent); }
  .cf-pantone-swatch {
    width: 22px;
    height: 22px;
    border-radius: 2px;
    flex-shrink: 0;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.4);
  }
  .cf-pantone-meta {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .cf-pantone-code {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cf-pantone-hex {
    font-family: ui-monospace, monospace;
    font-size: 0.6875rem;
    color: var(--text-muted);
  }
  .cf-pantone-apply {
    font-size: 0.625rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--accent);
    padding: 3px 6px;
    border: 1px solid var(--accent);
    border-radius: 3px;
  }

  .cf-pantone-empty {
    font-size: 0.75rem;
    color: var(--text-muted);
    padding: 4px 2px;
  }

  .cf-pantone-suggestions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .cf-pantone-suggest {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 7px 3px 4px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-muted);
    cursor: pointer;
    font-family: inherit;
    font-size: 0.6875rem;
    transition: color 120ms, border-color 120ms;
  }
  .cf-pantone-suggest:hover { color: var(--text); border-color: var(--accent); }
  .cf-pantone-suggest-sw {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.4);
  }
  .cf-pantone-suggest-code {
    font-family: ui-monospace, monospace;
    font-size: 0.6875rem;
  }

  .cf-pantone-note {
    font-size: 0.625rem;
    line-height: 1.4;
    color: var(--text-muted);
    margin: 4px 0 0;
    font-style: italic;
  }
</style>
