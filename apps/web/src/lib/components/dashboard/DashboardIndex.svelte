<script lang="ts">
  import type { EventDirectoryEntry } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { listEvents } from "../../api/events.js";
  import { navigate } from "../../router/router.svelte.js";
  import { onMount } from "svelte";

  let events = $state<EventDirectoryEntry[]>([]);
  let loading = $state(true);

  onMount(async () => {
    try {
      if (!auth.isConnected || !auth.parent) {
        loading = false;
        return;
      }
      const all = await listEvents();
      events = all.filter(
        (e) => e.creatorAddress.toLowerCase() === auth.parent!.toLowerCase()
      );
    } catch {
      // ignore
    } finally {
      loading = false;
    }
  });
</script>

<div class="dash-index">
  <h1>My Events</h1>

  {#if loading}
    <p class="status">Loading...</p>
  {:else if !auth.isConnected}
    <p class="status">Sign in to view your events.</p>
  {:else if events.length === 0}
    <div class="empty">
      <p>You haven't created any events yet.</p>
      <button class="create-btn" onclick={() => navigate("/create")}>
        Create your first event
      </button>
    </div>
  {:else}
    <div class="event-list">
      {#each events as ev}
        <button
          class="event-row"
          onclick={() => navigate(`/event/${ev.eventId}/dashboard`)}
        >
          <div class="event-info">
            <span class="event-title">{ev.title}</span>
            <span class="event-meta">
              {new Date(ev.startDate).toLocaleDateString()} &middot;
              {ev.totalTickets} ticket{ev.totalTickets !== 1 ? "s" : ""}
            </span>
          </div>
          <span class="arrow">&rarr;</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .dash-index {
    max-width: 560px;
    margin: 0 auto;
  }

  h1 {
    color: var(--text);
    margin: 0 0 1.5rem;
    font-size: 1.5rem;
    font-weight: 700;
  }

  .status {
    text-align: center;
    color: var(--text-muted);
    padding: 3rem 0;
  }

  .empty {
    text-align: center;
    padding: 3rem 1rem;
    color: var(--text-muted);
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
  }

  .empty p {
    margin: 0 0 1rem;
  }

  .create-btn {
    padding: 0.5rem 1.25rem;
    font-size: 0.875rem;
    font-weight: 500;
    background: var(--accent);
    color: #fff;
    border-radius: var(--radius-sm);
    transition: background var(--transition);
  }

  .create-btn:hover {
    background: var(--accent-hover);
  }

  .event-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .event-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.125rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    text-align: left;
    width: 100%;
    transition: border-color var(--transition);
  }

  .event-row:hover {
    border-color: var(--accent);
  }

  .event-info {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .event-title {
    font-size: 0.9375rem;
    font-weight: 500;
    color: var(--text);
  }

  .event-meta {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .arrow {
    color: var(--text-muted);
    font-size: 1rem;
  }
</style>
