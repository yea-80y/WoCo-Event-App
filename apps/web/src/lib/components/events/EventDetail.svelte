<script lang="ts">
  import type { EventFeed } from "@woco/shared";
  import { getEvent } from "../../api/events.js";
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
  <button class="back-btn" onclick={onback}>&larr; Back</button>

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
      <p>{formatDate(event.startDate)} &mdash; {formatDate(event.endDate)}</p>
      {#if event.location}
        <p>{event.location}</p>
      {/if}
    </div>

    {#if event.description}
      <p class="description">{event.description}</p>
    {/if}

    <h2>Tickets</h2>
    <div class="series-list">
      {#each event.series as s}
        <div class="series-card">
          <h3>{s.name}</h3>
          {#if s.description}
            <p class="series-desc">{s.description}</p>
          {/if}
          <p class="supply">{s.totalSupply} available</p>
          <!-- Claim button will come in the claiming phase -->
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .event-detail {
    max-width: 640px;
    margin: 0 auto;
  }

  .back-btn {
    background: none;
    border: none;
    color: #818cf8;
    cursor: pointer;
    font-size: 0.875rem;
    padding: 0;
    margin-bottom: 1rem;
  }

  .back-btn:hover {
    text-decoration: underline;
  }

  .hero-image {
    width: 100%;
    max-height: 300px;
    object-fit: cover;
    border-radius: 10px;
    margin-bottom: 1rem;
  }

  h1 {
    color: #e2e8f0;
    margin: 0 0 0.5rem;
    font-size: 1.75rem;
  }

  .meta {
    color: #9ca3af;
    font-size: 0.875rem;
    margin-bottom: 1rem;
  }

  .meta p {
    margin: 0.125rem 0;
  }

  .description {
    color: #d1d5db;
    line-height: 1.6;
    margin-bottom: 1.5rem;
  }

  h2 {
    color: #e2e8f0;
    font-size: 1.25rem;
    margin: 0 0 0.75rem;
  }

  .series-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .series-card {
    border: 1px solid #2a2a4a;
    border-radius: 8px;
    padding: 1rem;
  }

  .series-card h3 {
    margin: 0;
    color: #e2e8f0;
    font-size: 1rem;
  }

  .series-desc {
    color: #9ca3af;
    font-size: 0.875rem;
    margin: 0.25rem 0;
  }

  .supply {
    color: #6b7280;
    font-size: 0.8125rem;
    margin: 0.25rem 0 0;
  }

  .status {
    text-align: center;
    color: #6b7280;
    padding: 2rem 0;
  }

  .error {
    text-align: center;
    color: #ef4444;
    padding: 2rem 0;
  }
</style>
