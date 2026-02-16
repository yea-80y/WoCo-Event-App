<script lang="ts">
  import { onMount } from "svelte";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { getMyCollection, getTicketDetail } from "../../api/events.js";
  import type { ClaimedTicket, CollectionEntry } from "@woco/shared";
  import TicketCard from "./TicketCard.svelte";

  let loading = $state(true);
  let error = $state<string | null>(null);
  let tickets = $state<ClaimedTicket[]>([]);

  onMount(async () => {
    if (!auth.isAuthenticated) {
      loading = false;
      return;
    }

    try {
      const collection = await getMyCollection();
      // Fetch ticket details in parallel
      const details = await Promise.all(
        collection.entries.map((entry: CollectionEntry) =>
          getTicketDetail(entry.claimedRef).catch(() => null),
        ),
      );
      tickets = details.filter((t): t is ClaimedTicket => t !== null);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load tickets";
    } finally {
      loading = false;
    }
  });
</script>

<div class="passport">
  <h1>My Tickets</h1>

  {#if !auth.isAuthenticated}
    <div class="empty-state">
      <p>Connect your wallet to see your tickets.</p>
    </div>
  {:else if loading}
    <div class="loading-state">
      <p>Loading your collection...</p>
    </div>
  {:else if error}
    <div class="error-state">
      <p>{error}</p>
    </div>
  {:else if tickets.length === 0}
    <div class="empty-state">
      <p>No tickets yet. Browse events and claim your first ticket!</p>
    </div>
  {:else}
    <div class="ticket-grid">
      {#each tickets as ticket (ticket.originalPodHash)}
        <TicketCard {ticket} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .passport {
    max-width: 640px;
  }

  h1 {
    font-size: 1.5rem;
    font-weight: 700;
    margin: 0 0 1.5rem;
    color: var(--text);
  }

  .ticket-grid {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .empty-state,
  .loading-state,
  .error-state {
    padding: 3rem 1.5rem;
    text-align: center;
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
  }

  .empty-state p,
  .loading-state p {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.9375rem;
  }

  .error-state p {
    margin: 0;
    color: var(--error);
    font-size: 0.9375rem;
  }
</style>
