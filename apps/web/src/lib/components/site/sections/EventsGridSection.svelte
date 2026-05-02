<script lang="ts">
  import type { EventsGridSection as EventsGridSectionType, Site, SiteEventsIndex, EventFeed } from '@woco/shared';
  import { onMount } from 'svelte';

  interface Props {
    section: EventsGridSectionType;
    site: Site;
    apiUrl: string;
  }

  let { section, site, apiUrl }: Props = $props();

  type LoadState = 'loading' | 'ready' | 'empty' | 'error';

  let loadState = $state<LoadState>('loading');
  let events = $state<EventFeed[]>([]);

  onMount(async () => {
    try {
      // 1. Fetch the site events index
      const idxResp = await fetch(`${apiUrl}/api/sites/${site.siteId}/events`);
      const idxJson = await idxResp.json() as { ok: boolean; data?: SiteEventsIndex };

      if (!idxJson.ok || !idxJson.data || idxJson.data.events.length === 0) {
        loadState = 'empty';
        return;
      }

      const index = idxJson.data;

      // 2. Filter entries by section mode
      const now = Date.now();
      let entries = index.events;
      if (section.mode === 'featured') {
        entries = entries.filter((e) => e.featured);
      }

      // 3. Cap by max
      if (section.max && section.max > 0) {
        entries = entries.slice(0, section.max);
      }

      // 4. Fetch event details in parallel
      const results = await Promise.allSettled(
        entries.map((e) =>
          fetch(`${apiUrl}/api/events/${e.eventId}`).then((r) => r.json()) as Promise<{ ok: boolean; data?: EventFeed }>
        )
      );

      let loaded: EventFeed[] = results
        .filter((r): r is PromiseFulfilledResult<{ ok: boolean; data?: EventFeed }> =>
          r.status === 'fulfilled' && r.value.ok && !!r.value.data
        )
        .map((r) => r.value.data!);

      // 5. Filter upcoming events when mode is 'upcoming'
      if (section.mode === 'upcoming') {
        loaded = loaded.filter((ev) => new Date(ev.startDate).getTime() > now);
        loaded.sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
      }

      events = loaded;
      loadState = events.length === 0 ? 'empty' : 'ready';
    } catch {
      loadState = 'error';
    }
  });

  function formatDate(iso: string): string {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  }

  function formatTime(iso: string): string {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(iso));
    } catch {
      return '';
    }
  }

  function priceLabel(ev: EventFeed): string {
    if (!ev.series?.length) return '';
    const s = ev.series[0];
    if (!s.payment || s.price === 0) return 'Free';
    const sym: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };
    const currency = s.payment.currency;
    return `${sym[currency] ?? ''}${s.payment.price}`;
  }

  function gatewayImageUrl(imageHash: string | undefined): string | undefined {
    if (!imageHash || /^0+$/.test(imageHash)) return undefined;
    // Gateway URL comes from site runtime; fall back to known public gateway
    const gw = (typeof window !== 'undefined' && window.SITE_CONFIG?.gatewayUrl) || 'https://gateway.ethswarm.org';
    return `${gw}/bzz/${imageHash}`;
  }
</script>

<section class="events-grid-section">
  <div class="inner">
    {#if loadState === 'loading'}
      <div class="grid-placeholder">
        {#each Array(section.max ?? 3) as _, i}
          <div class="card-skeleton" style="animation-delay: {i * 0.1}s"></div>
        {/each}
      </div>

    {:else if loadState === 'error'}
      <p class="notice">Could not load events. Please try again.</p>

    {:else if loadState === 'empty'}
      <p class="notice">
        {section.mode === 'upcoming' ? 'No upcoming events right now.' : 'No events available.'}
      </p>

    {:else}
      <div class="events-grid">
        {#each events as ev (ev.eventId)}
          {@const imgUrl = gatewayImageUrl(ev.imageHash)}
          <article class="event-card">
            <div class="card-image" class:has-img={!!imgUrl}>
              {#if imgUrl}
                <img src={imgUrl} alt={ev.title} loading="lazy" />
              {:else}
                <div class="card-image-fallback" aria-hidden="true"></div>
              {/if}
            </div>
            <div class="card-body">
              <p class="card-date">{formatDate(ev.startDate)} · {formatTime(ev.startDate)}</p>
              <h3 class="card-title">{ev.title}</h3>
              {#if ev.location}
                <p class="card-location">
                  <span aria-hidden="true">📍</span> {ev.location}
                </p>
              {/if}
            </div>
            <div class="card-footer">
              <span class="card-price">{priceLabel(ev)}</span>
              <a
                class="card-cta"
                href={'#/events/' + ev.eventId}
                aria-label="Get tickets for {ev.title}"
              >Tickets →</a>
            </div>
          </article>
        {/each}
      </div>
    {/if}
  </div>
</section>

<style>
  .events-grid-section {
    padding: 3rem 1.5rem;
  }

  .inner {
    max-width: 1060px;
    margin: 0 auto;
  }

  /* ── Grid ──────────────────────────────────────────────────────────── */
  .events-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1.25rem;
  }

  /* ── Card ──────────────────────────────────────────────────────────── */
  .event-card {
    display: flex;
    flex-direction: column;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    transition: transform 200ms ease, box-shadow 200ms ease;
  }

  .event-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.18);
  }

  /* Card image */
  .card-image {
    height: 180px;
    overflow: hidden;
    background: var(--border);
  }

  .card-image img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .card-image-fallback {
    width: 100%;
    height: 100%;
    background: linear-gradient(
      135deg,
      color-mix(in srgb, var(--accent) 30%, transparent) 0%,
      color-mix(in srgb, var(--accent) 8%, transparent) 100%
    );
  }

  /* Card body */
  .card-body {
    flex: 1;
    padding: 1rem 1rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .card-date {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent);
    margin: 0;
  }

  .card-title {
    font-size: 1rem;
    font-weight: 700;
    color: var(--text);
    margin: 0;
    line-height: 1.3;
  }

  .card-location {
    font-size: 0.8125rem;
    color: var(--muted);
    margin: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Card footer */
  .card-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--border);
    gap: 0.5rem;
  }

  .card-price {
    font-size: 0.9375rem;
    font-weight: 700;
    color: var(--text);
  }

  .card-cta {
    padding: 0.375rem 0.875rem;
    background: var(--accent);
    color: #fff;
    border-radius: var(--radius-sm);
    font-size: 0.8125rem;
    font-weight: 600;
    transition: background 150ms ease;
    text-decoration: none;
    white-space: nowrap;
  }

  .card-cta:hover {
    background: var(--accent-hover);
    text-decoration: none;
  }

  /* ── Skeleton loader ───────────────────────────────────────────────── */
  .grid-placeholder {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1.25rem;
  }

  .card-skeleton {
    height: 320px;
    border-radius: var(--radius-md);
    background: linear-gradient(
      90deg,
      var(--bg-surface) 25%,
      color-mix(in srgb, var(--border) 60%, var(--bg-surface)) 50%,
      var(--bg-surface) 75%
    );
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
  }

  @keyframes shimmer {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  /* ── Notice (empty / error) ────────────────────────────────────────── */
  .notice {
    text-align: center;
    padding: 3rem 0;
    color: var(--muted);
    font-size: 0.9375rem;
    margin: 0;
  }
</style>
