<script lang="ts">
  import type { SiteEventEntry, EventDirectoryEntry } from "@woco/shared";
  import { addSiteEvent, removeSiteEvent, getSiteEvents } from "../../api/sites.js";
  import { getMyEventsSWR } from "../../api/creator-cache.js";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { navigate } from "../../router/router.svelte.js";
  import { onMount } from "svelte";

  interface Props { siteId: string; }
  let { siteId }: Props = $props();

  type LoadState = "loading" | "ready" | "error";

  let loadState = $state<LoadState>("loading");
  let myEvents = $state<EventDirectoryEntry[]>([]);
  let siteEvents = $state<SiteEventEntry[]>([]);
  let pendingIds = $state(new Set<string>());
  let errors = $state<Record<string, string>>({});

  const inSite = $derived(new Set(siteEvents.map(e => e.eventId)));

  function formatDate(iso: string): string {
    try {
      return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
    } catch { return iso; }
  }

  function isPast(iso: string) { return new Date(iso).getTime() < Date.now(); }

  async function loadAll() {
    if (!auth.isConnected || !auth.parent) { loadState = "error"; return; }

    // EIP-712 must be signed before any per-address creator event list is
    // rendered — cache contents are user-private even though the key is
    // scoped to the address.
    if (!auth.hasSession) {
      const ok = await auth.ensureSession();
      if (!ok) { loadState = "error"; return; }
    }

    loadState = "loading";
    const addr = auth.parent.toLowerCase();
    const [evIdx, swr] = await Promise.allSettled([
      getSiteEvents(siteId),
      Promise.resolve(getMyEventsSWR(addr)),
    ]);

    if (evIdx.status === "fulfilled" && evIdx.value.ok && evIdx.value.data) {
      siteEvents = evIdx.value.data.events;
    }

    const siteEventsReady = evIdx.status === "fulfilled";

    if (swr.status === "fulfilled") {
      const cached = swr.value.cached;
      if (cached) {
        myEvents = [...cached].sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
        if (siteEventsReady) loadState = "ready";
      }
      const fresh = await swr.value.refresh();
      if (fresh && fresh.length > 0) {
        myEvents = [...fresh].sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
      }
    }

    loadState = "ready";
  }

  onMount(loadAll);

  async function toggle(eventId: string) {
    if (pendingIds.has(eventId)) return;
    pendingIds = new Set([...pendingIds, eventId]);
    errors = { ...errors };
    delete errors[eventId];

    try {
      if (inSite.has(eventId)) {
        const r = await removeSiteEvent(siteId, eventId);
        if (r.ok && r.data) siteEvents = r.data.events;
        else throw new Error((r as { error?: string }).error || "Remove failed");
      } else {
        const r = await addSiteEvent(siteId, eventId);
        if (r.ok && r.data) siteEvents = r.data.events;
        else throw new Error((r as { error?: string }).error || "Add failed");
      }
    } catch (e) {
      errors = { ...errors, [eventId]: e instanceof Error ? e.message : "Failed" };
    } finally {
      const next = new Set(pendingIds);
      next.delete(eventId);
      pendingIds = next;
    }
  }
</script>

<div class="sem">
  <div class="sem-header">
    <div class="sem-heading">
      <button class="sem-back" onclick={() => navigate("/creator/sites")}>← My sites</button>
      <h2>Site events</h2>
    </div>
    <p class="sem-sub">
      Add or remove events without redeploying. Changes to the events feed go live
      within 5 minutes on deployed sites.
    </p>
    <p class="sem-site-id mono">{siteId}</p>
  </div>

  {#if loadState === "loading"}
    <div class="sem-state">
      <div class="spinner"></div>
      <span>Loading…</span>
    </div>

  {:else if loadState === "error"}
    <div class="sem-state sem-state--warn">
      <p>Could not load. <button class="retry-btn" onclick={loadAll}>Retry</button></p>
    </div>

  {:else if myEvents.length === 0}
    <div class="sem-state sem-state--empty">
      <p>No events yet. Create one from the <button class="sem-link" onclick={() => navigate("/creator")}>creator dashboard</button>.</p>
    </div>

  {:else}
    <ul class="sem-list">
      {#each myEvents as ev (ev.eventId)}
        {@const active = inSite.has(ev.eventId)}
        {@const pending = pendingIds.has(ev.eventId)}
        {@const err = errors[ev.eventId]}
        <li class="sem-row" class:active>
          <button
            class="sem-toggle" class:on={active}
            disabled={pending}
            onclick={() => toggle(ev.eventId)}
            aria-label={active ? "Remove from site" : "Add to site"}
          >
            {#if pending}
              <span class="sem-spinner"></span>
            {:else if active}
              ✓
            {:else}
              +
            {/if}
          </button>

          <div class="sem-info">
            <span class="sem-title">{ev.title}</span>
            <span class="sem-meta">
              {formatDate(ev.startDate)}
              {#if ev.location} · {ev.location}{/if}
              {#if isPast(ev.startDate)}<span class="sem-past">Past</span>{/if}
            </span>
            {#if err}<span class="sem-err">{err}</span>{/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .sem { max-width: 680px; margin: 0 auto; display: flex; flex-direction: column; gap: 1.5rem; }

  .sem-header { display: flex; flex-direction: column; gap: 0.5rem; }

  .sem-heading { display: flex; align-items: center; gap: 1rem; }

  .sem-back {
    background: none; border: none; padding: 0;
    font-size: 0.875rem; color: var(--text-muted); cursor: pointer;
    transition: color var(--transition); white-space: nowrap;
  }
  .sem-back:hover { color: var(--text); }

  h2 { margin: 0; font-size: 1.375rem; font-weight: 700; color: var(--text); letter-spacing: -0.01em; }

  .sem-sub { margin: 0; font-size: 0.875rem; color: var(--text-secondary); line-height: 1.5; }

  .sem-site-id { font-size: 0.75rem; color: var(--text-dim); }
  .mono { font-family: var(--font-mono); }

  .sem-state {
    display: flex; align-items: center; gap: 0.75rem;
    padding: 2.5rem; border: 1px dashed var(--border); border-radius: var(--radius-md);
    justify-content: center; font-size: 0.875rem; color: var(--text-muted);
  }
  .sem-state--warn { border-color: color-mix(in srgb, var(--error) 40%, transparent); }
  .sem-state--empty { flex-direction: column; }
  .sem-state p { margin: 0; }

  .spinner {
    width: 1rem; height: 1rem; border: 2px solid var(--border);
    border-top-color: var(--accent); border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .retry-btn, .sem-link {
    background: none; border: none; padding: 0; cursor: pointer;
    color: var(--accent-text); font-size: inherit; text-decoration: underline;
  }

  .sem-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; }

  .sem-row {
    display: flex; align-items: center; gap: 0.75rem;
    padding: 0.625rem 0.875rem;
    background: var(--bg-surface); border: 1px solid var(--border);
    border-radius: var(--radius-sm); transition: border-color var(--transition);
  }
  .sem-row.active { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 5%, var(--bg-surface)); }

  .sem-toggle {
    width: 2rem; height: 2rem; border-radius: 50%;
    border: 2px solid var(--border); display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; font-size: 0.9rem; color: var(--text-muted); transition: all var(--transition);
  }
  .sem-toggle.on { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); font-weight: 700; }
  .sem-toggle:hover:not(.on):not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .sem-toggle:disabled { opacity: 0.6; cursor: default; }

  .sem-spinner {
    width: 0.75rem; height: 0.75rem; border: 2px solid var(--border);
    border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite;
  }

  .sem-info { display: flex; flex-direction: column; gap: 0.125rem; min-width: 0; }

  .sem-title { font-size: 0.9rem; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .sem-meta { font-size: 0.75rem; color: var(--text-muted); display: flex; align-items: center; gap: 0.375rem; flex-wrap: wrap; }

  .sem-past {
    font-size: 0.6875rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
    padding: 0.1em 0.4em; background: var(--bg); border: 1px solid var(--border);
    border-radius: 3px; color: var(--text-muted);
  }

  .sem-err { font-size: 0.75rem; color: var(--error); }
</style>
