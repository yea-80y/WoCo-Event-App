<script lang="ts">
  /**
   * Live site canvas — renders the real multisite runtime (multi-site.html) in
   * an iframe and re-pushes the builder's config snapshot on every (debounced)
   * edit. The iframe handshakes for its first config via `woco-preview-request`
   * (answered by MultiSiteBuilder's global responder), so `data` only needs to
   * cover subsequent edits.
   */
  interface Props {
    /** JSON SiteRuntimeConfig snapshot — debounced upstream. */
    data: string;
    /** Fullscreen overlay (small screens) instead of a docked panel. */
    overlay?: boolean;
    onclose?: () => void;
    /** Open the full-tab preview (existing openPreview flow). */
    onopenfull?: () => void;
    /** Collapse the docked pane (desktop split view only). */
    onminimize?: () => void;
  }
  let { data, overlay = false, onclose, onopenfull, onminimize }: Props = $props();

  let iframeEl = $state<HTMLIFrameElement | undefined>();
  let loaded = $state(false);
  let device = $state<'desktop' | 'mobile'>('desktop');
  let stageW = $state(0);
  let stageH = $state(0);

  const DEVICE_W: Record<'desktop' | 'mobile', number> = { desktop: 1280, mobile: 390 };
  const GUTTER = 28; // stage padding around the frame

  const frameW = $derived(DEVICE_W[device]);
  const scale = $derived(
    stageW > 0 ? Math.min(1, (stageW - GUTTER * 2) / frameW) : 1
  );
  const frameH = $derived(
    stageH > 0 ? Math.max(240, Math.round((stageH - GUTTER * 2) / scale)) : 800
  );

  // Push the latest snapshot whenever it changes, once the iframe is ready.
  $effect(() => {
    if (!loaded || !data) return;
    iframeEl?.contentWindow?.postMessage({ type: 'woco-preview', data }, '*');
  });
</script>

<div class="preview-pane" class:overlay>
  <div class="pane-bar">
    <span class="live-tag">
      <span class="live-dot" aria-hidden="true"></span>
      Live preview
    </span>

    <div class="pane-controls">
      {#if !overlay}
        <div class="device-toggle" role="group" aria-label="Preview device">
          <button
            class="device-btn"
            class:active={device === 'desktop'}
            onclick={() => (device = 'desktop')}
            title="Desktop preview"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="1" y="2" width="12" height="8" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M5 12.5h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
            Desktop
          </button>
          <button
            class="device-btn"
            class:active={device === 'mobile'}
            onclick={() => (device = 'mobile')}
            title="Mobile preview"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="3.5" y="1" width="7" height="12" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M6 11h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
            Mobile
          </button>
        </div>
      {/if}

      {#if onopenfull}
        <button class="pane-action" onclick={onopenfull} title="Open full preview in a new tab">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M6 2H2v10h10V8M9 2h3v3M8 6l4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="pane-action-label">Full tab</span>
        </button>
      {/if}

      {#if !overlay && onminimize}
        <button class="pane-action" onclick={onminimize} title="Hide the preview panel — the editor gets the full width">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M5 3l4 4-4 4M12 2v10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="pane-action-label">Hide</span>
        </button>
      {/if}

      {#if overlay && onclose}
        <button class="pane-action pane-close" onclick={onclose} title="Back to editing">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          Close
        </button>
      {/if}
    </div>
  </div>

  <div class="stage" bind:clientWidth={stageW} bind:clientHeight={stageH}>
    {#if overlay}
      <iframe
        class="frame frame-fill"
        bind:this={iframeEl}
        src="./multi-site.html"
        title="Live site preview"
        onload={() => (loaded = true)}
      ></iframe>
    {:else}
      <div class="frame-box" style="width: {Math.round(frameW * scale)}px;">
        <iframe
          class="frame"
          bind:this={iframeEl}
          src="./multi-site.html"
          title="Live site preview"
          style="width: {frameW}px; height: {frameH}px; transform: scale({scale});"
          onload={() => (loaded = true)}
        ></iframe>
      </div>
    {/if}
  </div>
</div>

<style>
  .preview-pane {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: #080807;
  }

  .preview-pane.overlay {
    position: fixed;
    inset: 0;
    z-index: 400;
    height: 100dvh;
  }

  /* ── Caption bar ── */
  .pane-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.4375rem 0.875rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
    flex-shrink: 0;
  }

  .live-tag {
    display: flex;
    align-items: center;
    gap: 0.4375rem;
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    flex-shrink: 0;
  }

  @media (prefers-reduced-motion: no-preference) {
    .live-dot {
      animation: live-pulse 2.4s ease-in-out infinite;
    }
    @keyframes live-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }
  }

  .pane-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .device-toggle {
    display: flex;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .device-btn {
    display: flex;
    align-items: center;
    gap: 0.3125rem;
    padding: 0.3125rem 0.625rem;
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    background: transparent;
    transition: all var(--transition);
    white-space: nowrap;
  }

  .device-btn + .device-btn {
    border-left: 1px solid var(--border);
  }

  .device-btn:hover { color: var(--text); }

  .device-btn.active {
    color: var(--accent-text);
    background: var(--accent-subtle);
  }

  .pane-action {
    display: flex;
    align-items: center;
    gap: 0.3125rem;
    padding: 0.3125rem 0.625rem;
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    transition: all var(--transition);
    white-space: nowrap;
  }

  .pane-action:hover {
    color: var(--text);
    border-color: var(--border-hover);
  }

  .pane-close {
    color: var(--text);
    border-color: var(--border-hover);
  }

  /* ── Stage: the worktable the site frame sits on ── */
  .stage {
    flex: 1;
    min-height: 0;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding: 28px;
    overflow: hidden;
    background-color: #080807;
    background-image: radial-gradient(rgba(242, 235, 224, 0.05) 1px, transparent 1px);
    background-size: 22px 22px;
  }

  .overlay .stage {
    padding: 0;
    background-image: none;
  }

  .frame-box {
    height: 100%;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
    background: #000;
  }

  .frame {
    display: block;
    border: 0;
    transform-origin: top left;
    background: #000;
  }

  .frame-fill {
    width: 100%;
    height: 100%;
  }
</style>
