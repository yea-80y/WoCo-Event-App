<script lang="ts">
  import type { FeaturedEventSection as FeaturedEventSectionType, EventFeed } from '@woco/shared';
  import { onMount } from 'svelte';
  import { cacheGet, cacheSet, cacheKey, TTL } from '../../cache/cache.js';

  interface Props {
    section: FeaturedEventSectionType;
    apiUrl: string;
    gatewayUrl: string;
  }

  let { section, apiUrl, gatewayUrl }: Props = $props();

  type LoadState = 'loading' | 'ready' | 'error' | 'notfound';
  let loadState = $state<LoadState>('loading');
  let event = $state<EventFeed | null>(null);

  onMount(async () => {
    const ck = cacheKey.event(section.eventId);
    const cached = cacheGet<EventFeed>(ck);

    if (cached) {
      event = cached;
      loadState = 'ready';
      // Revalidate silently in background.
      fetch(`${apiUrl}/api/events/${section.eventId}`)
        .then((r) => r.json() as Promise<{ ok: boolean; data?: EventFeed }>)
        .then((json) => { if (json.ok && json.data) { cacheSet(ck, json.data, TTL.EVENT); event = json.data; } })
        .catch(() => {});
      return;
    }

    try {
      const resp = await fetch(`${apiUrl}/api/events/${section.eventId}`);
      const json = await resp.json() as { ok: boolean; data?: EventFeed };
      if (!json.ok || !json.data) { loadState = 'notfound'; return; }
      cacheSet(ck, json.data, TTL.EVENT);
      event = json.data;
      loadState = 'ready';
    } catch {
      loadState = 'error';
    }
  });

  function formatDate(iso: string): string {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }).format(new Date(iso));
    } catch { return iso; }
  }

  function formatTime(iso: string): string {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(iso));
    } catch { return ''; }
  }

  function priceLabel(ev: EventFeed): string {
    if (!ev.series?.length) return '';
    const s = ev.series[0];
    if (!s.payment || s.price === 0) return 'Free entry';
    const sym: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };
    return `From ${sym[s.payment.currency] ?? ''}${s.payment.price}`;
  }

  function imageUrl(ev: EventFeed): string | undefined {
    if (!ev.imageHash || /^0+$/.test(ev.imageHash)) return undefined;
    const gw = (typeof window !== 'undefined' && window.SITE_CONFIG?.gatewayUrl) || gatewayUrl || 'https://gateway.ethswarm.org';
    return `${gw}/bzz/${ev.imageHash}`;
  }
</script>

<section class="featured-section">
  {#if loadState === 'loading'}
    <div class="skeleton">
      <div class="skeleton-img"></div>
      <div class="skeleton-body">
        <div class="skeleton-line wide"></div>
        <div class="skeleton-line narrow"></div>
        <div class="skeleton-line medium"></div>
      </div>
    </div>

  {:else if loadState === 'error' || loadState === 'notfound'}
    <div class="inner">
      <p class="notice">
        {loadState === 'notfound' ? 'Featured event not found.' : 'Could not load event.'}
      </p>
    </div>

  {:else if event}
    {@const img = imageUrl(event)}
    <div class="featured-card" class:has-image={!!img}>
      {#if img}
        <div class="featured-image-wrap">
          <img class="featured-image" src={img} alt={event.title} />
          <div class="image-overlay" aria-hidden="true"></div>
        </div>
      {/if}

      <div class="featured-body" class:no-image={!img}>
        <div class="featured-meta">
          <span class="featured-label">Featured Event</span>
          <span class="featured-date">
            {formatDate(event.startDate)} · {formatTime(event.startDate)}
          </span>
        </div>

        <h2 class="featured-title">{event.title}</h2>

        {#if event.description}
          <p class="featured-desc">{event.description}</p>
        {/if}

        <div class="featured-footer">
          {#if event.location}
            <span class="featured-location">📍 {event.location}</span>
          {/if}
          <div class="featured-actions">
            <span class="featured-price">{priceLabel(event)}</span>
            <a
              class="featured-cta"
              href={'#/events/' + event.eventId}
              aria-label="Get tickets for {event.title}"
            >Get Tickets →</a>
          </div>
        </div>
      </div>
    </div>
  {/if}
</section>

<style>
  .featured-section {
    padding: 2.5rem 1.5rem;
  }

  .inner {
    max-width: 900px;
    margin: 0 auto;
  }

  /* ── Featured card ─────────────────────────────────────────────────── */
  .featured-card {
    max-width: 900px;
    margin: 0 auto;
    border-radius: var(--radius-lg);
    overflow: hidden;
    border: 1px solid var(--border);
    background: var(--card-bg);
    position: relative;
  }

  .featured-card.has-image {
    min-height: 340px;
    display: grid;
    grid-template-rows: 1fr;
  }

  /* Image */
  .featured-image-wrap {
    position: relative;
    height: 320px;
    overflow: hidden;
  }

  .featured-image {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .image-overlay {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      to bottom,
      transparent 30%,
      rgba(0,0,0,0.6) 100%
    );
  }

  /* Body */
  .featured-body {
    padding: 1.5rem 1.75rem 1.75rem;
  }

  .featured-body.no-image {
    padding-top: 2rem;
  }

  .has-image .featured-body {
    position: relative;
  }

  /* Meta line */
  .featured-meta {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-bottom: 0.625rem;
  }

  .featured-label {
    font-size: 0.6875rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 0.2em 0.6em;
    background: var(--accent);
    color: #fff;
    border-radius: 3px;
  }

  .featured-date {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* Title */
  .featured-title {
    font-size: clamp(1.5rem, 3vw, 2.25rem);
    font-weight: 800;
    color: var(--text);
    line-height: 1.15;
    margin: 0 0 0.75rem;
  }

  /* Description */
  .featured-desc {
    font-size: 0.9375rem;
    color: var(--muted);
    line-height: 1.6;
    margin: 0 0 1.25rem;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* Footer */
  .featured-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.75rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
  }

  .featured-location {
    font-size: 0.875rem;
    color: var(--muted);
  }

  .featured-actions {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .featured-price {
    font-size: 1rem;
    font-weight: 700;
    color: var(--text);
  }

  .featured-cta {
    padding: 0.5625rem 1.25rem;
    background: var(--accent);
    color: #fff;
    border-radius: var(--radius-sm);
    font-size: 0.9375rem;
    font-weight: 700;
    transition: background 150ms ease;
    text-decoration: none;
    white-space: nowrap;
  }

  .featured-cta:hover {
    background: var(--accent-hover);
    text-decoration: none;
  }

  /* ── Notice ────────────────────────────────────────────────────────── */
  .notice {
    text-align: center;
    padding: 3rem 0;
    color: var(--muted);
    font-size: 0.9375rem;
    margin: 0;
  }

  /* ── Skeleton ──────────────────────────────────────────────────────── */
  .skeleton {
    max-width: 900px;
    margin: 0 auto;
    border-radius: var(--radius-lg);
    overflow: hidden;
    border: 1px solid var(--border);
  }

  .skeleton-img {
    height: 280px;
    background: linear-gradient(
      90deg,
      var(--bg-surface) 25%,
      color-mix(in srgb, var(--border) 60%, var(--bg-surface)) 50%,
      var(--bg-surface) 75%
    );
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
  }

  .skeleton-body {
    padding: 1.5rem 1.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .skeleton-line {
    height: 1rem;
    border-radius: 4px;
    background: linear-gradient(
      90deg,
      var(--bg-surface) 25%,
      color-mix(in srgb, var(--border) 60%, var(--bg-surface)) 50%,
      var(--bg-surface) 75%
    );
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
  }

  .skeleton-line.wide { width: 60%; height: 1.5rem; }
  .skeleton-line.medium { width: 45%; }
  .skeleton-line.narrow { width: 28%; }

  @keyframes shimmer {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
</style>
