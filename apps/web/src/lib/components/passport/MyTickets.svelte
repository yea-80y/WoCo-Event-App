<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { getMyCollection, getTicketDetail } from "../../api/events.js";
  import type { ClaimedTicket, CollectionEntry } from "@woco/shared";
  import TicketCard from "./TicketCard.svelte";
  import { onMount } from "svelte";

  let loading = $state(true);
  let error = $state<string | null>(null);
  let tickets = $state<ClaimedTicket[]>([]);
  let authFailed = $state(false);

  onMount(() => {
    bootstrap();
  });

  async function bootstrap() {
    // Step 1: need to be connected
    if (!auth.isConnected) {
      const ok = await loginRequest.request();
      if (!ok) {
        loading = false;
        authFailed = true;
        return;
      }
    }

    // Step 2: need session delegation (triggers EIP-712 popup)
    if (!auth.hasSession) {
      const ok = await auth.ensureSession();
      if (!ok) {
        loading = false;
        error = "Session approval is required to view your tickets.";
        return;
      }
    }

    // Step 3: load tickets
    await loadTickets();
  }

  async function loadTickets() {
    loading = true;
    error = null;

    try {
      const collection = await getMyCollection();
      console.log("[MyTickets] collection:", JSON.stringify(collection));
      if (!collection.entries.length) {
        tickets = [];
        return;
      }
      const details = await Promise.all(
        collection.entries
          .filter((entry: CollectionEntry) => !!entry.claimedRef)
          .map((entry: CollectionEntry) =>
            getTicketDetail(entry.claimedRef).catch((e) => {
              console.warn("[MyTickets] ticket detail failed:", entry.claimedRef, e);
              return null;
            }),
          ),
      );
      tickets = details.filter((t): t is ClaimedTicket => t !== null);
    } catch (e) {
      console.error("[MyTickets] loadTickets error:", e);
      error = e instanceof Error ? e.message : "Failed to load tickets";
    } finally {
      loading = false;
    }
  }
</script>

<div class="passport">
  <h1>My Tickets</h1>

  {#if authFailed}
    <div class="empty-state">
      <p>Sign in to see your tickets.</p>
      <button class="retry-btn" onclick={bootstrap}>Sign in</button>
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

  .retry-btn {
    margin-top: 0.75rem;
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    transition: all var(--transition);
  }

  .retry-btn:hover {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
</style>
