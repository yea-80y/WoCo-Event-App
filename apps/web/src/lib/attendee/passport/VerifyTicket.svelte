<script lang="ts">
  /**
   * Standalone ticket view page. Loaded from email links like
   *   /#/verify?t=<url-encoded qrContent>
   * where qrContent is `woco://t/{eventId}/{seriesId}/{edition}/{signature}`.
   *
   * No auth required — possession of the URL is possession of the ticket.
   * This lets buyers forward a URL to each friend in a multi-ticket purchase.
   *
   * Renders the event metadata (fetched live), a large QR encoding the full
   * POD ticket URI, and the ticket ID. The QR payload is identical to the
   * in-app passport QR and the email's inline QR, so any WoCo scanner reads
   * the same ed25519-signed POD ticket.
   */
  import type { EventFeed, SeriesSummary } from "@woco/shared";
  import { getEvent } from "../../api/events.js";
  import { onMount } from "svelte";

  interface ParsedTicket {
    eventId: string;
    seriesId: string;
    edition: number | null;
    signature: string | null;
    raw: string;
  }

  let rawParam = $state<string | null>(null);
  let parsed = $state<ParsedTicket | null>(null);
  let event = $state<EventFeed | null>(null);
  let series = $state<SeriesSummary | null>(null);
  let qrSvg = $state<string | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);

  function parseQrUri(raw: string): ParsedTicket | null {
    // Accept woco://t/{eventId}/{seriesId}/{edition}/{sig?}
    const m = raw.match(/^woco:\/\/t\/([^/]+)\/([^/]+)\/(\d+)(?:\/(.+))?$/);
    if (!m) return null;
    const [, eventId, seriesId, editionStr, signature] = m;
    const edition = Number(editionStr);
    return {
      eventId,
      seriesId,
      edition: Number.isFinite(edition) ? edition : null,
      signature: signature || null,
      raw,
    };
  }

  function readParam(): string | null {
    // Hash-based router means query lives in the hash, e.g.
    //   #/verify?t=woco%3A%2F%2Ft%2F...
    const hash = window.location.hash;
    const qIdx = hash.indexOf("?");
    if (qIdx === -1) return null;
    const params = new URLSearchParams(hash.slice(qIdx + 1));
    return params.get("t");
  }

  const editionStr = $derived(
    parsed?.edition != null ? String(parsed.edition).padStart(3, "0") : null,
  );

  const eventDateStr = $derived.by(() => {
    if (!event?.startDate) return null;
    const d = new Date(event.startDate);
    const date = d.toLocaleDateString(undefined, {
      weekday: "short", month: "short", day: "numeric", year: "numeric",
    });
    const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return `${date} · ${time}`;
  });

  onMount(async () => {
    try {
      rawParam = readParam();
      if (!rawParam) {
        error = "Missing ticket parameter";
        return;
      }
      parsed = parseQrUri(rawParam);
      if (!parsed) {
        error = "Invalid ticket link";
        return;
      }

      // Render QR first so the page is useful even if the event fetch fails.
      try {
        const { renderSVG } = await import("uqr");
        qrSvg = renderSVG(parsed.raw, {
          ecc: "M",
          blackColor: "#0d0a07",
          whiteColor: "#ffffff",
        });
      } catch (e) {
        console.warn("[VerifyTicket] QR render failed:", e);
      }

      // Event fetch is best-effort — QR works without it. Show generic labels
      // if the event feed is unreachable (slow Swarm, offline, etc).
      try {
        const ev = await getEvent(parsed.eventId);
        if (ev) {
          event = ev;
          series = ev.series.find((s) => s.seriesId === parsed!.seriesId) ?? null;
        }
      } catch (e) {
        console.warn("[VerifyTicket] Event fetch failed (non-fatal):", e);
      }
    } finally {
      loading = false;
    }
  });
</script>

<div class="vt-root">
  {#if error}
    <div class="vt-error">
      <h2>Ticket link invalid</h2>
      <p>{error}</p>
    </div>
  {:else if loading}
    <div class="vt-loading">Loading ticket…</div>
  {:else if parsed}
    <article class="vt-card">
      <header class="vt-header">
        <div class="vt-badge">
          {#if editionStr}Ticket #{editionStr}{:else}WoCo Ticket{/if}
        </div>
        <h1 class="vt-title">{event?.title ?? "Event ticket"}</h1>
        <div class="vt-meta">
          {#if eventDateStr}
            <div class="vt-meta-row">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <rect x="3" y="4" width="18" height="18" rx="2"/>
                <line x1="16" y1="2" x2="16" y2="6"/>
                <line x1="8" y1="2" x2="8" y2="6"/>
                <line x1="3" y1="10" x2="21" y2="10"/>
              </svg>
              <span>{eventDateStr}</span>
            </div>
          {/if}
          {#if event?.location}
            <div class="vt-meta-row">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                <circle cx="12" cy="10" r="3"/>
              </svg>
              <span>{event.location}</span>
            </div>
          {/if}
          {#if series?.name}
            <div class="vt-meta-row vt-meta-row--muted">
              <span>{series.name}</span>
            </div>
          {/if}
        </div>
      </header>

      <div class="vt-qr-wrap">
        {#if qrSvg}
          <div class="vt-qr">{@html qrSvg}</div>
        {:else}
          <div class="vt-qr vt-qr--fallback">QR unavailable — show the ticket ID below</div>
        {/if}
        <p class="vt-qr-caption">Present this QR code at the door</p>
      </div>

      <footer class="vt-footer">
        <div class="vt-footer-label">Ticket ID</div>
        <div class="vt-footer-id">{parsed.raw}</div>
        <p class="vt-footer-note">
          This ticket is cryptographically signed by the organiser and can be
          verified offline. Anyone holding this link can use the ticket.
        </p>
      </footer>
    </article>
  {/if}
</div>

<style>
  .vt-root {
    min-height: 100vh;
    padding: 1rem;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    background: #0d0a07;
  }

  .vt-loading, .vt-error {
    padding: 2rem;
    color: rgba(245, 240, 234, 0.5);
    text-align: center;
  }

  .vt-error h2 {
    color: rgba(245, 240, 234, 0.9);
    margin-bottom: 0.5rem;
  }

  .vt-card {
    width: 100%;
    max-width: 420px;
    background: #191410;
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 16px;
    overflow: hidden;
    margin-top: 1rem;
  }

  .vt-header {
    padding: 1.75rem 1.5rem 1.25rem;
    background: linear-gradient(135deg, #231a0f 0%, #140e08 100%);
  }

  .vt-badge {
    display: inline-block;
    background: rgba(245, 158, 11, 0.15);
    border: 1px solid rgba(245, 158, 11, 0.3);
    color: #f59e0b;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 3px 10px;
    border-radius: 4px;
    margin-bottom: 14px;
  }

  .vt-title {
    font-size: 1.375rem;
    font-weight: 800;
    color: #f5f0ea;
    line-height: 1.2;
    letter-spacing: -0.02em;
    margin: 0 0 0.75rem;
  }

  .vt-meta {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .vt-meta-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    color: rgba(245, 240, 234, 0.55);
  }

  .vt-meta-row--muted {
    color: rgba(245, 240, 234, 0.35);
    margin-top: 0.25rem;
  }

  .vt-meta-row svg {
    flex-shrink: 0;
    color: rgba(245, 240, 234, 0.4);
  }

  .vt-qr-wrap {
    padding: 1.75rem 1.5rem 1rem;
    text-align: center;
  }

  .vt-qr {
    width: 280px;
    height: 280px;
    max-width: 100%;
    margin: 0 auto;
    padding: 16px;
    background: #fff;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .vt-qr :global(svg) {
    width: 100%;
    height: 100%;
  }

  .vt-qr--fallback {
    color: rgba(13, 10, 7, 0.55);
    font-size: 0.75rem;
    padding: 2rem;
  }

  .vt-qr-caption {
    margin: 1rem 0 0;
    font-size: 0.8125rem;
    color: rgba(245, 240, 234, 0.4);
  }

  .vt-footer {
    padding: 1.25rem 1.5rem 1.5rem;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
  }

  .vt-footer-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.22);
    margin-bottom: 0.5rem;
  }

  .vt-footer-id {
    font-family: 'SF Mono', 'Cascadia Code', 'Menlo', monospace;
    font-size: 0.6875rem;
    color: rgba(255, 255, 255, 0.3);
    word-break: break-all;
    line-height: 1.4;
  }

  .vt-footer-note {
    margin: 1rem 0 0;
    font-size: 0.75rem;
    color: rgba(245, 240, 234, 0.35);
    line-height: 1.5;
  }

  @media (max-width: 480px) {
    .vt-qr { width: 240px; height: 240px; }
  }
</style>
