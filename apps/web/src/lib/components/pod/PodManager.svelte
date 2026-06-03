<script lang="ts">
  /**
   * PodManager — the creator "PODs" surface (#/creator/pods).
   *
   * Header (title + Create POD), category filter chips, responsive PodCard grid,
   * empty/loading/error states. The LOOK is locked here (Opus + frontend-design):
   * Concrete & Acid, single lime affordance, the PodCard allocation hairline.
   *
   * HANDOFF (Sonnet — see docs/POD_MANAGER_SONNET_HANDOVER.md): the create-POD
   * modal (badge/collectible — name, artwork upload, supply → sign manifest),
   * the POD detail/edit drawer (rename, re-categorise, artwork), and category
   * management. Those hang off the `onCreate` / `onSelect` seams below; the data
   * load, filtering, grid, and states are done.
   */
  import type { PodDirectoryEntry, PodCategory, PodKind } from "@woco/shared";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { getMyPods } from "../../api/pod.js";
  import { onMount } from "svelte";
  import PodCard from "./PodCard.svelte";

  type Phase = "loading" | "ready" | "unauth" | "error";
  let phase = $state<Phase>("loading");
  let pods = $state<PodDirectoryEntry[]>([]);
  let categories = $state<PodCategory[]>([]);
  let error = $state("");

  /** Active category filter — "all" or a category id; "uncat" = no category. */
  let activeFilter = $state<string>("all");

  const catLabel = $derived.by(() => {
    const m = new Map<string, string>();
    for (const c of categories) m.set(c.id, c.label);
    return m;
  });

  const filtered = $derived.by(() => {
    if (activeFilter === "all") return pods;
    if (activeFilter === "uncat") return pods.filter((p) => !p.categoryId);
    return pods.filter((p) => p.categoryId === activeFilter);
  });

  /** Count per kind, for the header summary line. */
  const kindCounts = $derived.by(() => {
    const c: Record<PodKind, number> = { ticket: 0, badge: 0, collectible: 0, authenticity: 0 };
    for (const p of pods) c[p.kind]++;
    return c;
  });

  const sortedCategories = $derived(
    [...categories].sort((a, b) => a.sortIndex - b.sortIndex),
  );
  const hasUncategorised = $derived(pods.some((p) => !p.categoryId));

  async function load() {
    if (!auth.isConnected || !auth.parent) {
      phase = "unauth";
      return;
    }
    if (!auth.hasSession) {
      const ok = await auth.ensureSession();
      if (!ok) {
        phase = "unauth";
        return;
      }
    }
    try {
      const dir = await getMyPods();
      pods = dir.pods;
      categories = dir.categories;
      phase = "ready";
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load PODs";
      phase = "error";
    }
  }

  // Seams for Sonnet — wire the create modal + detail drawer here.
  function onCreate() {
    // TODO(sonnet): open the create-POD modal (badge/collectible).
    console.info("[pod] create — modal pending (Sonnet handover)");
  }
  function onSelect(pod: PodDirectoryEntry) {
    // TODO(sonnet): open the POD detail/edit drawer.
    console.info("[pod] select", pod.manifestRef);
  }

  onMount(load);
</script>

<div class="pod-manager">
  <div class="page-head">
    <div class="head-left">
      <h1>PODs</h1>
      <span class="kicker">
        Collectibles · loyalty badges · access passes
      </span>
    </div>
    <button class="btn btn--primary" onclick={onCreate}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square"><path d="M6 1v10M1 6h10" /></svg>
      Create POD
    </button>
  </div>

  {#if phase === "ready" && pods.length > 0}
    <div class="filters" role="tablist" aria-label="Filter PODs by category">
      <button
        class="fchip"
        class:active={activeFilter === "all"}
        role="tab"
        aria-selected={activeFilter === "all"}
        onclick={() => (activeFilter = "all")}
      >
        All <span class="fcount">{pods.length}</span>
      </button>
      {#each sortedCategories as cat (cat.id)}
        <button
          class="fchip"
          class:active={activeFilter === cat.id}
          role="tab"
          aria-selected={activeFilter === cat.id}
          onclick={() => (activeFilter = cat.id)}
        >
          {cat.label}
        </button>
      {/each}
      {#if hasUncategorised}
        <button
          class="fchip"
          class:active={activeFilter === "uncat"}
          role="tab"
          aria-selected={activeFilter === "uncat"}
          onclick={() => (activeFilter = "uncat")}
        >
          Uncategorised
        </button>
      {/if}
    </div>
  {/if}

  {#if phase === "loading"}
    <div class="grid">
      {#each Array(6) as _, i}
        <div class="skeleton" style="animation-delay:{i * 0.08}s"></div>
      {/each}
    </div>
  {:else if phase === "unauth"}
    <div class="empty-state">
      <span class="kicker">Not connected</span>
      <p>Connect your account to manage your PODs.</p>
    </div>
  {:else if phase === "error"}
    <div class="empty-state error">
      <span class="kicker">Couldn't load</span>
      <p>{error}</p>
      <button class="btn btn--ghost" onclick={load}>Retry</button>
    </div>
  {:else if pods.length === 0}
    <div class="empty-state">
      <div class="empty-mark" aria-hidden="true">◈</div>
      <span class="kicker">No PODs yet</span>
      <p>
        PODs are your ownable assets — event tickets, loyalty badges, limited
        drops. Publish an event and its tickets appear here automatically, or
        create a badge to reward your community.
      </p>
      <button class="btn btn--primary" onclick={onCreate}>Create your first POD</button>
    </div>
  {:else if filtered.length === 0}
    <div class="empty-state">
      <span class="kicker">Nothing in this category</span>
      <p>No PODs match this filter yet.</p>
    </div>
  {:else}
    <div class="grid">
      {#each filtered as pod (pod.manifestRef)}
        <PodCard
          {pod}
          variant="grid"
          categoryLabel={pod.categoryId ? catLabel.get(pod.categoryId) : undefined}
          {onSelect}
        />
      {/each}
    </div>
  {/if}
</div>

<style>
  .pod-manager {
    max-width: 1080px;
    margin: 0 auto;
    padding: 24px 20px 80px;
  }

  .page-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 18px;
  }
  .head-left {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  h1 {
    font-family: var(--font-display);
    font-size: 1.6rem;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--text);
    margin: 0;
  }
  .kicker {
    font-family: var(--font-mono);
    font-size: 0.66rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 0.86rem;
    padding: 9px 15px;
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    cursor: pointer;
    transition: background var(--transition), border-color var(--transition), color var(--transition);
    white-space: nowrap;
  }
  .btn--primary {
    background: var(--accent);
    color: var(--accent-ink);
  }
  .btn--primary:hover {
    background: var(--accent-hover);
  }
  .btn--ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-hover);
  }
  .btn--ghost:hover {
    background: var(--bg-surface-hover);
  }

  /* ── filter chips ───────────────────────────────────────────────── */
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    margin-bottom: 18px;
  }
  .fchip {
    font-family: var(--font-mono);
    font-size: 0.72rem;
    letter-spacing: 0.02em;
    color: var(--text-secondary);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 5px 12px;
    cursor: pointer;
    transition: border-color var(--transition), color var(--transition), background var(--transition);
  }
  .fchip:hover {
    border-color: var(--border-hover);
    color: var(--text);
  }
  .fchip.active {
    color: var(--accent-ink);
    background: var(--accent);
    border-color: var(--accent);
  }
  .fcount {
    opacity: 0.7;
    margin-left: 2px;
  }

  /* ── grid ───────────────────────────────────────────────────────── */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 14px;
  }

  .skeleton {
    aspect-ratio: 4 / 3.4;
    border-radius: var(--radius-lg);
    background: linear-gradient(
      100deg,
      var(--bg-surface) 30%,
      var(--bg-surface-hover) 50%,
      var(--bg-surface) 70%
    );
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
  }
  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
  }

  /* ── empty / error states ───────────────────────────────────────── */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    text-align: center;
    padding: 56px 24px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-surface);
  }
  .empty-state p {
    max-width: 38ch;
    color: var(--text-secondary);
    font-size: 0.9rem;
    line-height: 1.5;
    margin: 0;
  }
  .empty-state.error p {
    color: var(--error);
  }
  .empty-state .btn {
    margin-top: 6px;
  }
  .empty-mark {
    font-size: 2.4rem;
    color: var(--text-dim);
    line-height: 1;
    margin-bottom: 2px;
  }

  @media (max-width: 560px) {
    .grid {
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    }
    h1 {
      font-size: 1.35rem;
    }
  }
</style>
