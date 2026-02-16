<script lang="ts">
  import type { EventFeed } from "@woco/shared";
  import { getEvent } from "../../api/events.js";
  import ClaimButton from "./ClaimButton.svelte";
  import { navigate } from "../../router/router.svelte.js";
  import { onMount } from "svelte";

  interface Props {
    eventId: string;
    onback?: () => void;
  }

  let { eventId, onback }: Props = $props();

  let event = $state<EventFeed | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  const BEE_GATEWAY = "https://gateway.woco-net.com";

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

  onMount(async () => {
    try {
      event = await getEvent(eventId);
      if (!event) error = "Event not found";
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load event";
    } finally {
      loading = false;
    }
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

    {#if event.description}
      <p class="description">{event.description}</p>
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
          />
        </div>
      {/each}
    </div>

    <div class="embed-cta">
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

  .series-desc {
    color: var(--text-muted);
    font-size: 0.8125rem;
    margin: 0.125rem 0 0;
  }

  .embed-cta {
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
