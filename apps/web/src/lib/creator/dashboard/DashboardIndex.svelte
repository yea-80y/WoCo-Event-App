<script lang="ts">
  import type { EventDirectoryEntry } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { authPost } from "../../api/client.js";
  import { getMyEventsSWR } from "../../api/creator-cache.js";
  import { navigate } from "../../router/router.svelte.js";
  import { isPastEvent } from "../../utils/events.js";
  import { onMount, onDestroy } from "svelte";
  import StripeConnect from "./StripeConnect.svelte";

  type Tab = "upcoming" | "past";
  let tab = $state<Tab>("upcoming");

  // Single fetch — client-side split via reactive clock
  let allEvents = $state<EventDirectoryEntry[]>([]);
  let loading = $state(true);
  let now = $state(Date.now());
  let clockTimer: ReturnType<typeof setInterval>;

  const upcoming = $derived(
    allEvents.filter(e => !isPastEvent(e, now))
      .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime())
  );
  const past = $derived(
    allEvents.filter(e => isPastEvent(e, now))
      .sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime())
  );

  // ── External server discovery ───────────────────────────────────────────────
  interface DiscoveredEvent extends EventDirectoryEntry {
    listed: boolean;
    sourceApiUrl: string;
  }

  let discoverApiUrl = $state("");
  let discovering = $state(false);
  let discoverError = $state<string | null>(null);
  let discovered = $state<DiscoveredEvent[]>([]);
  let listingId = $state<string | null>(null);

  async function handleDiscover() {
    const url = discoverApiUrl.trim();
    if (!url) return;
    discovering = true;
    discoverError = null;
    discovered = [];
    try {
      const json = await authPost<DiscoveredEvent[]>("/api/events/discover", { sourceApiUrl: url });
      if (json.ok && json.data) {
        discovered = json.data;
        if (discovered.length === 0) discoverError = "No events found for your address on that server.";
      } else {
        discoverError = json.error || "Discovery failed";
      }
    } catch (e) {
      discoverError = e instanceof Error ? e.message : "Discovery failed";
    } finally {
      discovering = false;
    }
  }

  async function handleList(ev: DiscoveredEvent) {
    listingId = ev.eventId;
    try {
      const json = await authPost<{ eventId: string }>(`/api/events/${ev.eventId}/list`, { sourceApiUrl: ev.sourceApiUrl });
      if (json.ok) {
        const idx = discovered.findIndex(d => d.eventId === ev.eventId);
        if (idx !== -1) discovered[idx] = { ...discovered[idx], listed: true };
      } else {
        discoverError = json.error || "Failed to list event";
      }
    } catch (e) {
      discoverError = e instanceof Error ? e.message : "Failed to list event";
    } finally {
      listingId = null;
    }
  }

  async function handleUnlist(ev: DiscoveredEvent) {
    listingId = ev.eventId;
    try {
      const json = await authPost<{ eventId: string }>(`/api/events/${ev.eventId}/unlist`, { sourceApiUrl: ev.sourceApiUrl });
      if (json.ok) {
        const idx = discovered.findIndex(d => d.eventId === ev.eventId);
        if (idx !== -1) discovered[idx] = { ...discovered[idx], listed: false };
      } else {
        discoverError = json.error || "Failed to unlist event";
      }
    } catch (e) {
      discoverError = e instanceof Error ? e.message : "Failed to unlist event";
    } finally {
      listingId = null;
    }
  }

  onMount(async () => {
    clockTimer = setInterval(() => { now = Date.now(); }, 60_000);
    if (!auth.isConnected || !auth.parent) { loading = false; return; }
    const addr = auth.parent.toLowerCase();

    // Gate cached paint on a verified session: per-address localStorage must
    // not flash on screen during sign-in before EIP-712 is signed.
    if (!auth.hasSession) {
      const ok = await auth.ensureSession();
      if (!ok) { loading = false; return; }
    }

    const swr = getMyEventsSWR(addr);
    if (swr.cached) {
      allEvents = swr.cached;
      loading = false;
    }
    const fresh = await swr.refresh();
    // Don't overwrite a populated cached view with an unexpected empty response.
    if (fresh && (fresh.length > 0 || !swr.cached)) allEvents = fresh;
    loading = false;
  });

  onDestroy(() => clearInterval(clockTimer));
</script>

<div class="dash-index">
  <span class="kicker">Creator Studio</span>
  <h1>My Events</h1>

  {#if !auth.isConnected}
    <p class="status">Sign in to view your events.</p>
  {:else}
    <div class="tabs">
      <button class="tab" class:active={tab === "upcoming"} onclick={() => tab = "upcoming"}>
        Upcoming
        {#if !loading && upcoming.length > 0}
          <span class="tab-count">{upcoming.length}</span>
        {/if}
      </button>
      <button class="tab" class:active={tab === "past"} onclick={() => tab = "past"}>
        Past
        {#if !loading && past.length > 0}
          <span class="tab-count">{past.length}</span>
        {/if}
      </button>
    </div>

    {#if loading}
      <p class="status">Loading...</p>
    {:else if tab === "upcoming"}
      {#if upcoming.length === 0}
        <div class="empty">
          <p>No upcoming events.</p>
          <button class="create-btn" onclick={() => navigate("/creator/events/new")}>
            Create an event
          </button>
        </div>
      {:else}
        <div class="event-list">
          {#each upcoming as ev}
            <button class="event-row" onclick={() => navigate(`/event/${ev.eventId}/dashboard`)}>
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
    {:else}
      {#if past.length === 0}
        <div class="empty">
          <p>No past events.</p>
        </div>
      {:else}
        <div class="event-list">
          {#each past as ev}
            <button class="event-row event-row--past" onclick={() => navigate(`/event/${ev.eventId}/dashboard`)}>
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
    {/if}

    <div class="stripe-section">
      <div class="section-divider"></div>
      <StripeConnect />
    </div>

    <div class="discover-section">
      <div class="section-divider"></div>
      <span class="kicker">External Server</span>
      <h2 class="section-heading">Events from my own server</h2>
      <p class="section-desc">
        Running your own self-hosted WoCo backend? Enter your API URL to see your events and
        choose which ones to list on the WoCo public directory.
      </p>

      <div class="discover-row">
        <input
          class="discover-input"
          type="url"
          bind:value={discoverApiUrl}
          placeholder="https://events.myserver.com"
        />
        <button
          class="discover-btn"
          onclick={handleDiscover}
          disabled={discovering || !discoverApiUrl.trim()}
        >
          {discovering ? "Searching…" : "Find my events"}
        </button>
      </div>

      {#if discoverError && discovered.length === 0}
        <p class="discover-error">{discoverError}</p>
      {/if}

      {#if discovered.length > 0}
        <div class="discovered-list">
          {#each discovered as ev}
            {@const busy = listingId === ev.eventId}
            <div class="discovered-row">
              <button
                class="discovered-info discovered-info--link"
                onclick={() => navigate(`/event/${ev.eventId}/dashboard`)}
                title="Open event dashboard"
              >
                <span class="discovered-title">{ev.title}</span>
                <span class="discovered-meta">
                  {new Date(ev.startDate).toLocaleDateString()} &middot;
                  {ev.totalTickets} ticket{ev.totalTickets !== 1 ? "s" : ""}
                </span>
              </button>
              <div class="discovered-actions">
                {#if ev.listed}
                  <span class="listed-badge">Listed on WoCo</span>
                  <button class="toggle-btn toggle-btn--unlist" onclick={() => handleUnlist(ev)} disabled={busy}>
                    {busy ? "…" : "Unlist"}
                  </button>
                {:else}
                  <button class="toggle-btn toggle-btn--list" onclick={() => handleList(ev)} disabled={busy}>
                    {busy ? "…" : "List on WoCo"}
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        </div>

        {#if discoverError}
          <p class="discover-error" style="margin-top:0.75rem">{discoverError}</p>
        {/if}
      {/if}
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
    margin: 0.375rem 0 1.25rem;
    font-size: 1.5rem;
    font-weight: 700;
  }

  .status {
    text-align: center;
    color: var(--text-muted);
    padding: 3rem 0;
  }

  .tabs {
    display: flex;
    border-bottom: 1px solid var(--border);
    margin-bottom: 1.25rem;
  }

  .tab {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.625rem 1.25rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: all var(--transition);
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .tab:hover { color: var(--text); }

  .tab-count {
    font-size: 0.625rem;
    font-weight: 700;
    padding: 0.0625rem 0.375rem;
    border-radius: var(--radius-sm);
    background: var(--accent-subtle);
    color: var(--accent-text);
    font-variant-numeric: tabular-nums;
  }

  .tab.active {
    color: var(--accent-text);
    border-bottom-color: var(--accent);
  }

  .empty {
    text-align: center;
    padding: 3rem 1rem;
    color: var(--text-muted);
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
  }

  .empty p { margin: 0 0 1rem; }

  .create-btn {
    padding: 0.5rem 1.25rem;
    font-size: 0.875rem;
    font-weight: 500;
    background: var(--accent);
    color: var(--accent-ink);
    border-radius: var(--radius-sm);
    transition: background var(--transition);
  }

  .create-btn:hover { background: var(--accent-hover); }

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

  .event-row:hover { border-color: var(--accent); }
  .event-row--past { opacity: 0.65; }
  .event-row--past:hover { opacity: 0.9; }

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
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    color: var(--text-muted);
    letter-spacing: 0.02em;
  }

  .arrow { color: var(--text-muted); font-size: 1rem; }

  /* ── Stripe + Discovery sections ────────────────────────────────────────── */
  .stripe-section,
  .discover-section { margin-top: 2.5rem; }

  .section-divider {
    border-top: 1px solid var(--border);
    margin-bottom: 2rem;
  }

  .section-heading {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text);
    margin: 0 0 0.375rem;
  }

  .section-desc {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0 0 1.125rem;
    line-height: 1.5;
  }

  .discover-row {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .discover-input {
    flex: 1;
    min-width: 0;
    padding: 0.5rem 0.75rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 0.875rem;
    font-family: inherit;
    transition: border-color var(--transition);
  }

  .discover-input:focus { outline: none; border-color: var(--accent); }

  .discover-btn {
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    border: 1px solid var(--accent);
    color: var(--accent-text);
    border-radius: var(--radius-sm);
    white-space: nowrap;
    flex-shrink: 0;
    transition: all var(--transition);
  }

  .discover-btn:hover:not(:disabled) { background: var(--accent); color: var(--accent-ink); }
  .discover-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .discover-error { font-size: 0.8125rem; color: var(--error); margin: 0; }

  .discovered-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }

  .discovered-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.875rem 1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
  }

  .discovered-info {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }

  .discovered-info--link {
    cursor: pointer;
    text-align: left;
    flex: 1;
    padding: 0;
    background: none;
    border: none;
    border-radius: 0;
    transition: none;
  }

  .discovered-info--link:hover .discovered-title { color: var(--accent); }

  .discovered-title {
    font-size: 0.9375rem;
    font-weight: 500;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .discovered-meta {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    color: var(--text-muted);
    letter-spacing: 0.02em;
  }

  .discovered-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .listed-badge {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 500;
    padding: 0.125rem 0.5rem;
    border-radius: var(--radius-sm);
    background: var(--accent-subtle);
    color: var(--accent-text);
    white-space: nowrap;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .toggle-btn {
    font-size: 0.75rem;
    font-weight: 500;
    padding: 0.3rem 0.7rem;
    border-radius: var(--radius-sm);
    white-space: nowrap;
    transition: all var(--transition);
  }

  .toggle-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .toggle-btn--list { border: 1px solid var(--accent); color: var(--accent-text); }
  .toggle-btn--list:hover:not(:disabled) { background: var(--accent); color: var(--accent-ink); }
  .toggle-btn--unlist { border: 1px solid var(--border); color: var(--text-muted); }
  .toggle-btn--unlist:hover:not(:disabled) { border-color: var(--error); color: var(--error); }

  @media (max-width: 480px) {
    .discover-row { flex-direction: column; }
    .discovered-row { flex-wrap: wrap; }
    .discovered-actions { width: 100%; justify-content: flex-end; }
  }
</style>
