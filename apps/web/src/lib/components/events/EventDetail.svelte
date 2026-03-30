<script lang="ts">
  import type { EventFeed } from "@woco/shared";
  import { getEvent } from "../../api/events.js";
  import ClaimButton from "./ClaimButton.svelte";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { navigate } from "../../router/router.svelte.js";
  import { cacheGet, cacheSet, cacheKey, TTL } from "../../cache/cache.js";
  import { getExternalEventApi } from "../../api/event-api-registry.js";
  import { getProfile } from "../../api/profiles.js";
  import type { UserProfile } from "@woco/shared";
  import UserAvatar from "../profile/UserAvatar.svelte";
  import { onMount } from "svelte";

  interface Props {
    eventId: string;
    onback?: () => void;
  }

  let { eventId, onback }: Props = $props();

  // External API URL — set by home page when navigating to an externally-listed event
  const externalApiUrl = getExternalEventApi(eventId);

  // Synchronous cache read — before first render, so no loading flash on return visits
  const _KEY = cacheKey.event(eventId);
  const _cached = cacheGet<EventFeed>(_KEY);

  let event = $state<EventFeed | null>(_cached ?? null);
  let loading = $state(_cached === null);
  let error = $state<string | null>(null);
  let creatorProfile = $state<UserProfile | null>(null);

  const BEE_GATEWAY = import.meta.env.VITE_GATEWAY_URL || "https://gateway.woco-net.com";

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
        getProfile(fresh.creatorAddress).then((p) => { creatorProfile = p; });
      })
      .catch((e) => {
        if (_cached === null) {
          error = e instanceof Error ? e.message : "Failed to load event";
          loading = false;
        }
      });
  });
</script>

<div class="event-detail">
  <button class="back-link" onclick={onback}>&larr; Back to events</button>

  {#if loading}
    <p class="status">Loading event...</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if event}
    {#if event.imageHash}
      <img
        src="{BEE_GATEWAY}/bytes/{event.imageHash}"
        alt={event.title}
        class="hero-image"
      />
    {/if}

    <h1>{event.title}</h1>

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
    </div>

    {#if event.description}
      <p class="description">{event.description}</p>
    {/if}

    {#if auth.parent?.toLowerCase() === event.creatorAddress.toLowerCase()}
      <div class="organizer-banner">
        <div class="organizer-banner-text">
          <span class="organizer-label">You are the organizer</span>
          <span class="organizer-hint">View attendee order data and export to CSV</span>
        </div>
        <button class="organizer-dashboard-btn" onclick={() => navigate(`/event/${event!.eventId}/dashboard`)}>
          Orders Dashboard
        </button>
      </div>
    {/if}

    <h2>Tickets</h2>
    <div class="series-list">
      {#each event.series as s}
        <div class="series-card">
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
          />
        </div>
      {/each}
    </div>

    <div class="actions-cta">
      <button class="embed-btn" onclick={() => navigate(`/event/${event!.eventId}/embed`)}>
        Embed on your site
      </button>
    </div>
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
  }

  .meta {
    color: var(--text-secondary);
    font-size: 0.875rem;
    margin-bottom: 1.5rem;
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
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .creator-name {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
  }

  .creator-section:hover .creator-name {
    color: var(--accent-text);
  }

  .description {
    color: var(--text-secondary);
    line-height: 1.7;
    margin-bottom: 2rem;
  }

  h2 {
    color: var(--text);
    font-size: 1.125rem;
    font-weight: 600;
    margin: 0 0 0.75rem;
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
    color: #fff;
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
