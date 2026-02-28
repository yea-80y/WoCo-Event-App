<script lang="ts">
  import type { EventDirectoryEntry } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { authPost, authGet } from "../../api/client.js";
  import { navigate } from "../../router/router.svelte.js";
  import { onMount } from "svelte";

  let events = $state<EventDirectoryEntry[]>([]);
  let loading = $state(true);

  // ── External server discovery ───────────────────────────────────────────────
  interface DiscoveredEvent extends EventDirectoryEntry {
    listed: boolean;
    sourceApiUrl: string;
  }

  let discoverApiUrl = $state("");
  let discovering = $state(false);
  let discoverError = $state<string | null>(null);
  let discovered = $state<DiscoveredEvent[]>([]);
  let listingId = $state<string | null>(null); // eventId being toggled

  async function handleDiscover() {
    const url = discoverApiUrl.trim();
    if (!url) return;
    discovering = true;
    discoverError = null;
    discovered = [];
    try {
      const json = await authPost<DiscoveredEvent[]>(
        "/api/events/discover",
        { sourceApiUrl: url }
      );
      if (json.ok && json.data) {
        discovered = json.data;
        if (discovered.length === 0) {
          discoverError = "No events found for your address on that server.";
        }
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
      const json = await authPost<{ eventId: string }>(
        `/api/events/${ev.eventId}/list`,
        { sourceApiUrl: ev.sourceApiUrl }
      );
      if (json.ok) {
        // Update in place
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
      const json = await authPost<{ eventId: string }>(
        `/api/events/${ev.eventId}/unlist`,
        { sourceApiUrl: ev.sourceApiUrl }
      );
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
    try {
      if (!auth.isConnected || !auth.parent) {
        loading = false;
        return;
      }
      const res = await authGet<EventDirectoryEntry[]>("/api/events/mine");
      if (res.ok && res.data) events = res.data;
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

  {#if auth.isConnected}
    <div class="discover-section">
      <div class="section-divider"></div>
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
                  <button
                    class="toggle-btn toggle-btn--unlist"
                    onclick={() => handleUnlist(ev)}
                    disabled={busy}
                  >
                    {busy ? "…" : "Unlist"}
                  </button>
                {:else}
                  <button
                    class="toggle-btn toggle-btn--list"
                    onclick={() => handleList(ev)}
                    disabled={busy}
                  >
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

  /* ── Discovery section ─────────────────────────────────────────────────── */
  .discover-section {
    margin-top: 2.5rem;
  }

  .section-divider {
    border-top: 1px solid var(--border);
    margin-bottom: 2rem;
  }

  .section-heading {
    font-size: 1rem;
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

  .discover-input:focus {
    outline: none;
    border-color: var(--accent);
  }

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

  .discover-btn:hover:not(:disabled) {
    background: var(--accent);
    color: #fff;
  }

  .discover-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .discover-error {
    font-size: 0.8125rem;
    color: var(--error);
    margin: 0;
  }

  /* ── Discovered events list ─────────────────────────────────────────────── */
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

  .discovered-info--link:hover .discovered-title {
    color: var(--accent);
  }

  .discovered-title {
    font-size: 0.9375rem;
    font-weight: 500;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .discovered-meta {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .discovered-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .listed-badge {
    font-size: 0.6875rem;
    font-weight: 500;
    padding: 0.2rem 0.5rem;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--success) 12%, transparent);
    color: var(--success);
    white-space: nowrap;
  }

  .toggle-btn {
    font-size: 0.75rem;
    font-weight: 500;
    padding: 0.3rem 0.7rem;
    border-radius: var(--radius-sm);
    white-space: nowrap;
    transition: all var(--transition);
  }

  .toggle-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .toggle-btn--list {
    border: 1px solid var(--accent);
    color: var(--accent-text);
  }

  .toggle-btn--list:hover:not(:disabled) {
    background: var(--accent);
    color: #fff;
  }

  .toggle-btn--unlist {
    border: 1px solid var(--border);
    color: var(--text-muted);
  }

  .toggle-btn--unlist:hover:not(:disabled) {
    border-color: var(--error);
    color: var(--error);
  }

  @media (max-width: 480px) {
    .discover-row { flex-direction: column; }
    .discovered-row { flex-wrap: wrap; }
    .discovered-actions { width: 100%; justify-content: flex-end; }
  }
</style>
