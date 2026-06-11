<script lang="ts">
  import type { EventFeed, Hex0x } from "@woco/shared";
  import { SubjectType, profileLikeSubject } from "@woco/shared";
  import { rememberLabel } from "../../likes/label-cache.js";
  import { getEvent } from "../../api/events.js";
  import ClaimButton from "./ClaimButton.svelte";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { navigate } from "../../router/router.svelte.js";
  import { cacheGet, cacheSet, cacheKey, TTL } from "../../cache/cache.js";
  import { getExternalEventApi } from "../../api/event-api-registry.js";
  import { getProfile } from "../../api/profiles.js";
  import type { UserProfile } from "@woco/shared";
  import UserAvatar from "../../components/profile/UserAvatar.svelte";
  import LikeButton from "../../components/likes/LikeButton.svelte";
  import { onMount, onDestroy } from "svelte";
  import { isPastEvent as checkPast } from "../../utils/events.js";
  import { firstImageUrl, useNextImageUrl } from "../../components/site/image-fallback.js";

  interface Props {
    eventId: string;
    onback?: () => void;
  }

  let { eventId, onback }: Props = $props();

  // Stripe post-purchase redirect — fires synchronously before children (ClaimButton)
  // mount, so the legacy in-page success banner never appears. We send buyers to the
  // dedicated /event/:id/purchased route which reads the same sessionStorage stash.
  const _redirectingPurchased = (() => {
    if (typeof window === "undefined") return false;
    const hash = window.location.hash;
    if (!hash.includes("stripe=success")) return false;
    window.location.replace(`#/event/${eventId}/purchased`);
    return true;
  })();

  // External API URL — set by home page when navigating to an externally-listed event
  const externalApiUrl = getExternalEventApi(eventId);

  // Synchronous cache read — before first render, so no loading flash on return visits
  const _KEY = cacheKey.event(eventId);
  const _cached = cacheGet<EventFeed>(_KEY);

  let event = $state<EventFeed | null>(_cached ?? null);
  let loading = $state(_cached === null);
  let error = $state<string | null>(null);
  let creatorProfile = $state<UserProfile | null>(null);
  let ticketQty = $state<Record<string, number>>({});
  let now = $state(Date.now());
  let clockTimer: ReturnType<typeof setInterval>;

  const BEE_GATEWAY = import.meta.env.VITE_GATEWAY_URL || "https://gateway.woco-net.com";

  const eventSubject = $derived((() => {
    const eid = event?.series.find(s => s.onChainEventId)?.onChainEventId;
    if (!eid) return null;
    return { type: SubjectType.Event, id: eid.toLowerCase() as Hex0x };
  })());

  const isPastEvent = $derived(!!event && checkPast(event, now));

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  onMount(() => {
    clockTimer = setInterval(() => { now = Date.now(); }, 60_000);
    // Always fetch fresh — silently patches title, dates, series etc. if changed
    getEvent(eventId, externalApiUrl)
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
        // Debug: log series payment data from API
        for (const s of fresh.series) {
          console.log(`[EventDetail] series "${s.name}" payment:`, s.payment ?? "FREE");
        }
        // Fetch creator profile
        getProfile(fresh.creatorAddress).then((p) => {
          creatorProfile = p;
          rememberLabel(p?.subEnsLabel); // so Following/Trending can show the name
        });
      })
      .catch((e) => {
        if (_cached === null) {
          error = e instanceof Error ? e.message : "Failed to load event";
          loading = false;
        }
      });
  });

  onDestroy(() => clearInterval(clockTimer));
</script>

<div class="event-detail">
  {#if _redirectingPurchased}
    <!-- About to swap to /event/:id/purchased; render nothing to avoid mounting ClaimButton. -->
  {:else}
  <button class="back-link" onclick={onback}>&larr; Back to events</button>

  {#if loading}
    <p class="status">Loading event...</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if event}
    {#if event.imageHash}
      <img
        src={firstImageUrl(event.imageHash, BEE_GATEWAY)}
        alt={event.title}
        class="hero-image"
        data-image-gateway-index="0"
        onerror={(e) => useNextImageUrl(e, event?.imageHash, BEE_GATEWAY)}
      />
    {/if}

    <h1>
      {event.title}
      {#if isPastEvent}<span class="past-pill">Past event</span>{/if}
    </h1>

    {#if event.tagline}
      <p class="tagline">{event.tagline}</p>
    {/if}

    {#if isPastEvent}
      <div class="past-banner">
        This event has ended. Tickets are no longer available — this page is here for reference.
      </div>
    {/if}

    <div class="meta">
      <p class="dates">{formatDate(event.startDate)} &mdash; {formatDate(event.endDate)}</p>
      {#if event.location}
        <p class="location">{event.location}</p>
      {/if}
    </div>

    <!-- Creator profile chip -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div
      class="creator-section"
      role="button"
      onclick={() => navigate(`/profile/${event!.creatorAddress.toLowerCase()}`)}
    >
      <UserAvatar address={event.creatorAddress} size={40} profile={creatorProfile} />
      <div class="creator-info">
        <span class="creator-label">Hosted by</span>
        <span class="creator-name">
          {creatorProfile?.displayName || `${event.creatorAddress.slice(0, 6)}...${event.creatorAddress.slice(-4)}`}
        </span>
      </div>
      <!-- Follow the organiser by NAME (sub-ENS namehash) — only when they've
           claimed one (a name is what a follow attaches to). Not your own. -->
      {#if creatorProfile?.subEnsLabel && auth.parent?.toLowerCase() !== event.creatorAddress.toLowerCase()}
        <div class="creator-follow">
          <LikeButton subject={profileLikeSubject(creatorProfile.subEnsLabel)} variant="follow" />
        </div>
      {/if}
    </div>

    {#if eventSubject || event.subEnsLabel}
      <!-- Social row: the event's .woco.eth identity (display — ownership lives
           on-chain) + like on the HAPPENING (keyed to the immutable on-chain
           event id, so likes survive a name repoint). -->
      <div class="social-actions">
        {#if event.subEnsLabel}
          <span class="ens-plate" title="This event's permanent web3 address">
            <svg class="ens-mark" width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M6 0.5L7.6 4.4L11.5 6L7.6 7.6L6 11.5L4.4 7.6L0.5 6L4.4 4.4Z"
                    fill="currentColor" opacity="0.85"/>
            </svg>
            <span class="ens-label">{event.subEnsLabel}</span><span class="ens-tld">.woco.eth</span>
          </span>
        {/if}
        {#if eventSubject}
          <LikeButton subject={eventSubject} />
        {/if}
      </div>
    {/if}

    {#if event.description}
      <p class="description">{event.description}</p>
    {/if}

    {#if auth.parent?.toLowerCase() === event.creatorAddress.toLowerCase()}
      <div class="organizer-banner">
        <div class="organizer-banner-text">
          <span class="organizer-label">You are the organizer</span>
          <span class="organizer-hint">View attendee order data and export to CSV</span>
        </div>
        <button class="organizer-dashboard-btn" onclick={() => navigate(`/creator/events/${event!.eventId}`)}>
          Orders Dashboard
        </button>
      </div>
    {/if}

    <h2>Tickets</h2>
    {#if isPastEvent}
      <div class="past-tickets-block">
        <div class="past-tickets-list">
          {#each event.series as s}
            <div class="past-series-row">
              <span class="past-series-name">{s.name}</span>
              {#if s.payment && parseFloat(s.payment.price) > 0}
                <span class="past-series-price">{s.payment.currency === "USD" ? `$${s.payment.price}` : `${s.payment.price} ${s.payment.currency}`}</span>
              {:else}
                <span class="past-series-price past-series-price--free">Free</span>
              {/if}
            </div>
          {/each}
        </div>
        <p class="past-tickets-note">Ticket sales have closed.</p>
      </div>
    {:else}
      <div class="series-list">
        {#each event.series as s}
          {@const isPaid = !!(s.payment && parseFloat(s.payment.price) > 0)}
          <div class="series-card" class:series-card--paid={isPaid}>
            <div class="series-top">
              <div class="series-info">
                <div class="series-header">
                  <h3>{s.name}</h3>
                  {#if s.payment && parseFloat(s.payment.price) > 0}
                    <span class="series-price">{s.payment.currency === "USD" ? `$${s.payment.price}` : `${s.payment.price} ${s.payment.currency}`}</span>
                  {:else}
                    <span class="series-price series-price--free">Free</span>
                  {/if}
                </div>
                {#if s.description}
                  <p class="series-desc">{s.description}</p>
                {/if}
              </div>
              {#if isPaid}
                <div class="series-qty">
                  <span class="qty-label">Qty</span>
                  <select
                    value={ticketQty[s.seriesId] ?? 1}
                    onchange={(e) => { ticketQty = { ...ticketQty, [s.seriesId]: parseInt((e.target as HTMLSelectElement).value) }; }}
                  >
                    {#each Array.from({ length: 10 }, (_, i) => i + 1) as n}
                      <option value={n}>{n}</option>
                    {/each}
                  </select>
                </div>
              {/if}
            </div>
            <ClaimButton
              eventId={event.eventId}
              seriesId={s.seriesId}
              totalSupply={s.totalSupply}
              encryptionKey={event.encryptionKey}
              orderFields={event.orderFields}
              claimMode={event.claimMode ?? "wallet"}
              approvalRequired={s.approvalRequired ?? false}
              apiUrl={externalApiUrl}
              payment={s.payment}
              eventEndDate={event.endDate}
              quantity={ticketQty[s.seriesId] ?? 1}
            />
          </div>
        {/each}
      </div>
    {/if}

    <div class="actions-cta">
      <button class="embed-btn" onclick={() => navigate(`/event/${event!.eventId}/embed`)}>
        Embed on your site
      </button>
    </div>
  {/if}
  {/if}
</div>

<style>
  .event-detail {
    max-width: 640px;
    margin: 0 auto;
  }

  .back-link {
    color: var(--text-muted);
    font-size: 0.875rem;
    margin-bottom: 1.5rem;
    display: inline-block;
    transition: color var(--transition);
  }

  .back-link:hover {
    color: var(--accent-text);
  }

  .hero-image {
    width: 100%;
    max-height: 340px;
    object-fit: cover;
    border-radius: var(--radius-md);
    margin-bottom: 1.5rem;
  }

  h1 {
    color: var(--text);
    margin: 0 0 0.5rem;
    font-size: 1.75rem;
    font-weight: 700;
    letter-spacing: -0.01em;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.625rem;
  }

  .tagline {
    margin: 0 0 0.875rem;
    color: var(--text-secondary);
    font-size: 1.0625rem;
    font-weight: 500;
    line-height: 1.4;
  }

  .past-pill {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 600;
    padding: 0.125rem 0.5rem;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--warning) 18%, transparent);
    color: var(--warning);
    border: 1px solid color-mix(in srgb, var(--warning) 40%, transparent);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .past-banner {
    margin: 0 0 1.25rem;
    padding: 0.75rem 1rem;
    font-size: 0.875rem;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--warning) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--warning) 25%, var(--border));
    border-left: 3px solid var(--warning);
    border-radius: var(--radius-sm);
    line-height: 1.5;
  }

  .meta {
    color: var(--text-secondary);
    font-size: 0.875rem;
    margin-bottom: 1.5rem;
    font-family: var(--font-mono);
    letter-spacing: 0.02em;
  }

  .meta p {
    margin: 0.125rem 0;
  }

  .location {
    color: var(--text-muted);
  }

  .creator-section {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 0;
    margin-bottom: 0.75rem;
    cursor: pointer;
    transition: opacity var(--transition);
  }

  .creator-section:hover {
    opacity: 0.8;
  }

  .creator-info {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
  }

  .creator-label {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }

  .creator-name {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
  }

  .creator-section:hover .creator-name {
    color: var(--accent-text);
  }

  .creator-follow {
    margin-left: auto;
    flex-shrink: 0;
  }

  .social-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.25rem 0 1rem;
  }

  /* The event's claimed .woco.eth name — a mono plate with an acid spark.
     Display only: the like alongside it is keyed to the on-chain event id. */
  .ens-plate {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.3125rem 0.625rem 0.3125rem 0.5rem;
    font-family: var(--font-mono);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    line-height: 1;
    color: var(--accent-text);
    background: color-mix(in srgb, var(--accent) 7%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }

  .ens-mark { color: var(--accent); flex-shrink: 0; }

  .ens-tld { color: var(--text-muted); font-weight: 500; }

  .description {
    color: var(--text-secondary);
    line-height: 1.7;
    margin-bottom: 2rem;
    overflow-wrap: break-word;
    word-break: break-word;
  }

  h2 {
    color: var(--text);
    font-size: 1.125rem;
    font-weight: 600;
    margin: 0 0 0.75rem;
  }

  .past-tickets-block {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    opacity: 0.7;
  }

  .past-tickets-list {
    display: flex;
    flex-direction: column;
  }

  .past-series-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
    gap: 0.5rem;
  }

  .past-series-row:last-child { border-bottom: none; }

  .past-series-name {
    font-size: 0.9375rem;
    font-weight: 500;
    color: var(--text-secondary);
  }

  .past-series-price {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
    background: var(--bg-surface-hover);
    padding: 0.125rem 0.5rem;
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }

  .past-series-price--free { background: transparent; }

  .past-tickets-note {
    margin: 0;
    padding: 0.625rem 1rem;
    font-size: 0.8125rem;
    color: var(--text-dim);
    background: var(--bg-surface);
    border-top: 1px solid var(--border);
    font-style: italic;
  }

  .series-list {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .series-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 1rem 1.125rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    transition: border-color var(--transition);
  }

  .series-card--paid {
    flex-direction: column;
    align-items: stretch;
    gap: 0.875rem;
  }

  .series-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
  }

  .series-qty {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .qty-label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-muted);
  }

  .series-qty select {
    padding: 0.35rem 1.75rem 0.35rem 0.6rem;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    -webkit-appearance: none;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5l3.5 3 3.5-3' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.375rem center;
    cursor: pointer;
    font-family: inherit;
    min-width: 3.5rem;
  }

  .series-qty select:focus {
    outline: none;
    border-color: var(--accent);
  }

  .series-card:hover {
    border-color: var(--border-hover);
  }

  .series-card h3 {
    margin: 0;
    color: var(--text);
    font-size: 0.9375rem;
    font-weight: 500;
  }

  .series-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .series-price {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--accent-text);
    background: var(--accent-subtle);
    padding: 0.125rem 0.5rem;
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }

  .series-price--free {
    color: var(--success);
    background: transparent;
  }

  .series-desc {
    color: var(--text-muted);
    font-size: 0.8125rem;
    margin: 0.125rem 0 0;
  }

  .organizer-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.875rem 1.125rem;
    margin-bottom: 1.5rem;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }

  .organizer-banner-text {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .organizer-label {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--accent-text);
  }

  .organizer-hint {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .organizer-dashboard-btn {
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
    font-weight: 600;
    background: var(--accent);
    border-radius: var(--radius-sm);
    color: var(--accent-ink);
    white-space: nowrap;
    transition: opacity var(--transition);
  }

  .organizer-dashboard-btn:hover {
    opacity: 0.85;
  }

  .actions-cta {
    margin-top: 2rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--border);
  }

  .embed-btn {
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
    font-weight: 500;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    transition: all var(--transition);
  }

  .embed-btn:hover {
    border-color: var(--accent);
    color: var(--accent-text);
  }

  .status {
    text-align: center;
    color: var(--text-muted);
    padding: 3rem 0;
  }

  .error {
    text-align: center;
    color: var(--error);
    padding: 3rem 0;
  }
</style>
