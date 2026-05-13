<script lang="ts">
  import type { EventFeed, SeriesSummary, ClaimedTicket } from "@woco/shared";
  import { onMount, onDestroy } from "svelte";

  interface Props {
    event: EventFeed;
    series: SeriesSummary;
    /** First/only edition (single-ticket compat) */
    edition: number | null;
    /** All editions for multi-purchase — overrides single edition when present */
    editions?: Array<{ edition: number; ticket?: ClaimedTicket }>;
    claimedVia?: "wallet" | "email" | null;
    claimerEmail?: string;
    ticket?: ClaimedTicket;
    onclose: () => void;
  }

  let { event, series, edition, editions, claimedVia, claimerEmail, ticket, onclose }: Props = $props();

  const BEE_GATEWAY = import.meta.env.VITE_GATEWAY_URL || "https://gateway.woco-net.com";

  // Normalise: if editions array provided, use it; otherwise wrap single edition
  const allEditions = $derived(
    editions && editions.length > 0
      ? editions
      : edition != null ? [{ edition, ticket }] : []
  );
  const isMulti = $derived(allEditions.length > 1);

  // Carousel state
  let carouselIdx = $state(0);
  const activeItem = $derived(allEditions[carouselIdx] ?? allEditions[0] ?? { edition, ticket });
  const activeEdition = $derived(activeItem?.edition ?? edition);
  const activeTicket = $derived(activeItem?.ticket ?? ticket);

  // Per-carousel-item QR SVGs
  let qrSvgs = $state<(string | null)[]>([]);
  let downloading = $state(false);
  let copied = $state(false);

  function qrContentFor(ed: number | null, tk?: ClaimedTicket): string {
    const base = `woco://t/${event.eventId}/${series.seriesId}/${ed ?? 0}`;
    return tk?.originalSignature ? base + `/${tk.originalSignature}` : base;
  }

  const qrContent = $derived(qrContentFor(activeEdition, activeTicket));
  // Legacy compat for single-ticket download
  const qrSvg = $derived(qrSvgs[carouselIdx] ?? null);

  const editionStr = $derived(
    activeEdition != null ? String(activeEdition).padStart(3, "0") : "—"
  );

  function formatEventDate(iso: string): string {
    const d = new Date(iso);
    const date = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return `${date} · ${time}`;
  }

  onMount(async () => {
    document.body.style.overflow = "hidden";
    try {
      const { renderSVG } = await import("uqr");
      const items = allEditions.length > 0 ? allEditions : [{ edition, ticket }];
      qrSvgs = items.map((item) => {
        try {
          return renderSVG(qrContentFor(item.edition, item.ticket), {
            ecc: "M",
            blackColor: "#f5f0ea",
            whiteColor: "transparent",
          });
        } catch { return null; }
      });
    } catch (e) {
      console.warn("[TicketSuccess] QR generation failed:", e);
    }
  });

  onDestroy(() => {
    document.body.style.overflow = "";
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") onclose();
  }

  function handleBackdropClick(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains("ts-overlay")) onclose();
  }

  function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((res, rej) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = src;
    });
  }

  function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
    const words = text.split(" ");
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const test = cur ? cur + " " + w : w;
      if (ctx.measureText(test).width > maxW && cur) {
        lines.push(cur);
        cur = w;
      } else { cur = test; }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  async function renderTicketCanvas(ed: number | null, tk: ClaimedTicket | undefined, svg: string | null): Promise<HTMLCanvasElement> {
    const SCALE = 2;
    const W = 820;
    const H = 390;
    const canvas = document.createElement("canvas");
    canvas.width = W * SCALE;
    canvas.height = H * SCALE;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(SCALE, SCALE);
    const edStr = ed != null ? String(ed).padStart(3, "0") : null;

    // ── Background ──
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, "#100c07");
    bg.addColorStop(1, "#0c0907");
    ctx.fillStyle = bg;
    roundRect(ctx, 0, 0, W, H, 16);
    ctx.fill();

    // ── Event image ──
    const IMG_W = 220;
    const MARGIN = 22;
    if (event.imageHash) {
      try {
        const img = await loadImage(`${BEE_GATEWAY}/bytes/${event.imageHash}`);
        ctx.save();
        roundRect(ctx, MARGIN, MARGIN, IMG_W, H - MARGIN * 2, 10);
        ctx.clip();
        const ar = img.naturalWidth / img.naturalHeight;
        const tAr = IMG_W / (H - MARGIN * 2);
        let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
        if (ar > tAr) { sw = sh * tAr; sx = (img.naturalWidth - sw) / 2; }
        else { sh = sw / tAr; sy = (img.naturalHeight - sh) / 2; }
        ctx.drawImage(img, sx, sy, sw, sh, MARGIN, MARGIN, IMG_W, H - MARGIN * 2);
        const fade = ctx.createLinearGradient(MARGIN, 0, MARGIN + IMG_W, 0);
        fade.addColorStop(0.55, "rgba(12,9,7,0)");
        fade.addColorStop(1, "rgba(12,9,7,0.96)");
        ctx.fillStyle = fade;
        ctx.fillRect(MARGIN, MARGIN, IMG_W, H - MARGIN * 2);
        ctx.restore();
      } catch { /* skip */ }
    } else {
      const grad = ctx.createLinearGradient(MARGIN, MARGIN, IMG_W + MARGIN, H - MARGIN);
      grad.addColorStop(0, "#2a1c0d");
      grad.addColorStop(1, "#1a1009");
      ctx.fillStyle = grad;
      roundRect(ctx, MARGIN, MARGIN, IMG_W, H - MARGIN * 2, 10);
      ctx.fill();
    }

    // ── Text area ──
    const TX = IMG_W + MARGIN + 30;
    const CONTENT_W = W - TX - 215;

    ctx.fillStyle = "rgba(245,200,100,0.55)";
    ctx.font = `700 9px 'Courier New', monospace`;
    ctx.fillText("TICKET", TX, 58);

    if (edStr) {
      ctx.fillStyle = "rgba(245,200,100,0.9)";
      ctx.font = `700 16px 'Courier New', monospace`;
      ctx.fillText(`#${edStr}`, TX + 56, 58);
    }

    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(TX, 68);
    ctx.lineTo(TX + CONTENT_W + 30, 68);
    ctx.stroke();

    ctx.fillStyle = "#f5f0ea";
    ctx.font = `800 24px system-ui, -apple-system, sans-serif`;
    const titleLines = wrapText(ctx, event.title, CONTENT_W);
    let ty = 98;
    for (const line of titleLines.slice(0, 2)) {
      ctx.fillText(line, TX, ty);
      ty += 31;
    }

    ctx.fillStyle = "rgba(245,240,234,0.42)";
    ctx.font = `400 11.5px system-ui, -apple-system, sans-serif`;
    ty += 6;
    ctx.fillText(formatEventDate(event.startDate), TX, ty);
    ty += 21;
    if (event.location) {
      ctx.fillText(`\u{1F4CD} ${event.location}`, TX, ty);
      ty += 21;
    }
    ty += 10;
    ctx.fillStyle = "rgba(245,240,234,0.2)";
    ctx.font = `600 8.5px 'Courier New', monospace`;
    ctx.fillText(series.name.toUpperCase().slice(0, 22), TX, ty);
    ty += 15;
    ctx.fillStyle = "rgba(245,240,234,0.1)";
    ctx.fillText(`OF ${series.totalSupply} TOTAL`, TX, ty);

    // ── Perforated divider ──
    const PERF_X = W - 208;
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(PERF_X, MARGIN);
    ctx.lineTo(PERF_X, H - MARGIN);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#0c0907";
    ctx.beginPath(); ctx.arc(PERF_X, MARGIN, 9, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(PERF_X, H - MARGIN, 9, 0, Math.PI * 2); ctx.fill();

    // ── QR code in stub ──
    if (svg) {
      const qrImg = await new Promise<HTMLImageElement | null>((resolve) => {
        const blob = new Blob([svg], { type: "image/svg+xml" });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;
      });
      if (qrImg) {
        const QR = 158;
        const QX = PERF_X + 17;
        const QY = (H - QR) / 2 - 6;
        ctx.fillStyle = "#1a1409";
        roundRect(ctx, QX - 4, QY - 4, QR + 8, QR + 8, 6);
        ctx.fill();
        ctx.drawImage(qrImg, QX, QY, QR, QR);
        if (edStr) {
          ctx.fillStyle = "rgba(245,200,100,0.55)";
          ctx.font = `600 10px 'Courier New', monospace`;
          ctx.textAlign = "center";
          ctx.fillText(`#${edStr} of ${series.totalSupply}`, QX + QR / 2, QY + QR + 18);
          ctx.textAlign = "left";
        }
      }
    }

    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.font = `400 8px system-ui`;
    ctx.textAlign = "right";
    ctx.fillText("woco.eth  ·  verifiable on Swarm", W - 18, H - 14);
    ctx.textAlign = "left";

    return canvas;
  }

  function triggerDownload(canvas: HTMLCanvasElement, filename: string) {
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, "image/png");
  }

  async function downloadTicket() {
    if (downloading) return;
    downloading = true;
    try {
      const canvas = await renderTicketCanvas(activeEdition, activeTicket, qrSvg);
      triggerDownload(canvas, `woco-ticket-${activeEdition ?? "x"}.png`);
    } catch (e) {
      console.error("[TicketSuccess] download failed:", e);
    } finally {
      downloading = false;
    }
  }

  async function downloadAllTickets() {
    if (downloading) return;
    downloading = true;
    try {
      for (let i = 0; i < allEditions.length; i++) {
        const item = allEditions[i];
        const canvas = await renderTicketCanvas(item.edition, item.ticket, qrSvgs[i] ?? null);
        triggerDownload(canvas, `woco-ticket-${item.edition}.png`);
        // Small delay between downloads so browser doesn't block them
        if (i < allEditions.length - 1) await new Promise((r) => setTimeout(r, 300));
      }
    } catch (e) {
      console.error("[TicketSuccess] download all failed:", e);
    } finally {
      downloading = false;
    }
  }

  async function copyId() {
    try {
      await navigator.clipboard.writeText(qrContent);
      copied = true;
      setTimeout(() => { copied = false; }, 2000);
    } catch { /* ignore */ }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_interactive_supports_focus -->
<div class="ts-overlay" onclick={handleBackdropClick} role="dialog" aria-modal="true" aria-label="Your ticket">
  <div class="ts-modal">
    <button class="ts-close" onclick={onclose} aria-label="Close">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>

    <!-- ── Success headline ── -->
    <div class="ts-head">
      <div class="ts-checkmark" aria-hidden="true">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>
      <div class="ts-head-text">
        <span class="ts-head-title">
          {#if isMulti}
            {allEditions.length} tickets secured
          {:else if claimedVia === "email"}
            You're registered
          {:else}
            Ticket secured
          {/if}
          {#if !isMulti && activeEdition != null}
            <span class="ts-head-edition">#{editionStr}</span>
          {/if}
        </span>
        <span class="ts-head-sub">
          {#if isMulti}Showing {carouselIdx + 1} of {allEditions.length} · each has its own QR
          {:else if claimedVia === "email"}QR code is ready · show at the door
          {:else if claimedVia === "wallet"}Saved to your WoCo passport
          {:else}Your ticket is ready{/if}
        </span>
      </div>
      {#if isMulti}
        <div class="ts-carousel-nav">
          <button class="ts-nav-btn" onclick={() => { carouselIdx = Math.max(0, carouselIdx - 1); }} disabled={carouselIdx === 0} aria-label="Previous ticket">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <span class="ts-nav-count">{carouselIdx + 1}/{allEditions.length}</span>
          <button class="ts-nav-btn" onclick={() => { carouselIdx = Math.min(allEditions.length - 1, carouselIdx + 1); }} disabled={carouselIdx === allEditions.length - 1} aria-label="Next ticket">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
      {/if}
    </div>

    <!-- ══════════════════════════════════
         THE TICKET CARD
    ══════════════════════════════════ -->
    <div class="ticket">

      <!-- Left: artwork + event info -->
      <div class="ticket-body">
        {#if event.imageHash}
          <div class="ticket-art">
            <img
              src="{BEE_GATEWAY}/bytes/{event.imageHash}"
              alt=""
              class="ticket-art-img"
              aria-hidden="true"
            />
            <div class="ticket-art-mask"></div>
          </div>
        {:else}
          <div class="ticket-art ticket-art--empty"></div>
        {/if}

        <div class="ticket-content">
          <div class="ticket-eyebrow">
            <span class="ticket-type-label">TICKET</span>
            {#if activeEdition != null}
              <span class="ticket-edition-badge">#{editionStr}</span>
            {/if}
          </div>

          <h2 class="ticket-event-title">{event.title}</h2>

          <dl class="ticket-details">
            <div class="ticket-detail-row">
              <svg class="detail-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
                <path d="M5 1v3M11 1v3M2 7h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
              <dd>{formatEventDate(event.startDate)}</dd>
            </div>
            {#if event.location}
              <div class="ticket-detail-row">
                <svg class="detail-icon" width="9" height="12" viewBox="0 0 14 16" fill="none" aria-hidden="true">
                  <path d="M7 1C4.239 1 2 3.239 2 6c0 3.75 5 9 5 9s5-5.25 5-9c0-2.761-2.239-5-5-5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
                  <circle cx="7" cy="6" r="1.5" stroke="currentColor" stroke-width="1.3"/>
                </svg>
                <dd>{event.location}</dd>
              </div>
            {/if}
          </dl>

          <div class="ticket-series-info">
            <span class="ticket-series-name">{series.name}</span>
            <span class="ticket-series-count">of {series.totalSupply}</span>
          </div>
        </div>
      </div>

      <!-- Perforated edge -->
      <div class="ticket-perf">
        <div class="perf-notch perf-notch--top"></div>
        <div class="perf-line"></div>
        <div class="perf-notch perf-notch--bottom"></div>
      </div>

      <!-- Right: QR stub -->
      <div class="ticket-stub">
        <div class="stub-qr-wrap">
          {#if qrSvg}
            <div class="stub-qr">{@html qrSvg}</div>
          {:else}
            <div class="stub-qr-loading">
              <div class="qr-spin-ring"></div>
            </div>
          {/if}
        </div>
        <div class="stub-footer">
          {#if activeEdition != null}
            <span class="stub-num">#{editionStr}</span>
          {/if}
          <span class="stub-hint">Scan · Verify</span>
        </div>
      </div>

    </div>
    <!-- /ticket -->

    <!-- ── Action row ── -->
    <div class="ts-actions">
      {#if isMulti}
        <button
          class="ts-btn ts-btn--primary"
          onclick={downloadAllTickets}
          disabled={downloading}
          title="Save all tickets as PNGs"
        >
          {#if downloading}
            <span class="ts-btn-spin"></span>
            Generating…
          {:else}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Download all ({allEditions.length})
          {/if}
        </button>
        <button
          class="ts-btn"
          onclick={downloadTicket}
          disabled={downloading || !qrSvg}
          title="Save this ticket as PNG"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          This one
        </button>
      {:else}
        <button
          class="ts-btn ts-btn--primary"
          onclick={downloadTicket}
          disabled={downloading || !qrSvg}
          title="Save ticket as PNG"
        >
          {#if downloading}
            <span class="ts-btn-spin"></span>
            Generating…
          {:else}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Download
          {/if}
        </button>
      {/if}

      <button class="ts-btn" onclick={copyId} title="Copy ticket ID for verification">
        {#if copied}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          Copied!
        {:else}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          Copy ID
        {/if}
      </button>

    </div>

    {#if claimerEmail}
      <div class="ts-email-confirm" role="status">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        <span>
          {isMulti ? `All ${allEditions.length} tickets` : "Ticket"} emailed to
          <strong>{claimerEmail}</strong>
        </span>
      </div>
    {/if}

  </div>
</div>

<style>
  /* ── Overlay ── */
  .ts-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    background: rgba(0, 0, 0, 0.72);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    animation: ts-fade 220ms ease;
  }

  @keyframes ts-fade {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  .ts-modal {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    width: 100%;
    max-width: 560px;
    animation: ts-rise 400ms cubic-bezier(0.34, 1.36, 0.64, 1);
  }

  @keyframes ts-rise {
    from { opacity: 0; transform: translateY(32px) scale(0.96); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }

  /* ── Close ── */
  .ts-close {
    position: absolute;
    top: -2.75rem;
    right: 0;
    width: 2rem;
    height: 2rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.07);
    border: 1px solid rgba(255, 255, 255, 0.07);
    color: rgba(255, 255, 255, 0.5);
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .ts-close:hover {
    background: rgba(255, 255, 255, 0.13);
    color: rgba(255, 255, 255, 0.9);
  }

  /* ── Success headline ── */
  .ts-head {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0 0.25rem;
  }

  /* ── Carousel nav ── */
  .ts-carousel-nav {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin-left: auto;
    flex-shrink: 0;
  }

  .ts-nav-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 50%;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.08);
    color: rgba(255,255,255,0.5);
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .ts-nav-btn:hover:not(:disabled) {
    background: rgba(255,255,255,0.12);
    color: rgba(255,255,255,0.9);
  }
  .ts-nav-btn:disabled { opacity: 0.25; cursor: not-allowed; }

  .ts-nav-count {
    font-size: 0.6875rem;
    font-weight: 600;
    font-family: ui-monospace, monospace;
    color: rgba(255,255,255,0.35);
    min-width: 2rem;
    text-align: center;
  }

  .ts-checkmark {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    background: color-mix(in srgb, var(--success, #4ade80) 16%, transparent);
    color: var(--success, #4ade80);
    border: 1px solid color-mix(in srgb, var(--success, #4ade80) 28%, transparent);
    flex-shrink: 0;
    animation: ts-pop 350ms 200ms both cubic-bezier(0.34, 1.6, 0.64, 1);
  }

  @keyframes ts-pop {
    from { transform: scale(0.5); opacity: 0; }
    to   { transform: scale(1); opacity: 1; }
  }

  .ts-head-text {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .ts-head-title {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.9375rem;
    font-weight: 700;
    color: var(--text, #fff);
  }

  .ts-head-edition {
    font-size: 0.6875rem;
    font-weight: 700;
    font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
    color: var(--accent-text, #f59e0b);
    background: color-mix(in srgb, var(--accent, #f59e0b) 13%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent, #f59e0b) 24%, transparent);
    padding: 0.1rem 0.4375rem;
    border-radius: 4px;
    letter-spacing: 0.01em;
  }

  .ts-head-sub {
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.35);
  }

  /* ════════════════════════════════════════
   * THE TICKET
   * ════════════════════════════════════ */
  .ticket {
    display: flex;
    border-radius: 12px;
    position: relative;
    overflow: visible;
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.06),
      0 24px 64px -12px rgba(0, 0, 0, 0.75),
      0 8px 24px -6px rgba(0, 0, 0, 0.5);
    animation: ts-rise 440ms 60ms both cubic-bezier(0.34, 1.26, 0.64, 1);
  }

  /* ── Ticket body (left): artwork + info ── */
  .ticket-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    border-radius: 12px 0 0 12px;
    overflow: hidden;
    background: linear-gradient(155deg, #1c1610 0%, #110d08 100%);
  }

  .ticket-art {
    position: relative;
    height: 110px;
    flex-shrink: 0;
  }

  .ticket-art-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center 30%;
    display: block;
  }

  .ticket-art-mask {
    position: absolute;
    inset: 0;
    background: linear-gradient(to bottom,
      rgba(28, 22, 16, 0.15) 0%,
      rgba(17, 13, 8, 0.96) 100%
    );
  }

  .ticket-art--empty {
    background: linear-gradient(135deg, #261a0e 0%, #180f08 100%);
  }

  .ticket-content {
    padding: 0.875rem 1.125rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    flex: 1;
  }

  .ticket-eyebrow {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .ticket-type-label {
    font-size: 0.5625rem;
    font-weight: 700;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.22);
    font-family: ui-monospace, 'SF Mono', monospace;
  }

  .ticket-edition-badge {
    font-size: 0.625rem;
    font-weight: 700;
    font-family: ui-monospace, 'SF Mono', monospace;
    color: var(--accent-text, #f59e0b);
    background: color-mix(in srgb, var(--accent, #f59e0b) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent, #f59e0b) 22%, transparent);
    padding: 0.0625rem 0.375rem;
    border-radius: 4px;
  }

  .ticket-event-title {
    margin: 0;
    font-size: 1.1875rem;
    font-weight: 800;
    color: #f5f0ea;
    letter-spacing: -0.025em;
    line-height: 1.2;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .ticket-details {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .ticket-detail-row {
    display: flex;
    align-items: flex-start;
    gap: 0.375rem;
  }

  .detail-icon {
    flex-shrink: 0;
    color: rgba(255, 255, 255, 0.2);
    margin-top: 0.125rem;
  }

  .ticket-detail-row dd {
    margin: 0;
    font-size: 0.6875rem;
    color: rgba(255, 255, 255, 0.38);
    line-height: 1.45;
  }

  .ticket-series-info {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin-top: auto;
    padding-top: 0.25rem;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
  }

  .ticket-series-name {
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: rgba(255, 255, 255, 0.22);
    font-family: ui-monospace, 'SF Mono', monospace;
  }

  .ticket-series-count {
    font-size: 0.5625rem;
    color: rgba(255, 255, 255, 0.12);
    font-family: ui-monospace, 'SF Mono', monospace;
  }

  /* ── Perforated divider ── */
  .ticket-perf {
    position: relative;
    width: 0;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .perf-line {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 1px;
    background: repeating-linear-gradient(
      to bottom,
      rgba(255, 255, 255, 0.1) 0px,
      rgba(255, 255, 255, 0.1) 5px,
      transparent 5px,
      transparent 10px
    );
  }

  .perf-notch {
    position: absolute;
    width: 17px;
    height: 17px;
    border-radius: 50%;
    left: -8.5px;
    z-index: 3;
    background: rgba(0, 0, 0, 0.72);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.05);
  }

  .perf-notch--top    { top: -8.5px; }
  .perf-notch--bottom { bottom: -8.5px; }

  /* ── QR stub (right) ── */
  .ticket-stub {
    width: 136px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 1.125rem 1rem 1rem;
    gap: 0.75rem;
    border-radius: 0 12px 12px 0;
    background: linear-gradient(155deg, #1a1409 0%, #0e0b06 100%);
  }

  .stub-qr-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
  }

  .stub-qr {
    width: 106px;
    height: 106px;
  }

  .stub-qr :global(svg) {
    width: 100% !important;
    height: 100% !important;
    display: block;
  }

  .stub-qr-loading {
    width: 106px;
    height: 106px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px dashed rgba(255, 255, 255, 0.08);
    border-radius: 4px;
  }

  .qr-spin-ring {
    width: 22px;
    height: 22px;
    border: 2px solid rgba(255, 255, 255, 0.08);
    border-top-color: rgba(255, 255, 255, 0.35);
    border-radius: 50%;
    animation: qr-spin 0.85s linear infinite;
  }

  @keyframes qr-spin { to { transform: rotate(360deg); } }

  .stub-footer {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.125rem;
  }

  .stub-num {
    font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
    font-size: 0.875rem;
    font-weight: 700;
    color: var(--accent-text, #f59e0b);
    letter-spacing: 0.02em;
  }

  .stub-hint {
    font-size: 0.5rem;
    font-weight: 600;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.15);
    font-family: ui-monospace, 'SF Mono', monospace;
  }

  /* ── Actions ── */
  .ts-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .ts-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.875rem;
    font-size: 0.8125rem;
    font-weight: 600;
    border-radius: var(--radius-sm, 6px);
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.6);
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }

  .ts-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.9);
    border-color: rgba(255, 255, 255, 0.12);
  }

  .ts-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .ts-btn--primary {
    background: var(--accent, #f59e0b);
    border-color: transparent;
    color: #000;
    font-weight: 700;
  }

  .ts-btn--primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent, #f59e0b) 87%, #000);
    color: #000;
  }

  .ts-btn-spin {
    width: 12px;
    height: 12px;
    border: 2px solid rgba(0, 0, 0, 0.3);
    border-top-color: #000;
    border-radius: 50%;
    animation: qr-spin 0.6s linear infinite;
  }

  /* ── Email sent confirmation ── */
  .ts-email-confirm {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.625rem 0.75rem;
    background: rgba(100, 220, 130, 0.06);
    border: 1px solid rgba(100, 220, 130, 0.18);
    border-radius: var(--radius-sm, 6px);
    color: rgba(180, 230, 195, 0.85);
    font-size: 0.8125rem;
    line-height: 1.4;
  }

  .ts-email-confirm svg {
    flex-shrink: 0;
    color: rgba(100, 220, 130, 0.9);
  }

  .ts-email-confirm strong {
    color: rgba(230, 250, 235, 0.95);
    font-weight: 600;
    word-break: break-all;
  }

  /* ── Responsive ── */
  @media (max-width: 520px) {
    .ticket-stub { width: 108px; }
    .stub-qr { width: 84px; height: 84px; }
    .ticket-art { height: 80px; }
    .ticket-event-title { font-size: 1rem; }
    .ts-actions { gap: 0.375rem; }
    .ts-btn { padding: 0.4375rem 0.625rem; font-size: 0.75rem; }
  }
</style>
