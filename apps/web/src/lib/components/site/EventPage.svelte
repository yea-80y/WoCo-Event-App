<script lang="ts">
  import type { EventFeed } from "@woco/shared";
  import { getEvent } from "../../api/events.js";
  import ClaimButton from "../events/ClaimButton.svelte";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { cacheGet, cacheSet, cacheKey, TTL } from "../../cache/cache.js";
  import { onMount } from "svelte";

  interface Props {
    eventId: string;
    ondashboard?: () => void;
  }

  let { eventId, ondashboard }: Props = $props();

  // Use VITE_GATEWAY_URL for Swarm image assets; fall back to the public ethswarm gateway
  const BEE_GATEWAY = import.meta.env.VITE_GATEWAY_URL || "https://gateway.ethswarm.org";

  const _KEY = cacheKey.event(eventId);
  const _cached = cacheGet<EventFeed>(_KEY);

  let event = $state<EventFeed | null>(_cached ?? null);
  let loading = $state(_cached === null);
  let error = $state<string | null>(null);

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
    getEvent(eventId)
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
      })
      .catch((e) => {
        if (_cached === null) {
          error = e instanceof Error ? e.message : "Failed to load event";
          loading = false;
        }
      });
  });
</script>

<div class="event-page">
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

    {#if event.description}
      <p class="description">{event.description}</p>
    {/if}

    {#if auth.parent?.toLowerCase() === event.creatorAddress.toLowerCase()}
      <div class="organizer-banner">
        <div class="organizer-banner-text">
          <span class="organizer-label">You are the organizer</span>
          <span class="organizer-hint">View attendee order data and manage approvals</span>
        </div>
        <button class="organizer-dashboard-btn" onclick={ondashboard}>
          Dashboard
        </button>
      </div>
    {/if}

    <h2>Tickets</h2>
    <div class="series-list">
      {#each event.series as s}
        <div class="series-card">
          <div class="series-info">
            <h3>{s.name}</h3>
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
          />
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .event-page {
    max-width: 640px;
    margin: 0 auto;
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

  .description {
    color: var(--text-secondary);
    line-height: 1.7;
    margin-bottom: 2rem;
    white-space: pre-wrap;
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
