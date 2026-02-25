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

  const BEE_GATEWAY = import.meta.env.VITE_GATEWAY_URL || "https://gateway.ethswarm.org";

  const _KEY = cacheKey.event(eventId);
  const _cached = cacheGet<EventFeed>(_KEY);

  let event = $state<EventFeed | null>(_cached ?? null);
  let loading = $state(_cached === null);
  let error = $state<string | null>(null);

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
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
    <div class="state-wrap">
      <div class="loader"></div>
      <p class="state-text">Loading event…</p>
    </div>
  {:else if error}
    <div class="state-wrap">
      <p class="state-error">{error}</p>
    </div>
  {:else if event}

    <!-- Banner image -->
    {#if event.imageHash}
      <div class="banner-wrap">
        <img
          src="{BEE_GATEWAY}/bytes/{event.imageHash}"
          alt={event.title}
          class="banner-img"
        />
        <div class="banner-fade"></div>
      </div>
    {/if}

    <!-- Event header -->
    <div class="event-header">
      <h1 class="event-title">{event.title}</h1>

      <div class="meta-row">
        <span class="meta-item">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
            <path d="M5 1v3M11 1v3M2 7h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          {formatDate(event.startDate)}
          {#if event.endDate && event.endDate !== event.startDate}
            <span class="meta-sep">–</span>
            {formatDate(event.endDate)}
          {/if}
        </span>

        {#if event.location}
          <span class="meta-item">
            <svg width="13" height="14" viewBox="0 0 14 16" fill="none" aria-hidden="true">
              <path d="M7 1C4.239 1 2 3.239 2 6c0 3.75 5 9 5 9s5-5.25 5-9c0-2.761-2.239-5-5-5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
              <circle cx="7" cy="6" r="1.5" stroke="currentColor" stroke-width="1.3"/>
            </svg>
            {event.location}
          </span>
        {/if}
      </div>

      {#if event.description}
        <p class="event-desc">{event.description}</p>
      {/if}
    </div>

    <!-- Organizer bar (only visible to the creator) -->
    {#if auth.parent?.toLowerCase() === event.creatorAddress.toLowerCase()}
      <div class="organizer-bar">
        <div class="organizer-bar-inner">
          <span class="organizer-label">You are the organizer</span>
          <button class="organizer-btn" onclick={ondashboard}>
            Dashboard →
          </button>
        </div>
      </div>
    {/if}

    <!-- Tickets -->
    <div class="tickets-section">
      <h2 class="tickets-heading">Tickets</h2>
      <div class="series-list">
        {#each event.series as s}
          <div class="series-card">
            <div class="series-info">
              <div class="series-name-row">
                <h3 class="series-name">{s.name}</h3>
                {#if s.wave}
                  <span class="wave-pill">{s.wave}</span>
                {/if}
              </div>
              {#if s.description}
                <p class="series-desc">{s.description}</p>
              {/if}
              <p class="series-supply">{s.totalSupply} tickets</p>
            </div>
            <div class="series-action">
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
          </div>
        {/each}
      </div>
    </div>

  {/if}
</div>

<style>
  .event-page {
    max-width: 640px;
    margin: 0 auto;
  }

  /* ── State (loading / error) ─────────────────────────────────────────────── */
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

  .state-text {
    color: var(--text-muted);
    font-size: 0.9375rem;
  }

  .state-error {
    color: var(--error);
    font-size: 0.9375rem;
    text-align: center;
  }

  /* ── Banner image ────────────────────────────────────────────────────────── */
  .banner-wrap {
    position: relative;
    width: 100%;
    height: 220px;
    border-radius: var(--radius-md);
    overflow: hidden;
    margin-bottom: 1.75rem;
  }

  .banner-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center;
    display: block;
  }

  /* Subtle gradient at the bottom so text below blends naturally */
  .banner-fade {
    position: absolute;
    inset: auto 0 0 0;
    height: 40%;
    background: linear-gradient(to bottom, transparent, var(--bg));
    pointer-events: none;
  }

  /* ── Event header ────────────────────────────────────────────────────────── */
  .event-header {
    margin-bottom: 1.75rem;
  }

  .event-title {
    font-size: 1.75rem;
    font-weight: 700;
    letter-spacing: -0.025em;
    color: var(--text);
    margin: 0 0 0.75rem;
    line-height: 1.2;
  }

  .meta-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem 1.25rem;
    margin-bottom: 1rem;
  }

  .meta-item {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.875rem;
    color: var(--text-secondary);
  }

  .meta-item svg {
    flex-shrink: 0;
    opacity: 0.6;
  }

  .meta-sep {
    color: var(--text-muted);
    margin: 0 0.1rem;
  }

  .event-desc {
    font-size: 0.9375rem;
    line-height: 1.7;
    color: var(--text-secondary);
    margin: 0;
    white-space: pre-wrap;
  }

  /* ── Organizer bar ───────────────────────────────────────────────────────── */
  .organizer-bar {
    margin-bottom: 1.75rem;
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--accent) 6%, transparent);
    padding: 0.75rem 1rem;
  }

  .organizer-bar-inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .organizer-label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--accent-text);
  }

  .organizer-btn {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--accent-text);
    padding: 0.375rem 0.75rem;
    border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
    border-radius: var(--radius-sm);
    transition: all var(--transition);
    white-space: nowrap;
  }

  .organizer-btn:hover {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }

  /* ── Tickets ─────────────────────────────────────────────────────────────── */
  .tickets-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .tickets-heading {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-muted);
    margin: 0 0 0.25rem;
  }

  .series-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .series-card {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    padding: 1rem 1.125rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    transition: border-color var(--transition);
  }

  .series-card:hover {
    border-color: var(--border-hover);
  }

  .series-info {
    min-width: 0;
  }

  .series-name-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-bottom: 0.125rem;
  }

  .series-name {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
    line-height: 1.3;
  }

  .wave-pill {
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.15rem 0.45rem;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--accent-text);
    white-space: nowrap;
  }

  .series-desc {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0.125rem 0 0.25rem;
    line-height: 1.4;
  }

  .series-supply {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin: 0;
  }

  .series-action {
    flex-shrink: 0;
  }

  @media (max-width: 480px) {
    .series-card {
      flex-direction: column;
      align-items: flex-start;
    }

    .series-action {
      width: 100%;
    }

    .banner-wrap {
      height: 160px;
    }

    .event-title {
      font-size: 1.375rem;
    }
  }
</style>
