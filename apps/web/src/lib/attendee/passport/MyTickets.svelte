<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";
  import { getMyCollection, getTicketDetail } from "../../api/events.js";
  import type { ClaimedTicket, CollectionEntry } from "@woco/shared";
  import TicketCard from "./TicketCard.svelte";
  import { cacheGet, cacheSet, cacheKey, TTL } from "../../cache/cache.js";
  import { onMount } from "svelte";

  // No pre-session cache display: we only show cached tickets after the session
  // is verified. This prevents stale data flashing on screen while the EIP-712
  // prompt is pending — which looks confusing and phishing-adjacent.
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

    // Step 2: need session delegation (triggers EIP-712 popup if needed)
    if (!auth.hasSession) {
      const ok = await auth.ensureSession();
      if (!ok) {
        loading = false;
        error = "Session approval is required to view your tickets.";
        return;
      }
    }

    // Step 3: show cached tickets instantly, then background-refresh
    await loadTickets();
  }

  async function loadTickets() {
    const addr = auth.parent;
    if (!addr) return;

    const colKey = cacheKey.collection(addr);

    // Show cached tickets immediately — eliminates loading state on return visits
    const cachedTickets = cacheGet<ClaimedTicket[]>(colKey);
    if (cachedTickets) {
      tickets = cachedTickets;
      loading = false;
    }

    // Always fetch fresh from Swarm in the background
    try {
      const collection = await getMyCollection();

      if (!collection.entries.length) {
        tickets = [];
        cacheSet(colKey, [], TTL.COLLECTION);
        loading = false;
        return;
      }

      // Fetch individual ticket details — use permanent cache for each POD
      const details = await Promise.all(
        collection.entries
          .filter((entry: CollectionEntry) => !!entry.claimedRef)
          .map((entry: CollectionEntry) => {
            const ticketKey = cacheKey.ticket(entry.claimedRef);
            const cachedTicket = cacheGet<ClaimedTicket>(ticketKey);
            if (cachedTicket) return Promise.resolve(cachedTicket);
            // Not cached — fetch and store permanently (PODs are immutable)
            return getTicketDetail(entry.claimedRef)
              .then((t) => {
                if (t) cacheSet(ticketKey, t, TTL.PERMANENT);
                return t;
              })
              .catch((e) => {
                console.warn("[MyTickets] ticket detail failed:", entry.claimedRef, e);
                return null;
              });
          }),
      );

      const freshTickets = details.filter((t): t is ClaimedTicket => t !== null);
      // Persist the full resolved list so next visit is instant
      cacheSet(colKey, freshTickets, TTL.COLLECTION);
      tickets = freshTickets;
    } catch (e) {
      console.error("[MyTickets] loadTickets error:", e);
      // Only show error if we have nothing cached to fall back on
      if (!cachedTickets) {
        error = e instanceof Error ? e.message : "Failed to load tickets";
      }
    } finally {
      loading = false;
    }
  }

</script>

<div class="passport">
  <span class="kicker">Passport</span>
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
    margin: 0.375rem 0 1.5rem;
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
    color: var(--accent-ink);
  }
</style>
