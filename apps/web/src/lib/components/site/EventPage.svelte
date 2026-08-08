<script lang="ts">
  import type { EventFeed, SeriesSummary, SeriesClaimStatus } from "@woco/shared";
  import { getEvent, getClaimStatus } from "../../api/events.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { cacheGet, cacheSet, cacheKey, TTL } from "../../cache/cache.js";
  import { isPastEvent } from "../../utils/events.js";
  import { onMount, onDestroy } from "svelte";
  import { buildEventJsonLd, eventMetaDescription } from "@woco/shared";
  import { setJsonLd, setMetaDescription, setTitle } from "../../seo/head.js";
  import ClaimButton from "../../attendee/events/ClaimButton.svelte";
  import { firstImageUrl, useNextImageUrl } from "./image-fallback.js";

  interface Props {
    eventId: string;
    ondashboard?: () => void;
    onback?: () => void;
    /** Override API base URL — used when this event is hosted on an organiser's own server */
    apiUrl?: string;
  }

  let { eventId, ondashboard, onback, apiUrl }: Props = $props();

  // contentGatewayUrl is injected by the deploy step for standalone sites that
  // are hosted on a different gateway (e.g. Etherna) — event images were uploaded
  // to the WoCo Bee and must be fetched from there regardless of site host.
  const BEE_GATEWAY =
    (typeof window !== "undefined" && (window.SITE_CONFIG?.contentGatewayUrl || window.SITE_CONFIG?.gatewayUrl)) ||
    import.meta.env.VITE_GATEWAY_URL ||
    "https://gateway.woco-net.com";

  // ── Event loading ─────────────────────────────────────────────────────────
  // Synchronous mount-time cache read (eventId is per-mount stable)
  // svelte-ignore state_referenced_locally
  const _KEY = cacheKey.event(eventId);
  const _cached = cacheGet<EventFeed>(_KEY);

  let event = $state<EventFeed | null>(_cached ?? null);
  let loading = $state(_cached === null);
  let error = $state<string | null>(null);

  // ── Ticket selection ──────────────────────────────────────────────────────
  let selectedSeries = $state<SeriesSummary | null>(null);

  // ── Claim status (per-series availability) ────────────────────────────────
  // Keyed by seriesId — fetched lazily when series is selected or on mount.
  // Anonymous data (supply counts only) — the server returns no per-user state.
  let seriesStatus = $state<Record<string, SeriesClaimStatus>>({});

  function getSeriesStatus(s: SeriesSummary): SeriesClaimStatus | null {
    return seriesStatus[s.seriesId] ?? null;
  }

  function fetchSeriesStatus(s: SeriesSummary) {
    const sk = cacheKey.claimStatus(eventId, s.seriesId, "anon");
    const cached = cacheGet<SeriesClaimStatus>(sk);
    if (cached) seriesStatus = { ...seriesStatus, [s.seriesId]: cached };

    getClaimStatus(eventId, s.seriesId, undefined, undefined, apiUrl)
      .then((fresh) => {
        if (!fresh) return;
        cacheSet(sk, fresh, TTL.CLAIM_STATUS);
        seriesStatus = { ...seriesStatus, [s.seriesId]: fresh };
      })
      .catch(() => {});
  }

  // ── Purchase panel state ──────────────────────────────────────────────────
  let ticketQty = $state<Record<string, number>>({});
  let claimOpen = $state(false);
  /** seriesId to auto-select after Stripe return — resolved once event loads */
  let stripeReturnSeriesId = $state<string | null>(null);

  /** Stripe-success card. When set, REPLACES the tickets + claim panel —
   *  the buyer is done, the reservation will be consumed by the webhook,
   *  and the ticket is in their inbox. Showing the reservation panel here
   *  is confusing (their own held slot reads as "1 reserved" until webhook
   *  catches up). */
  let stripeBanner = $state<{ email: string | null; qty: number } | null>(null);

  // Sourced from the deployed-site runtime config injected by the deploy step.
  const siteName = (typeof window !== "undefined" && window.SITE_CONFIG?.site?.theme?.brandName) || null;

  // ── SEO (#55) ────────────────────────────────────────────────────────────────
  // Organiser sites are the strongest SEO surface we have — a real venue domain
  // rather than a shared gateway root — so Event rich results matter most here.
  // The event body is fetched at runtime, hence runtime injection; the site's own
  // title/description/canonical are injected at deploy time (routes/sites.ts).
  $effect(() => {
    if (!event) return;
    const ev = event;

    setTitle(ev.title, siteName ?? undefined);
    setMetaDescription(eventMetaDescription(ev));
    setJsonLd(
      "event",
      buildEventJsonLd(ev, {
        url: window.location.href,
        imageUrl: ev.imageHash ? firstImageUrl(ev.imageHash, BEE_GATEWAY) : undefined,
        organiserName: siteName ?? undefined,
      }),
    );
  });

  onDestroy(() => {
    setJsonLd("event", null);
    setMetaDescription(null);
  });

  function dismissPurchaseSuccess() {
    stripeBanner = null;
    claimOpen = false;
    selectedSeries = null;
    ticketQty = {};
    try { sessionStorage.removeItem(`woco:stripe-returning:${eventId}`); } catch { /* ignore */ }
    try {
      const newHash = window.location.hash
        .replace(/[?&]stripe=success/, "")
        .replace(/[?&]session_id=[^&]*/, "");
      const newSearch = window.location.search
        .replace(/[?&]stripe=success/, "")
        .replace(/[?&]session_id=[^&]*/, "")
        .replace(/^\?$/, "");
      window.history.replaceState(null, "", window.location.pathname + newSearch + newHash);
    } catch { /* ignore */ }
  }

  function goToSite() {
    dismissPurchaseSuccess();
    window.location.hash = "#/";
  }


  // ── Derived ───────────────────────────────────────────────────────────────
  const anySelected = $derived(Object.values(ticketQty).some((v) => v > 0));

  // ── Sale window helpers ───────────────────────────────────────────────────
  function saleStatus(s: SeriesSummary): "active" | "future" | "past" {
    const now = Date.now();
    if (s.saleStart && new Date(s.saleStart).getTime() > now) return "future";
    if (s.saleEnd && new Date(s.saleEnd).getTime() < now) return "past";
    return "active";
  }

  function formatShortDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function currencySymbol(c: string): string {
    if (c === "GBP") return "£";
    if (c === "USD") return "$";
    if (c === "EUR") return "€";
    return c + " ";
  }

  function priceRange(series: SeriesSummary[]): string {
    const prices = series
      .filter((s) => s.payment && parseFloat(s.payment.price) > 0)
      .map((s) => parseFloat(s.payment!.price));
    if (!prices.length) return "Free";
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const sym = currencySymbol(series.find((s) => s.payment)?.payment?.currency ?? "");
    return min === max ? `${sym}${min.toFixed(2)}` : `${sym}${min.toFixed(2)} – ${sym}${max.toFixed(2)}`;
  }

  function mapsUrl(location: string): string {
    return `https://maps.google.com/?q=${encodeURIComponent(location)}`;
  }

  // True once the event itself has ended — locks down qty selection + Get Tickets.
  const eventIsPast = $derived(event ? isPastEvent(event) : false);

  // ── Ticket quantity + Get Tickets ─────────────────────────────────────────
  function handleQtyChange(s: SeriesSummary, qty: number) {
    const next: Record<string, number> = {};
    for (const k of Object.keys(ticketQty)) next[k] = 0;
    next[s.seriesId] = qty;
    ticketQty = next;
    claimOpen = false;

    if (qty > 0) {
      selectSeries(s);
    } else {
      selectedSeries = null;
    }
  }

  function handleGetTickets() {
    claimOpen = true;
    setTimeout(() => {
      document.getElementById("claim-section")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 50);
  }

  // ── Ticket selection ──────────────────────────────────────────────────────
  function selectSeries(s: SeriesSummary) {
    if (saleStatus(s) !== "active") return;
    const ss = getSeriesStatus(s);
    if (ss != null && ss.available === 0) return;
    selectedSeries = s;
  }

  onMount(() => {
    const hash = window.location.hash;
    // Check both hash (woco.eth.limo hash-router) and search (standalone ENS sites).
    const stripeParams = hash + window.location.search;
    if (stripeParams.includes("stripe=success")) {
      const returningId = sessionStorage.getItem(`woco:stripe-returning:${eventId}`);
      if (returningId) {
        stripeReturnSeriesId = returningId;
        if (event) {
          const match = event.series.find(s => s.seriesId === returningId);
          if (match) { selectedSeries = match; stripeReturnSeriesId = null; claimOpen = true; }
        }
        // Read the form stash so we can show the persistent banner above
        // the tickets card. ClaimButton mounts AFTER our onMount and strips
        // the hash itself — no need to strip here.
        try {
          const formRaw = sessionStorage.getItem(`woco:stripe-form:${eventId}:${returningId}`);
          let email: string | null = null;
          let qty = 1;
          if (formRaw) {
            const parsed = JSON.parse(formRaw) as { claimerEmail?: string; quantity?: number };
            email = parsed.claimerEmail ?? null;
            if (parsed.quantity && Number.isInteger(parsed.quantity)) qty = parsed.quantity;
          }
          stripeBanner = { email, qty };
        } catch { stripeBanner = { email: null, qty: 1 }; }
      }
    }

    if (stripeParams.includes("stripe=cancelled")) {
      const returningId = sessionStorage.getItem(`woco:stripe-returning:${eventId}`);
      if (returningId) {
        // Restore the quantity the buyer had selected so ClaimButton's
        // reservation $effect sees a match instead of defaulting to 1 and
        // atomically replacing the server-side hold with a qty-1 reservation.
        try {
          const formRaw = sessionStorage.getItem(`woco:stripe-form:${eventId}:${returningId}`);
          if (formRaw) {
            const parsed = JSON.parse(formRaw) as { quantity?: number };
            if (parsed.quantity && parsed.quantity > 1) {
              ticketQty = { [returningId]: parsed.quantity };
            }
          }
        } catch { /* ignore */ }
        // Auto-select the series and reopen the claim panel.
        stripeReturnSeriesId = returningId;
        if (event) {
          const match = event.series.find(s => s.seriesId === returningId);
          if (match) { selectedSeries = match; stripeReturnSeriesId = null; claimOpen = true; }
        }
        // Strip the marker so refresh doesn't re-trigger (handles both
        // hash-routed woco app and standalone ENS sites with search params).
        try {
          const newHash = window.location.hash.replace(/[?&]stripe=cancelled/, "");
          const newSearch = window.location.search.replace(/[?&]stripe=cancelled/, "").replace(/^\?$/, "");
          window.history.replaceState(null, "", window.location.pathname + newSearch + newHash);
        } catch { /* ignore */ }

        // Stripe Checkout's cancel-back redirects via location.href, which
        // leaves a dead Stripe entry in the history stack behind us. Without
        // intervention, the buyer's first browser-back lands them back on
        // Stripe (cross-origin, expired). Push a sentinel state so the next
        // back press fires popstate (still same-origin), then redirect to
        // the site home (#/) — replacing the current entry so forward nav
        // doesn't loop them back here.
        try {
          const cleanUrl = window.location.pathname + window.location.search + window.location.hash;
          history.pushState({ wocoCancelGuard: true }, "", cleanUrl);
          const onPop = (ev: PopStateEvent) => {
            // Ignore pops that land back ON the guard (user went forward
            // somewhere then came back). Only intercept pops that land
            // BEHIND the guard — i.e. the buyer's first back from this page.
            if ((ev.state as { wocoCancelGuard?: boolean } | null)?.wocoCancelGuard) return;
            window.removeEventListener("popstate", onPop);
            window.location.replace("#/");
          };
          window.addEventListener("popstate", onPop);
        } catch { /* ignore */ }
      }
    }

    // Phase B carrier baked into SITE_CONFIG at deploy time: lets the server read
    // this event's client-signed SOC directly. Required for unlisted (skipAutoList)
    // events — they aren't in the global directory, so a no-signer read can't
    // resolve the carrier and 404s. Also skips the slow directory scan when listed.
    const eventSigner = (typeof window !== "undefined" && window.SITE_CONFIG?.eventSigner) || undefined;
    getEvent(eventId, apiUrl, eventSigner)
      .then((fresh) => {
        if (!fresh) {
          if (_cached === null) error = "Event not found";
          loading = false;
          return;
        }
        cacheSet(_KEY, fresh, TTL.EVENT);
        event = fresh;
        loading = false;
        error = null;
        if (stripeReturnSeriesId) {
          const match = fresh.series.find(s => s.seriesId === stripeReturnSeriesId);
          if (match) { selectedSeries = match; stripeReturnSeriesId = null; claimOpen = true; }
        }
        for (const s of fresh.series) {
          fetchSeriesStatus(s);
        }
      })
      .catch((e) => {
        if (_cached === null) {
          error = e instanceof Error ? e.message : "Failed to load event";
          loading = false;
        }
      });

    if (_cached) {
      for (const s of _cached.series) {
        fetchSeriesStatus(s);
      }
    }
  });
</script>

<div class="event-page">
  {#if onback}
    <button class="back-link" onclick={onback}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Back
    </button>
  {/if}

  {#if loading}
    <div class="state-wrap">
      <div class="loader"></div>
      <p class="state-text">Loading event…</p>
    </div>
  {:else if error}
    <div class="state-wrap">
      <p class="state-error">{error}</p>
    </div>
  {:else if event}

    <!-- Hero image — full bleed, no border radius -->
    {#if event.imageHash}
      <div class="hero-wrap">
        <img
          src={firstImageUrl(event.imageHash, BEE_GATEWAY)}
          alt={event.title}
          class="hero-img"
          data-image-gateway-index="0"
          onerror={(e) => useNextImageUrl(e, event?.imageHash, BEE_GATEWAY)}
        />
        <div class="hero-fade"></div>
      </div>
    {/if}

    <!-- Organizer creator bar -->
    {#if auth.parent?.toLowerCase() === event.creatorAddress.toLowerCase()}
      <div class="creator-bar">
        <span class="creator-bar-label">You are the organizer</span>
        <button class="creator-bar-btn" onclick={ondashboard}>Dashboard →</button>
      </div>
    {/if}

    <!-- Event title + meta -->
    <div class="event-header">
      <h1 class="event-title">{event.title}</h1>
      {#if event.tagline}
        <p class="event-tagline">{event.tagline}</p>
      {/if}

      <div class="meta-stack">
        <!-- Date/time -->
        <div class="meta-item">
          <span class="meta-icon">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
              <path d="M5 1v3M11 1v3M2 7h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
            </svg>
          </span>
          <span class="meta-text">
            {formatDate(event.startDate)} · {formatTime(event.startDate)}
            {#if event.endDate && event.endDate !== event.startDate}
              <span class="meta-dim"> – {formatTime(event.endDate)}</span>
            {/if}
          </span>
        </div>

        <!-- Location -->
        {#if event.location}
          <div class="meta-item">
            <span class="meta-icon">
              <svg width="13" height="15" viewBox="0 0 14 16" fill="none" aria-hidden="true">
                <path d="M7 1C4.239 1 2 3.239 2 6c0 3.75 5 9 5 9s5-5.25 5-9c0-2.761-2.239-5-5-5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
                <circle cx="7" cy="6" r="1.5" stroke="currentColor" stroke-width="1.2"/>
              </svg>
            </span>
            <span class="meta-text">{event.location}</span>
          </div>
        {/if}

        <!-- Price range -->
        {#if event.series.length}
          <div class="meta-item">
            <span class="meta-icon">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.4"/>
                <path d="M8 4.5v1M8 10.5v1M6 7.5c0-.828.672-1.5 2-1.5s2 .672 2 1.5S9.328 9 8 9s-2 .672-2 1.5S7 12 8 12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
              </svg>
            </span>
            <span class="meta-text">{priceRange(event.series)}</span>
          </div>
        {/if}
      </div>

      <!-- Organizer chip — hidden until we display nickname / ENS / sub-ENS instead of raw address. -->
    </div>

    {#if stripeBanner}
      <!-- rendered outside page flow via position:fixed — see CSS -->
    {:else}

    <!-- ── Tickets card ──────────────────────────────────────────────────── -->
    <div class="tickets-card">
      <h2 class="tickets-heading">Tickets</h2>

      <div class="ticket-rows">
        {#each event.series as s, i}
          {@const sale = saleStatus(s)}
          {@const ss = getSeriesStatus(s)}
          {@const physRemaining = ss?.available ?? s.totalSupply}
          {@const soldOut = ss != null && ss.available === 0}
          {@const isUnavailable = eventIsPast || sale !== "active" || soldOut}
          {@const isPaid = s.payment && parseFloat(s.payment.price) > 0}
          {@const qty = ticketQty[s.seriesId] ?? 0}
          {@const maxQty = isUnavailable ? 0 : Math.min(physRemaining, 10)}

          {#if i > 0}
            <div class="ticket-divider"></div>
          {/if}

          <div class="ticket-row" class:ticket-row--dim={isUnavailable}>
            <!-- Left: name -->
            <div class="ticket-row-left">
              <span class="ticket-name">{s.name}</span>
              {#if s.wave}
                <span class="wave-badge">{s.wave}</span>
              {/if}
              {#if s.description}
                <span class="ticket-subdesc">{s.description}</span>
              {/if}
            </div>

            <!-- Middle: status + price -->
            <div class="ticket-row-mid">
              {#if eventIsPast}
                <span class="ticket-status">Event ended</span>
              {:else if sale === "future"}
                <span class="ticket-status">Opens {formatShortDate(s.saleStart!)}</span>
              {:else if sale === "past"}
                <span class="ticket-status">Sales closed</span>
              {:else if soldOut}
                <span class="ticket-status">Sold Out</span>
              {/if}

              {#if isPaid}
                <span class="ticket-price" class:ticket-price--dim={isUnavailable}>
                  {currencySymbol(s.payment!.currency)}{parseFloat(s.payment!.price).toFixed(2)}
                </span>
              {:else}
                <span class="ticket-price ticket-price--free" class:ticket-price--dim={isUnavailable}>
                  Free
                </span>
              {/if}

            </div>

            <!-- Right: qty selector -->
            <div class="ticket-row-right">
              <div class="qty-box" class:qty-box--dim={isUnavailable}>
                <select
                  disabled={isUnavailable}
                  value={qty}
                  onchange={(e) => handleQtyChange(s, parseInt((e.target as HTMLSelectElement).value))}
                >
                  <option value={0}>0</option>
                  {#if !isUnavailable}
                    {#each Array.from({ length: maxQty }, (_, i) => i + 1) as n}
                      <option value={n}>{n}</option>
                    {/each}
                  {/if}
                </select>
              </div>
            </div>
          </div>
        {/each}
      </div>

      <!-- Get Tickets footer -->
      <div class="tickets-footer">
        <button
          class="get-tickets-btn"
          class:get-tickets-btn--active={anySelected && !eventIsPast}
          disabled={!anySelected || eventIsPast}
          onclick={handleGetTickets}
        >
          {eventIsPast ? "Event ended" : "Get Tickets"}
        </button>
        {#if eventIsPast}
          <p class="nothing-selected">Ticket sales are closed for past events</p>
        {:else if !anySelected}
          <p class="nothing-selected">Nothing selected yet</p>
        {/if}
      </div>
    </div>

    <!-- ── Claim / checkout panel ────────────────────────────────────────── -->
    {#if selectedSeries && claimOpen}
      <div class="claim-panel" id="claim-section">
        <div class="claim-panel-header">
          <h3 class="claim-panel-title">
            {selectedSeries.name}
            {#if selectedSeries.wave}
              <span class="wave-badge">{selectedSeries.wave}</span>
            {/if}
          </h3>
          <button class="claim-panel-close" aria-label="Close checkout panel" onclick={() => { claimOpen = false; }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
        </div>

        {#if selectedSeries.payment && parseFloat(selectedSeries.payment.price) > 0}
          <ClaimButton
            eventId={eventId}
            seriesId={selectedSeries.seriesId}
            encryptionKey={event.encryptionKey}
            orderFields={event.orderFields}
            apiUrl={apiUrl}
            payment={selectedSeries.payment}
            quantity={ticketQty[selectedSeries.seriesId] ?? 1}
            eager
          />

        {:else}
          <!-- No purchase rail: free series need a v2 mint path (the v1 claim
               rail was deleted; freeEventsAllowed is off). -->
          <p class="claim-unavailable">Tickets for this event are not currently on sale.</p>
        {/if}
      </div>
    {/if}
    {/if}

    <!-- ── About section ─────────────────────────────────────────────────── -->
    {#if event.description}
      <div class="about-section">
        <h2 class="section-heading">About</h2>
        <p class="about-text">{event.description}</p>
      </div>
    {/if}

    <!-- ── Venue section ──────────────────────────────────────────────────── -->
    {#if event.location}
      <div class="venue-section">
        <h2 class="section-heading">Venue</h2>
        <div class="venue-card">
          <div class="venue-info">
            <p class="venue-name">{event.location}</p>
          </div>
          <a
            class="maps-btn"
            href={mapsUrl(event.location)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open in Maps
          </a>
        </div>
      </div>
    {/if}

  {/if}
</div>



{#if stripeBanner}
  <div class="purchase-success-overlay" role="status" aria-live="polite">
    <div class="purchase-success-inner">
      <div class="purchase-success-check" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>
      <h2 class="purchase-success-title">Payment confirmed</h2>
      <p class="purchase-success-lede">
        {stripeBanner.qty > 1 ? `Your ${stripeBanner.qty} tickets are` : "Your ticket is"} on the way{#if stripeBanner.email} to <strong>{stripeBanner.email}</strong>{/if}.
      </p>
      <ul class="purchase-success-steps">
        <li><span class="purchase-success-bullet"></span>Check your inbox in the next few minutes.</li>
        <li><span class="purchase-success-bullet"></span>If you don't see it, check your spam folder.</li>
        <li><span class="purchase-success-bullet"></span>Show the QR code in the email at the door.</li>
      </ul>
      <div class="purchase-success-actions">
        <button type="button" class="purchase-success-btn purchase-success-btn--primary" onclick={dismissPurchaseSuccess}>
          Back to event
        </button>
        {#if siteName}
          <button type="button" class="purchase-success-btn purchase-success-btn--ghost" onclick={goToSite}>
            Back to {siteName}
          </button>
        {/if}
      </div>
      <p class="purchase-success-foot">A receipt has been sent by Stripe.</p>
    </div>
  </div>
{/if}

<style>
  /* ── Page shell ───────────────────────────────────────────────────────────── */
  .event-page {
    max-width: 640px;
    margin: 0 auto;
    padding-bottom: 4rem;
    overflow-x: hidden;
  }

  .back-link {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 0.875rem;
    cursor: pointer;
    padding: 0.75rem 0;
    margin-bottom: 0;
    transition: color var(--transition);
  }
  .back-link:hover { color: var(--text); }

  /* ── State ────────────────────────────────────────────────────────────────── */
  .state-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 5rem 0;
    gap: 1rem;
  }
  .loader {
    width: 1.25rem;
    height: 1.25rem;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.75s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .state-text { color: var(--text-muted); font-size: 0.9375rem; }
  .state-error { color: var(--error); font-size: 0.9375rem; text-align: center; }

  /* ── Hero image — full bleed ──────────────────────────────────────────────── */
  .hero-wrap {
    position: relative;
    width: 100%;
    overflow: hidden;
    margin-bottom: 0;
    /* negative margin to break out of any parent padding */
    margin-left: -1px;
    margin-right: -1px;
    width: calc(100% + 2px);
  }
  .hero-img {
    width: 100%;
    height: auto;
    display: block;
  }
  .hero-fade {
    position: absolute;
    inset: auto 0 0 0;
    height: 30%;
    max-height: 200px;
    background: linear-gradient(to bottom, transparent, var(--bg));
    pointer-events: none;
  }

  /* ── Creator bar ──────────────────────────────────────────────────────────── */
  .creator-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.625rem 1rem;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--accent) 20%, transparent);
    margin-bottom: 1.5rem;
  }
  .creator-bar-label {
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--accent-text);
  }
  .creator-bar-btn {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--accent-text);
    padding: 0.3rem 0.7rem;
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-radius: var(--radius-sm);
    transition: all var(--transition);
    white-space: nowrap;
  }
  .creator-bar-btn:hover {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-ink, #fff);
  }

  /* ── Event header ─────────────────────────────────────────────────────────── */
  .event-header {
    padding: 1.5rem 0 0;
    margin-bottom: 1.75rem;
  }

  .event-title {
    font-size: 2rem;
    font-weight: 800;
    letter-spacing: -0.03em;
    color: var(--text);
    margin: 0 0 0.5rem;
    line-height: 1.15;
  }

  .event-tagline {
    font-size: 1.125rem;
    font-weight: 500;
    color: var(--text-secondary);
    line-height: 1.4;
    margin: 0 0 1.25rem;
  }

  /* Meta — stacked list, each item its own row */
  .meta-stack {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    margin-bottom: 1.25rem;
  }

  .meta-item {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
  }

  .meta-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    margin-top: 1px;
    color: var(--text-muted);
    opacity: 0.75;
  }

  .meta-text {
    font-family: var(--font-mono, ui-monospace, "SF Mono", "Menlo", monospace);
    font-size: 0.875rem;
    color: var(--text-secondary);
    line-height: 1.4;
    letter-spacing: 0.01em;
    overflow-wrap: break-word;
    word-break: break-word;
  }

  .meta-dim {
    color: var(--text-muted);
  }

  /* ── Stripe purchase success — full-screen overlay ────────────────────────── */
  .purchase-success-overlay {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: var(--bg);
    overflow-y: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem 1.5rem 3rem;
    animation: purchase-success-rise 350ms cubic-bezier(0.2, 0.9, 0.3, 1);
  }
  @keyframes purchase-success-rise {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .purchase-success-inner {
    width: 100%;
    max-width: 400px;
    text-align: center;
  }
  .purchase-success-check {
    width: 4rem;
    height: 4rem;
    margin: 0 auto 1.5rem;
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-ink, #0B0B09);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .purchase-success-title {
    font-size: 1.75rem;
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.02em;
    margin: 0 0 0.625rem;
  }
  .purchase-success-lede {
    font-size: 1rem;
    color: var(--text-secondary, var(--muted));
    line-height: 1.55;
    margin: 0 0 1.5rem;
  }
  .purchase-success-lede strong {
    color: var(--text);
    font-weight: 600;
    word-break: break-all;
  }
  .purchase-success-steps {
    list-style: none;
    margin: 0 auto 1.75rem;
    padding: 0;
    max-width: 320px;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    text-align: left;
  }
  .purchase-success-steps li {
    display: flex;
    align-items: baseline;
    gap: 0.625rem;
    font-size: 0.875rem;
    color: var(--text-secondary, var(--muted));
    line-height: 1.5;
  }
  .purchase-success-bullet {
    flex-shrink: 0;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--text-muted, var(--muted));
    transform: translateY(-2px);
  }
  .purchase-success-actions {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    margin: 0 auto 1rem;
    max-width: 320px;
  }
  .purchase-success-btn {
    width: 100%;
    padding: 0.875rem 1rem;
    font-weight: 600;
    font-size: 0.9375rem;
    border-radius: var(--radius-md, 8px);
    cursor: pointer;
    transition: background var(--transition, 150ms ease), border-color var(--transition, 150ms ease), color var(--transition, 150ms ease);
    font-family: inherit;
  }
  .purchase-success-btn--primary {
    background: var(--accent);
    color: var(--accent-ink, #0B0B09);
    border: 1px solid var(--accent);
  }
  .purchase-success-btn--primary:hover { background: var(--accent-hover, var(--accent)); }
  .purchase-success-btn--ghost {
    background: transparent;
    color: var(--text-secondary, var(--muted));
    border: 1px solid var(--border);
  }
  .purchase-success-btn--ghost:hover { border-color: var(--muted); color: var(--text); }
  .purchase-success-foot {
    margin: 0;
    font-size: 0.6875rem;
    color: var(--text-muted, var(--muted));
    line-height: 1.5;
  }

  /* ── Tickets card ─────────────────────────────────────────────────────────── */
  .tickets-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    overflow: hidden;
    margin-bottom: 1.5rem;
  }

  .tickets-heading {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--text);
    margin: 0;
    padding: 1.125rem 1.25rem 1rem;
    border-bottom: 1px solid var(--border);
    letter-spacing: -0.01em;
  }
  .tickets-heading::before {
    content: "";
    display: inline-block;
    width: 0.375rem;
    height: 0.375rem;
    background: var(--accent);
    flex-shrink: 0;
  }

  .ticket-rows {
    padding: 0.25rem 0;
  }

  .ticket-divider {
    height: 1px;
    background: var(--border);
    margin: 0;
  }

  .ticket-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 1rem 1.25rem;
    transition: background var(--transition);
  }

  .ticket-row--dim {
    opacity: 0.45;
  }

  .ticket-row-left {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .ticket-name {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
    line-height: 1.3;
  }

  .wave-badge {
    display: inline-block;
    font-family: var(--font-mono, ui-monospace, "SF Mono", "Menlo", monospace);
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 0.1rem 0.4rem;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--accent-text);
    width: fit-content;
  }

  .ticket-subdesc {
    font-size: 0.75rem;
    color: var(--text-muted);
    line-height: 1.35;
  }

  .ticket-row-mid {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.1rem;
    flex-shrink: 0;
    min-width: 0;
  }

  .ticket-status {
    font-family: var(--font-mono, ui-monospace, "SF Mono", "Menlo", monospace);
    font-size: 0.6875rem;
    color: var(--text-muted);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    line-height: 1.2;
  }

  .ticket-price {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
  }

  .ticket-price--free {
    color: var(--success, #4ade80);
  }

  .ticket-price--dim {
    color: var(--text-muted) !important;
  }

  /* Qty selector */
  .ticket-row-right {
    flex-shrink: 0;
  }

  .qty-box {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    overflow: hidden;
    transition: border-color var(--transition);
  }

  .qty-box:not(.qty-box--dim):hover {
    border-color: var(--border-hover);
  }

  .qty-box select {
    display: block;
    padding: 0.4rem 1.75rem 0.4rem 0.6rem;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
    background: var(--bg-elevated);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5l3.5 3 3.5-3' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.375rem center;
    border: none;
    outline: none;
    min-width: 3.5rem;
    cursor: pointer;
    font-family: inherit;
    -webkit-appearance: none;
    appearance: none;
    color-scheme: dark;
  }

  .qty-box--dim {
    opacity: 0.5;
  }
  .qty-box--dim select {
    cursor: not-allowed;
  }

  /* Get Tickets footer */
  .tickets-footer {
    padding: 1rem 1.25rem 1.25rem;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .get-tickets-btn {
    width: 100%;
    padding: 0.875rem;
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: 0.01em;
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    color: var(--text-muted);
    cursor: not-allowed;
    transition: all 0.18s ease;
  }

  .get-tickets-btn--active {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-ink, #fff);
    cursor: pointer;
  }

  .get-tickets-btn--active:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }

  .nothing-selected {
    text-align: center;
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0;
  }

  /* ── Claim / checkout panel ───────────────────────────────────────────────── */
  .claim-panel {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    overflow: hidden;
    margin-bottom: 1.5rem;
    animation: slideDown 0.22s ease;
  }

  @keyframes slideDown {
    from { opacity: 0; transform: translateY(-6px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .claim-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--accent) 4%, var(--bg-surface));
  }

  .claim-panel-title {
    font-size: 0.9375rem;
    font-weight: 700;
    color: var(--text);
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .claim-panel-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 50%;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text-muted);
    flex-shrink: 0;
    transition: all var(--transition);
  }
  .claim-panel-close:hover {
    color: var(--text);
    border-color: var(--border-hover);
  }

  .claim-unavailable {
    font-size: 0.875rem;
    color: var(--text-muted);
    margin: 0;
  }

  /* ── About section ────────────────────────────────────────────────────────── */
  .about-section {
    margin-bottom: 1.75rem;
  }

  .section-heading {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--text);
    margin: 0 0 0.875rem;
    letter-spacing: -0.01em;
  }
  .section-heading::before {
    content: "";
    display: inline-block;
    width: 0.375rem;
    height: 0.375rem;
    background: var(--accent);
    flex-shrink: 0;
  }

  .about-text {
    font-size: 0.9375rem;
    line-height: 1.75;
    color: var(--text-secondary);
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    word-break: break-word;
  }

  /* ── Venue section ────────────────────────────────────────────────────────── */
  .venue-section {
    margin-bottom: 1.75rem;
  }

  .venue-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 1rem 1.25rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
  }

  .venue-info { min-width: 0; flex: 1; }

  .venue-name {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
    margin: 0;
    line-height: 1.4;
  }

  .maps-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.45rem 0.875rem;
    font-size: 0.8125rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text-secondary);
    text-decoration: none;
    white-space: nowrap;
    flex-shrink: 0;
    transition: all var(--transition);
  }
  .maps-btn:hover {
    border-color: var(--border-hover);
    color: var(--text);
    background: var(--bg-elevated);
  }

  /* ── Responsive ───────────────────────────────────────────────────────────── */
  @media (max-width: 480px) {
    .event-title { font-size: 1.5rem; }
    .ticket-row { padding: 0.875rem 1rem; }
    .tickets-heading { padding: 1rem 1rem 0.875rem; }
    .tickets-footer { padding: 0.875rem 1rem 1rem; }
    .claim-panel-header { padding: 0.875rem 1rem; }
    .venue-card { flex-direction: column; align-items: flex-start; gap: 0.75rem; }
    .maps-btn { width: 100%; justify-content: center; }
  }
</style>
