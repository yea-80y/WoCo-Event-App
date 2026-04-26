<script lang="ts">
  import type { EventFeed, SeriesSummary, SealedBox, SeriesClaimStatus } from "@woco/shared";
  import { sealJson } from "@woco/shared";
  import { getEvent, claimTicket, claimTicketByEmail, getClaimStatus } from "../../api/events.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { cacheGet, cacheSet, cacheDel, cacheKey, TTL } from "../../cache/cache.js";
  import { onMount } from "svelte";
  import ClaimButton from "../events/ClaimButton.svelte";
  import TicketSuccess from "../events/TicketSuccess.svelte";
  import type { ClaimedTicket } from "@woco/shared";

  interface Props {
    eventId: string;
    ondashboard?: () => void;
    onback?: () => void;
    /** Override API base URL — used when this event is hosted on an organiser's own server */
    apiUrl?: string;
  }

  let { eventId, ondashboard, onback, apiUrl }: Props = $props();

  const BEE_GATEWAY =
    (typeof window !== "undefined" && window.SITE_CONFIG?.gatewayUrl) ||
    import.meta.env.VITE_GATEWAY_URL ||
    "https://gateway.woco-net.com";

  // ── Event loading ─────────────────────────────────────────────────────────
  const _KEY = cacheKey.event(eventId);
  const _cached = cacheGet<EventFeed>(_KEY);

  let event = $state<EventFeed | null>(_cached ?? null);
  let loading = $state(_cached === null);
  let error = $state<string | null>(null);

  // ── Ticket selection ──────────────────────────────────────────────────────
  let selectedSeries = $state<SeriesSummary | null>(null);

  // ── Claim status (per-series availability + user state) ───────────────────
  // Keyed by seriesId — fetched lazily when series is selected or on mount.
  let seriesStatus = $state<Record<string, SeriesClaimStatus>>({});
  let _fetchedStatusWithAddr = false;

  function getSeriesStatus(s: SeriesSummary): SeriesClaimStatus | null {
    return seriesStatus[s.seriesId] ?? null;
  }

  function fetchSeriesStatus(s: SeriesSummary, addr?: string) {
    const sk = cacheKey.claimStatus(eventId, s.seriesId, addr ?? "anon");
    const cached = cacheGet<SeriesClaimStatus>(sk);
    if (cached) seriesStatus = { ...seriesStatus, [s.seriesId]: cached };

    getClaimStatus(eventId, s.seriesId, addr || undefined, undefined, apiUrl)
      .then((fresh) => {
        if (!fresh) return;
        cacheSet(sk, fresh, TTL.CLAIM_STATUS);
        seriesStatus = { ...seriesStatus, [s.seriesId]: fresh };
        if (selectedSeries?.seriesId === s.seriesId) {
          if (fresh.userPendingId && !approvalPending && !claimed) {
            approvalPending = true;
          } else if (fresh.userEdition != null && !claimed) {
            claimed = true;
            claimedEdition = fresh.userEdition;
            claimedVia = "wallet";
          }
        }
      })
      .catch(() => {});
  }

  // ── Claim flow state ──────────────────────────────────────────────────────
  let formData = $state<Record<string, string>>({});
  let inlineEmail = $state("");
  let chosenMethod = $state<"wallet" | "email" | null>(null);
  let claiming = $state(false);
  let claimStep = $state("");
  let claimError = $state<string | null>(null);
  let claimed = $state(false);
  let claimedEdition = $state<number | null>(null);
  let claimedVia = $state<"wallet" | "email" | null>(null);
  let approvalPending = $state(false);
  let ticketQty = $state<Record<string, number>>({});
  let claimOpen = $state(false);

  // ── Ticket success modal ──────────────────────────────────────────────────
  let showSuccessModal = $state(false);
  let successEdition = $state<number | null>(null);
  let successEditions = $state<Array<{ edition: number; ticket?: ClaimedTicket }>>([]);
  let successVia = $state<"wallet" | "email" | null>(null);
  let successTicket = $state<ClaimedTicket | undefined>(undefined);
  let successEmail = $state<string | undefined>(undefined);
  /** seriesId to auto-select after Stripe return — resolved once event loads */
  let stripeReturnSeriesId = $state<string | null>(null);

  /** Persistent Stripe-success banner shown ABOVE the tickets card on return.
   *  Local-only: dismissal clears it for this view, refresh strips the URL
   *  hash so it does not reappear. */
  let stripeBanner = $state<{ email: string | null; qty: number } | null>(null);

  function handleClaimSuccess(data: { edition: number | null; claimedVia: "wallet" | "email" | null; ticket?: ClaimedTicket; claimerEmail?: string; editions?: Array<{ edition: number; ticket?: ClaimedTicket }> }) {
    successEdition = data.edition;
    successEditions = data.editions ?? (data.edition != null ? [{ edition: data.edition, ticket: data.ticket }] : []);
    successVia = data.claimedVia;
    successTicket = data.ticket;
    successEmail = data.claimerEmail;
    showSuccessModal = true;
    if (!claimed) {
      claimed = true;
      claimedEdition = data.edition;
      claimedVia = data.claimedVia;
    }
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const claimMode = $derived(event?.claimMode ?? "wallet");
  const hasOrderForm = $derived(!!event?.orderFields?.length && !!event?.encryptionKey);
  const hasEmailField = $derived(
    !!event?.orderFields?.some((f) => f.type === "email" || f.id === "__email")
  );
  const anySelected = $derived(Object.values(ticketQty).some((v) => v > 0));

  const formValid = $derived(() => {
    if (!event?.orderFields?.length) return true;
    return event.orderFields.every(
      (f) => !f.required || (formData[f.id] ?? "").trim().length > 0
    );
  });

  const walletFormValid = $derived(() => {
    if (!event?.orderFields?.length) return true;
    return event.orderFields.every(
      (f) => f.id === "__email" || !f.required || (formData[f.id] ?? "").trim().length > 0
    );
  });

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

  function shortAddress(addr: string): string {
    return addr.slice(0, 6) + "…" + addr.slice(-4);
  }

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
    if (selectedSeries?.seriesId !== s.seriesId) {
      claimed = false;
      claimedEdition = null;
      claimedVia = null;
      approvalPending = false;
      claimError = null;
      formData = {};
      inlineEmail = "";
      chosenMethod = null;
    }
    selectedSeries = s;
  }

  // ── Claim logic ───────────────────────────────────────────────────────────
  function getEmail(): string | null {
    const fromForm = formData["__email"]?.trim();
    if (fromForm?.includes("@")) return fromForm;
    if (event?.orderFields) {
      for (const f of event.orderFields) {
        if (f.type === "email") {
          const v = formData[f.id]?.trim();
          if (v?.includes("@")) return v;
        }
      }
    }
    const inline = inlineEmail.trim();
    if (inline?.includes("@")) return inline;
    return null;
  }

  function effectiveMethod(): "wallet" | "email" {
    if (claimMode === "wallet") return "wallet";
    if (claimMode === "email") return "email";
    return chosenMethod ?? (auth.isConnected ? "wallet" : "email");
  }

  async function handleClaim(method?: "wallet" | "email") {
    if (!selectedSeries || claiming) return;
    if (method) chosenMethod = method;

    claiming = true;
    claimError = null;

    try {
      const m = method ?? effectiveMethod();

      if (m === "email") {
        const email = getEmail();
        if (!email) {
          claimError = "Please enter a valid email address";
          return;
        }

        let encryptedOrder: SealedBox | undefined;
        if (event?.encryptionKey) {
          claimStep = "Encrypting your info…";
          encryptedOrder = await sealJson(event.encryptionKey, {
            ...(Object.keys(formData).length > 0 ? { fields: formData } : {}),
            seriesId: selectedSeries.seriesId,
            claimerEmail: email,
          });
        }

        claimStep = "Submitting…";
        const result = await claimTicketByEmail(
          eventId,
          selectedSeries.seriesId,
          email,
          encryptedOrder,
          apiUrl,
        );

        if (!result.ok) {
          claimError = result.error || "Failed to register";
          return;
        }

        if (result.approvalPending) {
          approvalPending = true;
          return;
        }

        claimed = true;
        claimedEdition = result.edition ?? null;
        claimedVia = "email";
        handleClaimSuccess({ edition: result.edition ?? null, claimedVia: "email", ticket: result.ticket, claimerEmail: getEmail() || undefined });
      } else {
        if (!auth.isConnected) {
          claimStep = "Waiting for sign-in…";
          const ok = await loginRequest.request();
          if (!ok) {
            claimError = "Login cancelled";
            return;
          }
        }

        if (!auth.hasSession) {
          claimStep = "Approving session…";
          const ok = await auth.ensureSession();
          if (!ok) {
            claimError = "Session approval cancelled";
            return;
          }
        }

        let encryptedOrder: SealedBox | undefined;
        if (event?.encryptionKey) {
          claimStep = "Encrypting your info…";
          encryptedOrder = await sealJson(event.encryptionKey, {
            ...(Object.keys(formData).length > 0 ? { fields: formData } : {}),
            seriesId: selectedSeries.seriesId,
            claimerAddress: auth.parent,
          });
        }

        claimStep = "Registering…";
        const result = await claimTicket(
          eventId,
          selectedSeries.seriesId,
          auth.parent!,
          encryptedOrder,
          apiUrl,
        );

        if (!result.ok) {
          claimError = result.error || "Failed to register";
          return;
        }

        if (result.approvalPending) {
          approvalPending = true;
          if (auth.parent && selectedSeries) {
            const addr = auth.parent.toLowerCase();
            const sk = cacheKey.claimStatus(eventId, selectedSeries.seriesId, addr);
            const cur = cacheGet<SeriesClaimStatus>(sk);
            const base = cur ?? ({ seriesId: selectedSeries.seriesId, totalSupply: selectedSeries.totalSupply, claimed: 0, available: selectedSeries.totalSupply } as SeriesClaimStatus);
            cacheSet(sk, { ...base, userPendingId: "pending" }, TTL.CLAIM_STATUS);
          }
          return;
        }

        claimed = true;
        claimedEdition = result.edition ?? null;
        claimedVia = "wallet";
        handleClaimSuccess({ edition: result.edition ?? null, claimedVia: "wallet", ticket: result.ticket });
        if (auth.parent && selectedSeries) {
          cacheDel(cacheKey.claimStatus(eventId, selectedSeries.seriesId, auth.parent.toLowerCase()));
        }
      }
    } catch (e) {
      claimError = e instanceof Error ? e.message : "Unexpected error";
    } finally {
      claiming = false;
      claimStep = "";
    }
  }

  onMount(() => {
    const addr = auth.parent?.toLowerCase();
    if (addr) _fetchedStatusWithAddr = true;

    const hash = window.location.hash;
    if (hash.includes("stripe=success")) {
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

    getEvent(eventId, apiUrl)
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
          fetchSeriesStatus(s, addr || undefined);
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
        fetchSeriesStatus(s, addr || undefined);
      }
    }
  });

  $effect(() => {
    const addr = auth.parent?.toLowerCase();
    if (!addr || _fetchedStatusWithAddr || !event) return;
    _fetchedStatusWithAddr = true;
    for (const s of event.series) {
      fetchSeriesStatus(s, addr);
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
          src="{BEE_GATEWAY}/bytes/{event.imageHash}"
          alt={event.title}
          class="hero-img"
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

      <!-- Organizer chip -->
      <div class="organizer-chip">
        <div class="organizer-avatar">
          {event.creatorAddress.slice(2, 4).toUpperCase()}
        </div>
        <span class="organizer-addr">{shortAddress(event.creatorAddress)}</span>
      </div>
    </div>

    <!-- ── Stripe success banner — sits above the tickets card so it's the
         first thing the user sees on return, even after dismissing the modal.
         Refresh strips the URL hash, so this won't re-appear on reload. ─── -->
    {#if stripeBanner}
      <div class="stripe-banner" role="status">
        <span class="stripe-banner-check" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </span>
        <span class="stripe-banner-text">
          Payment confirmed —
          {stripeBanner.qty > 1 ? `${stripeBanner.qty} tickets are` : "your ticket is"} on the way
          {#if stripeBanner.email} to <strong>{stripeBanner.email}</strong>{/if}.
        </span>
        <button
          type="button"
          class="stripe-banner-close"
          onclick={() => { stripeBanner = null; }}
          aria-label="Dismiss confirmation"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/>
          </svg>
        </button>
      </div>
    {/if}

    <!-- ── Tickets card ──────────────────────────────────────────────────── -->
    <div class="tickets-card">
      <h2 class="tickets-heading">Tickets</h2>

      <div class="ticket-rows">
        {#each event.series as s, i}
          {@const sale = saleStatus(s)}
          {@const ss = getSeriesStatus(s)}
          {@const soldOut = ss != null && ss.available === 0}
          {@const isUnavailable = sale !== "active" || soldOut}
          {@const isPaid = s.payment && parseFloat(s.payment.price) > 0}
          {@const qty = ticketQty[s.seriesId] ?? 0}
          {@const maxQty = (sale !== "active" || soldOut) ? 0 : Math.min(ss?.available ?? 10, 10)}

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
              {#if sale === "future"}
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
          class:get-tickets-btn--active={anySelected}
          disabled={!anySelected}
          onclick={handleGetTickets}
        >
          Get Tickets
        </button>
        {#if !anySelected}
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
          <button class="claim-panel-close" onclick={() => { claimOpen = false; }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
        </div>

        {#if selectedSeries.payment && parseFloat(selectedSeries.payment.price) > 0}
          <ClaimButton
            eventId={eventId}
            seriesId={selectedSeries.seriesId}
            totalSupply={selectedSeries.totalSupply}
            encryptionKey={event.encryptionKey}
            orderFields={event.orderFields}
            claimMode={claimMode}
            approvalRequired={selectedSeries.approvalRequired ?? false}
            apiUrl={apiUrl}
            payment={selectedSeries.payment}
            eventEndDate={event.endDate}
            quantity={ticketQty[selectedSeries.seriesId] ?? 1}
            onclaim={handleClaimSuccess}
          />

        {:else if claimed}
          <div class="claim-success">
            <div class="success-check">
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M4 10l5 5 7-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <div class="success-body">
              <p class="success-title">
                {claimedVia === "email" ? "Registration submitted!" : "Ticket claimed!"}
              </p>
              {#if claimedEdition != null}
                <p class="success-detail">Ticket #{claimedEdition} · {selectedSeries.name}</p>
              {/if}
              <button class="success-view-btn" onclick={() => { successEdition = claimedEdition; successVia = claimedVia; showSuccessModal = true; }}>
                View ticket &amp; QR
              </button>
            </div>
          </div>

        {:else if approvalPending}
          <div class="claim-pending">
            <div class="pending-dot"></div>
            <div>
              <p class="pending-title">Request submitted — pending approval</p>
              <p class="pending-note">You'll receive your ticket once the organizer approves it.</p>
            </div>
          </div>

        {:else}
          <!-- Order form -->
          {#if hasOrderForm && event.orderFields}
            <div class="form-fields">
              {#each event.orderFields as field}
                <label class="form-field">
                  <span class="form-label">
                    {field.label || field.placeholder || field.type}
                    {#if field.required}<span class="required">*</span>{/if}
                  </span>
                  {#if field.type === "textarea"}
                    <textarea
                      bind:value={formData[field.id]}
                      placeholder={field.placeholder || ""}
                      maxlength={field.maxLength}
                      rows="3"
                    ></textarea>
                  {:else if field.type === "select" && field.options}
                    <select bind:value={formData[field.id]}>
                      <option value="">Select…</option>
                      {#each field.options as opt}
                        <option value={opt}>{opt}</option>
                      {/each}
                    </select>
                  {:else if field.type === "checkbox"}
                    <label class="checkbox-row">
                      <input
                        type="checkbox"
                        checked={formData[field.id] === "yes"}
                        onchange={(e) =>
                          (formData[field.id] = (e.target as HTMLInputElement).checked ? "yes" : "")}
                      />
                      <span>{field.placeholder || field.label}</span>
                    </label>
                  {:else}
                    <input
                      type={field.type}
                      bind:value={formData[field.id]}
                      placeholder={field.placeholder || ""}
                      maxlength={field.maxLength}
                    />
                  {/if}
                </label>
              {/each}
            </div>
          {/if}

          {#if claimMode === "both" && !hasEmailField}
            <label class="form-field">
              <span class="form-label">
                Email <span class="form-label-optional">(for email claim)</span>
              </span>
              <input type="email" bind:value={inlineEmail} placeholder="your@email.com" />
            </label>
          {/if}

          {#if claimError}
            <p class="claim-error">{claimError}</p>
          {/if}

          <div class="claim-actions">
            {#if claiming}
              <button class="claim-btn" disabled>{claimStep || "Processing…"}</button>
            {:else if claimMode === "both"}
              <button
                class="claim-btn"
                onclick={() => handleClaim("wallet")}
                disabled={!walletFormValid()}
              >
                {selectedSeries.approvalRequired ? "Request with wallet" : "Claim with wallet"}
              </button>
              <button
                class="claim-btn claim-btn--outline"
                onclick={() => handleClaim("email")}
                disabled={!formValid() || (!hasEmailField && !inlineEmail.trim())}
              >
                {selectedSeries.approvalRequired ? "Request with email" : "Claim with email"}
              </button>
            {:else if claimMode === "email"}
              <button
                class="claim-btn"
                onclick={() => handleClaim("email")}
                disabled={!formValid()}
              >
                {selectedSeries.approvalRequired ? "Request to attend" : "Claim with email"}
              </button>
            {:else}
              <button
                class="claim-btn"
                onclick={() => handleClaim("wallet")}
                disabled={!walletFormValid()}
              >
                {selectedSeries.approvalRequired ? "Request to attend" : "Claim ticket"}
              </button>
            {/if}
          </div>

          {#if hasOrderForm}
            <p class="encrypt-note">
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true" style="display:inline;vertical-align:middle;margin-right:3px">
                <rect x="2" y="5" width="8" height="6" rx="1" stroke="currentColor" stroke-width="1.2"/>
                <path d="M4 5V4a2 2 0 1 1 4 0v1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
              </svg>
              Your info is encrypted — only the organizer can read it.
            </p>
          {/if}

        {/if}
      </div>
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

{#if showSuccessModal && event && selectedSeries}
  <TicketSuccess
    event={event}
    series={selectedSeries}
    edition={successEdition}
    editions={successEditions}
    claimedVia={successVia}
    claimerEmail={successEmail}
    ticket={successTicket}
    onclose={() => { showSuccessModal = false; }}
  />
{/if}

<style>
  /* ── Page shell ───────────────────────────────────────────────────────────── */
  .event-page {
    max-width: 640px;
    margin: 0 auto;
    padding-bottom: 4rem;
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
    aspect-ratio: 16 / 9;
    overflow: hidden;
    margin-bottom: 0;
    /* negative margin to break out of any parent padding */
    margin-left: -1px;
    margin-right: -1px;
    width: calc(100% + 2px);
  }
  .hero-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center;
    display: block;
  }
  .hero-fade {
    position: absolute;
    inset: auto 0 0 0;
    height: 50%;
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
    color: #fff;
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
    margin: 0 0 1.25rem;
    line-height: 1.15;
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
    font-size: 0.9375rem;
    color: var(--text-secondary);
    line-height: 1.4;
  }

  .meta-dim {
    color: var(--text-muted);
  }

  /* Organizer chip */
  .organizer-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.75rem 0.375rem 0.375rem;
    border: 1px solid var(--border);
    border-radius: 9999px;
    background: var(--bg-surface);
  }

  .organizer-avatar {
    width: 1.625rem;
    height: 1.625rem;
    border-radius: 50%;
    background: color-mix(in srgb, var(--accent) 20%, var(--bg-elevated));
    color: var(--accent-text);
    font-size: 0.625rem;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    letter-spacing: 0.02em;
    flex-shrink: 0;
  }

  .organizer-addr {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    font-family: monospace;
    letter-spacing: 0.02em;
  }

  /* ── Stripe success banner ─────────────────────────────────────────────────── */
  .stripe-banner {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
    border: 1px solid color-mix(in srgb, var(--accent, #3ddb8a) 35%, transparent);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--accent, #3ddb8a) 10%, transparent);
    color: var(--text-primary);
    font-size: 0.875rem;
    line-height: 1.4;
  }
  .stripe-banner-check {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    flex: 0 0 auto;
    border-radius: 999px;
    background: var(--accent, #3ddb8a);
    color: var(--bg-base, #0a0a0a);
  }
  .stripe-banner-text { flex: 1 1 auto; }
  .stripe-banner-text strong { color: var(--text-primary); font-weight: 600; }
  .stripe-banner-close {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .stripe-banner-close:hover {
    background: color-mix(in srgb, currentColor 12%, transparent);
    color: var(--text-primary);
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
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--text);
    margin: 0;
    padding: 1.125rem 1.25rem 1rem;
    border-bottom: 1px solid var(--border);
    letter-spacing: -0.01em;
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
    font-size: 0.625rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
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
    font-size: 0.6875rem;
    color: var(--text-muted);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.04em;
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
    padding: 0.4rem 0.5rem;
    font-size: 0.9375rem;
    font-weight: 500;
    color: var(--text);
    background: transparent;
    border: none;
    outline: none;
    min-width: 3.25rem;
    cursor: pointer;
    font-family: inherit;
    appearance: auto;
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
    color: #fff;
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

  /* ── Order form (inside claim panel) ──────────────────────────────────────── */
  .form-fields {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1.25rem 1.25rem 0;
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .form-label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .form-label-optional {
    font-weight: 400;
    color: var(--text-muted);
    font-size: 0.75rem;
    text-transform: none;
    letter-spacing: 0;
  }

  .required { color: var(--error); margin-left: 0.125rem; }

  .form-field input,
  .form-field textarea,
  .form-field select {
    padding: 0.625rem 0.875rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 0.9375rem;
    font-family: inherit;
    transition: border-color var(--transition);
    resize: vertical;
  }

  .form-field input:focus,
  .form-field textarea:focus,
  .form-field select:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent);
  }

  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: var(--text-secondary);
    cursor: pointer;
  }

  /* ── Claim actions ────────────────────────────────────────────────────────── */
  .claim-actions {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding: 1.25rem 1.25rem 0;
  }

  .claim-btn {
    width: 100%;
    padding: 0.75rem 1.375rem;
    font-size: 0.9375rem;
    font-weight: 700;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: #fff;
    white-space: nowrap;
    transition: background var(--transition);
    letter-spacing: 0.01em;
  }

  .claim-btn:hover:not(:disabled) { background: var(--accent-hover); }
  .claim-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .claim-btn--outline {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-secondary);
  }
  .claim-btn--outline:hover:not(:disabled) {
    background: var(--bg-elevated);
    border-color: var(--border-hover);
  }

  .claim-error {
    font-size: 0.8125rem;
    color: var(--error);
    margin: 0;
    padding: 0 1.25rem;
  }

  .encrypt-note {
    font-size: 0.75rem;
    color: var(--text-muted);
    padding: 0.75rem 1.25rem 0;
    margin: 0;
  }

  /* ── Claim success ────────────────────────────────────────────────────────── */
  .claim-success {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    padding: 1.25rem;
  }

  .success-check {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 50%;
    background: color-mix(in srgb, var(--success) 15%, transparent);
    color: var(--success);
    flex-shrink: 0;
    border: 1.5px solid color-mix(in srgb, var(--success) 30%, transparent);
  }

  .success-body { min-width: 0; }

  .success-title {
    font-size: 0.9375rem;
    font-weight: 700;
    color: var(--text);
    margin: 0 0 0.25rem;
  }

  .success-detail {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    margin: 0 0 0.25rem;
  }

  .success-view-btn {
    margin-top: 0.625rem;
    display: inline-flex;
    padding: 0.45rem 0.875rem;
    font-size: 0.8125rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
    color: var(--accent-text);
    cursor: pointer;
    transition: background var(--transition);
  }
  .success-view-btn:hover {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
  }

  /* ── Claim pending ────────────────────────────────────────────────────────── */
  .claim-pending {
    display: flex;
    align-items: flex-start;
    gap: 0.875rem;
    padding: 1.25rem;
  }

  .pending-dot {
    width: 0.625rem;
    height: 0.625rem;
    border-radius: 50%;
    background: #d97706;
    flex-shrink: 0;
    margin-top: 0.25rem;
  }

  .pending-title {
    font-size: 0.875rem;
    font-weight: 700;
    color: #d97706;
    margin: 0 0 0.3rem;
  }

  .pending-note {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0;
  }

  /* ── About section ────────────────────────────────────────────────────────── */
  .about-section {
    margin-bottom: 1.75rem;
  }

  .section-heading {
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--text);
    margin: 0 0 0.875rem;
    letter-spacing: -0.01em;
  }

  .about-text {
    font-size: 0.9375rem;
    line-height: 1.75;
    color: var(--text-secondary);
    margin: 0;
    white-space: pre-wrap;
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
    .form-fields { padding: 1rem 1rem 0; }
    .claim-actions { padding: 1rem 1rem 0; }
    .encrypt-note { padding: 0.625rem 1rem 0; }
    .venue-card { flex-direction: column; align-items: flex-start; gap: 0.75rem; }
    .maps-btn { width: 100%; justify-content: center; }
  }
</style>
