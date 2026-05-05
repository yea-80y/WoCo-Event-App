<script lang="ts">
  import type { SiteEventEntry, EventDirectoryEntry } from "@woco/shared";
  import { authGet } from "../../../api/client.js";
  import { onMount } from "svelte";

  interface Props {
    siteId: string;
    siteEvents: SiteEventEntry[];
    onsiteeventschange: (events: SiteEventEntry[]) => void;
  }

  let { siteId, siteEvents, onsiteeventschange }: Props = $props();

  type LoadState = "loading" | "ready" | "unauth" | "error";

  let state = $state<LoadState>("loading");
  let stateError = $state("");
  let myEvents = $state<EventDirectoryEntry[]>([]);

  // Derive which eventIds are currently in the site
  let inSite = $derived(new Set(siteEvents.map((e) => e.eventId)));
  let featured = $derived(new Set(siteEvents.filter((e) => e.featured).map((e) => e.eventId)));

  async function loadEvents() {
    state = "loading";
    stateError = "";
    try {
      const res = await authGet<EventDirectoryEntry[]>("/api/events/mine");
      if (!res.ok) {
        const msg = res.error ?? "Server error";
        console.error("[EventsTab] /api/events/mine failed:", msg);
        // 401/403-style errors → prompt sign-in; server errors → show error
        state = msg.toLowerCase().includes("auth") || msg.toLowerCase().includes("session")
          ? "unauth"
          : "error";
        stateError = msg;
        return;
      }
      const seen = new Set<string>();
      myEvents = (res.data ?? [])
        .filter(e => { if (seen.has(e.eventId)) return false; seen.add(e.eventId); return true; })
        .sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
      state = "ready";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[EventsTab] authGet threw:", msg);
      state = msg === "Not authenticated" ? "unauth" : "error";
      stateError = msg;
    }
  }

  onMount(loadEvents);

  function toggleEvent(eventId: string) {
    if (inSite.has(eventId)) {
      onsiteeventschange(siteEvents.filter((e) => e.eventId !== eventId));
    } else {
      onsiteeventschange([
        ...siteEvents,
        { eventId, featured: false, addedAt: Date.now() },
      ]);
    }
  }

  function toggleFeatured(eventId: string) {
    onsiteeventschange(
      siteEvents.map((e) =>
        e.eventId === eventId ? { ...e, featured: !e.featured } : e
      )
    );
  }

  function formatDate(iso: string): string {
    try {
      return new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  }

  function isPast(iso: string): boolean {
    return new Date(iso).getTime() < Date.now();
  }
</script>

<div class="events-tab">
  <div class="tab-header">
    <div class="header-text">
      <h2 class="tab-title">Site Events</h2>
      <p class="tab-desc">
        Choose which of your events appear on this site. Toggle <span class="star-inline">★</span> to feature an event
        in <code>featuredEvent</code> sections and <code>eventsGrid mode: featured</code>.
      </p>
    </div>
    <div class="count-pill">
      {inSite.size} selected
    </div>
  </div>

  {#if state === "loading"}
    <div class="state-box">
      <div class="spinner"></div>
      <p>Loading your events…</p>
    </div>

  {:else if state === "unauth"}
    <div class="state-box warn">
      <span class="state-icon">🔒</span>
      <p>Sign in to see your events and manage this site's event list.</p>
    </div>

  {:else if state === "error"}
    <div class="state-box warn">
      <span class="state-icon">⚠</span>
      <p>Failed to load events: {stateError}</p>
      <button class="retry-btn" onclick={loadEvents}>Retry</button>
    </div>

  {:else if myEvents.length === 0}
    <div class="state-box empty">
      <span class="state-icon">📅</span>
      <p class="state-title">No events yet</p>
      <p class="state-sub">Create an event from your dashboard, then come back to add it to this site.</p>
    </div>

  {:else}
    <ul class="event-list">
      {#each myEvents as ev (ev.eventId)}
        {@const active = inSite.has(ev.eventId)}
        {@const isFeatured = featured.has(ev.eventId)}
        {@const past = isPast(ev.startDate)}
        <li class="event-row" class:active class:past>
          <div class="event-row-left">
            <button
              class="toggle-btn"
              class:on={active}
              onclick={() => toggleEvent(ev.eventId)}
              title={active ? "Remove from site" : "Add to site"}
              aria-label={active ? "Remove from site" : "Add to site"}
            >
              {#if active}
                <span class="check">✓</span>
              {:else}
                <span class="plus">+</span>
              {/if}
            </button>

            <div class="event-info">
              <span class="event-title">{ev.title}</span>
              <span class="event-meta">
                {formatDate(ev.startDate)}
                {#if ev.location} · {ev.location}{/if}
                {#if past}<span class="past-badge">Past</span>{/if}
              </span>
            </div>
          </div>

          {#if active}
            <button
              class="featured-btn"
              class:starred={isFeatured}
              onclick={() => toggleFeatured(ev.eventId)}
              title={isFeatured ? "Unmark as featured" : "Mark as featured"}
              aria-label={isFeatured ? "Unmark as featured" : "Mark as featured"}
            >
              ★
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if inSite.size > 0}
    <div class="selection-summary">
      <span class="summary-label">Selected ({inSite.size})</span>
      <div class="selected-chips">
        {#each siteEvents as entry}
          {@const ev = myEvents.find((e) => e.eventId === entry.eventId)}
          {#if ev}
            <span class="chip" class:featured={entry.featured}>
              {#if entry.featured}<span class="chip-star">★</span>{/if}
              {ev.title}
              <button
                class="chip-remove"
                onclick={() => toggleEvent(entry.eventId)}
                aria-label="Remove"
              >×</button>
            </span>
          {/if}
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .events-tab {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  /* ── Header ───────────────────────────────────────────────────────── */
  .tab-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }

  .header-text {
    flex: 1;
  }

  .tab-title {
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--text);
    margin: 0 0 0.375rem;
  }

  .tab-desc {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }

  .tab-desc code {
    font-size: 0.75rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0.1em 0.35em;
    color: var(--text-secondary);
  }

  .star-inline {
    color: #f59e0b;
  }

  .count-pill {
    flex-shrink: 0;
    padding: 0.25rem 0.75rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 9999px;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-muted);
    white-space: nowrap;
  }

  /* ── State boxes ──────────────────────────────────────────────────── */
  .state-box {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.625rem;
    padding: 3rem 2rem;
    background: var(--bg-surface);
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    text-align: center;
  }

  .state-box p {
    margin: 0;
    font-size: 0.9rem;
    color: var(--text-muted);
  }

  .state-box.warn { border-color: #f59e0b33; }

  .retry-btn {
    margin-top: 0.5rem;
    padding: 0.375rem 1rem;
    font-size: 0.8125rem;
    font-weight: 600;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
    cursor: pointer;
  }
  .retry-btn:hover { border-color: var(--accent); color: var(--accent); }

  .state-icon {
    font-size: 2rem;
  }

  .state-title {
    font-size: 1rem !important;
    font-weight: 600;
    color: var(--text) !important;
  }

  .state-sub {
    font-size: 0.8125rem !important;
    opacity: 0.7;
  }

  /* Spinner */
  .spinner {
    width: 28px;
    height: 28px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* ── Event list ───────────────────────────────────────────────────── */
  .event-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .event-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.625rem 0.875rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    transition: border-color var(--transition), background var(--transition);
  }

  .event-row.active {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 5%, var(--bg-surface));
  }

  .event-row.past {
    opacity: 0.6;
  }

  .event-row-left {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
  }

  /* Toggle button */
  .toggle-btn {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    border: 2px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    font-size: 0.9rem;
    transition: all var(--transition);
    color: var(--text-muted);
  }

  .toggle-btn.on {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }

  .toggle-btn:hover:not(.on) {
    border-color: var(--accent);
    color: var(--accent);
  }

  .check { font-weight: 700; }
  .plus { font-weight: 300; font-size: 1.1rem; }

  /* Event info */
  .event-info {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }

  .event-title {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .event-meta {
    font-size: 0.75rem;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-wrap: wrap;
  }

  .past-badge {
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.1em 0.4em;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text-muted);
  }

  /* Featured star button */
  .featured-btn {
    font-size: 1.125rem;
    color: var(--border);
    transition: color var(--transition), transform var(--transition);
    padding: 0.25rem;
    flex-shrink: 0;
  }

  .featured-btn.starred {
    color: #f59e0b;
    transform: scale(1.15);
  }

  .featured-btn:hover:not(.starred) {
    color: #f59e0b88;
  }

  /* ── Summary chips ────────────────────────────────────────────────── */
  .selection-summary {
    padding: 1rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .summary-label {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }

  .selected-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem 0.25rem 0.625rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 9999px;
    font-size: 0.8125rem;
    color: var(--text);
  }

  .chip.featured {
    border-color: #f59e0b66;
    background: color-mix(in srgb, #f59e0b 8%, var(--bg));
  }

  .chip-star {
    color: #f59e0b;
    font-size: 0.75rem;
  }

  .chip-remove {
    font-size: 0.875rem;
    color: var(--text-muted);
    padding: 0 0.125rem;
    line-height: 1;
    transition: color var(--transition);
  }

  .chip-remove:hover {
    color: var(--error, #ef4444);
  }
</style>
