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
  import { getMyPods, setPodCategories } from "../../api/pod.js";
  import { onMount } from "svelte";
  import PodCard from "./PodCard.svelte";
  import PodEditDrawer from "./PodEditDrawer.svelte";
  import PodCreateModal from "./PodCreateModal.svelte";

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

  // ── detail drawer ────────────────────────────────────────────────────────────
  let selectedPod = $state<PodDirectoryEntry | null>(null);

  function onSelect(pod: PodDirectoryEntry) {
    selectedPod = pod;
  }
  function closeDrawer() {
    selectedPod = null;
  }
  function onDrawerSaved(updated: PodDirectoryEntry) {
    pods = pods.map((p) => (p.manifestRef === updated.manifestRef ? updated : p));
  }

  // ── category editor ───────────────────────────────────────────────────────
  let catEditorOpen = $state(false);
  let catDraft = $state<PodCategory[]>([]);
  let catSaving = $state(false);
  let catError = $state("");

  function openCatEditor() {
    catDraft = categories.map((c) => ({ ...c }));
    catError = "";
    catEditorOpen = true;
  }
  function closeCatEditor() {
    catEditorOpen = false;
    catError = "";
  }

  function addCategory() {
    const id = crypto.randomUUID();
    catDraft = [...catDraft, { id, label: "", sortIndex: catDraft.length }];
  }

  function removeCategory(id: string) {
    catDraft = catDraft.filter((c) => c.id !== id);
  }

  function moveCat(idx: number, dir: -1 | 1) {
    const next = [...catDraft];
    const swap = idx + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[idx], next[swap]] = [next[swap], next[idx]];
    catDraft = next.map((c, i) => ({ ...c, sortIndex: i }));
  }

  async function saveCategories() {
    const valid = catDraft.filter((c) => c.label.trim());
    if (valid.length !== catDraft.length) {
      catError = "Every category needs a name.";
      return;
    }
    catSaving = true;
    catError = "";
    try {
      const saved = await setPodCategories(valid.map((c, i) => ({ ...c, sortIndex: i })));
      categories = saved;
      const dir = await getMyPods();
      pods = dir.pods;
      categories = dir.categories;
      catEditorOpen = false;
    } catch (e) {
      catError = e instanceof Error ? e.message : "Failed to save categories";
    } finally {
      catSaving = false;
    }
  }

  // ── create POD ────────────────────────────────────────────────────────────
  let createOpen = $state(false);

  function onCreate() {
    createOpen = true;
  }
  function onCreated(entry: PodDirectoryEntry) {
    // The directory is most-recently-updated first; mirror that locally so the
    // new POD appears at the head without a refetch.
    pods = [entry, ...pods.filter((p) => p.manifestRef !== entry.manifestRef)];
  }

  onMount(load);
</script>

<PodEditDrawer
  pod={selectedPod}
  {categories}
  onclose={closeDrawer}
  onsaved={onDrawerSaved}
/>

<PodCreateModal
  open={createOpen}
  {categories}
  onclose={() => (createOpen = false)}
  oncreated={onCreated}
/>

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
    <div class="filter-row">
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
      <button class="btn btn--ghost btn--sm" onclick={openCatEditor} title="Manage categories">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 3h10M1 6h10M1 9h6" /></svg>
        Categories
      </button>
    </div>
  {/if}

  <!-- Category editor panel -->
  {#if catEditorOpen}
    <div class="cat-editor">
      <div class="cat-head">
        <span class="cat-title">Manage categories</span>
        <button class="close-btn" onclick={closeCatEditor} aria-label="Close">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M1 1l10 10M11 1L1 11" /></svg>
        </button>
      </div>
      <div class="cat-list">
        {#each catDraft as cat, i (cat.id)}
          <div class="cat-row">
            <div class="cat-arrows">
              <button class="arr-btn" onclick={() => moveCat(i, -1)} disabled={i === 0} aria-label="Move up">▲</button>
              <button class="arr-btn" onclick={() => moveCat(i, 1)} disabled={i === catDraft.length - 1} aria-label="Move down">▼</button>
            </div>
            <input
              class="cat-input"
              type="text"
              bind:value={cat.label}
              placeholder="Category name"
              maxlength={40}
            />
            <button class="del-btn" onclick={() => removeCategory(cat.id)} aria-label="Delete category">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M1 1l9 9M10 1L1 10" /></svg>
            </button>
          </div>
        {/each}
        {#if catDraft.length === 0}
          <p class="cat-empty">No categories — add one below.</p>
        {/if}
      </div>
      <button class="btn btn--ghost btn--sm cat-add" onclick={addCategory}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square"><path d="M5 1v8M1 5h8" /></svg>
        Add category
      </button>
      {#if catError}
        <p class="cat-err">{catError}</p>
      {/if}
      <div class="cat-foot">
        <button class="btn btn--ghost btn--sm" onclick={closeCatEditor} disabled={catSaving}>Cancel</button>
        <button class="btn btn--primary btn--sm" onclick={saveCategories} disabled={catSaving}>
          {catSaving ? "Saving…" : "Save"}
        </button>
      </div>
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

  .btn--sm {
    font-size: 0.78rem;
    padding: 6px 11px;
  }

  /* ── filter chips ───────────────────────────────────────────────── */
  .filter-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-bottom: 18px;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    flex: 1;
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

  .close-btn {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: border-color var(--transition), color var(--transition);
    flex-shrink: 0;
  }
  .close-btn:hover {
    border-color: var(--border-hover);
    color: var(--text);
  }

  /* ── category editor ───────────────────────────────────────────── */
  .cat-editor {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 14px 16px;
    margin-bottom: 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .cat-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .cat-title {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .cat-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .cat-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .cat-arrows {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .arr-btn {
    font-size: 0.55rem;
    color: var(--text-dim);
    background: none;
    border: none;
    cursor: pointer;
    padding: 1px 3px;
    line-height: 1;
    transition: color var(--transition);
  }
  .arr-btn:hover:not(:disabled) { color: var(--text); }
  .arr-btn:disabled { opacity: 0.3; cursor: not-allowed; }
  .cat-input {
    flex: 1;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-family: var(--font-body);
    font-size: 0.86rem;
    padding: 6px 9px;
    transition: border-color var(--transition);
  }
  .cat-input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .del-btn {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    background: transparent;
    color: var(--error);
    cursor: pointer;
    flex-shrink: 0;
    transition: border-color var(--transition), background var(--transition);
  }
  .del-btn:hover {
    border-color: var(--error);
    background: rgba(255, 80, 60, 0.07);
  }
  .cat-empty {
    font-size: 0.82rem;
    color: var(--text-muted);
    margin: 0;
    padding: 8px 0;
  }
  .cat-add {
    align-self: flex-start;
  }
  .cat-err {
    font-size: 0.82rem;
    color: var(--error);
    margin: 0;
  }
  .cat-foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 2px;
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
