<script lang="ts">
  /**
   * PodPicker — select one or more POD types by manifestRef.
   *
   * Wraps PodCard variant="picker". Used wherever event / product gating plugs
   * in (Step 2 / Opus work). This component stays self-contained: load, filter,
   * toggle. The parent owns selection state and receives changes via `onChange`.
   */
  import type { PodDirectoryEntry, PodKind } from "@woco/shared";
  import { getMyPods } from "../../api/pod.js";
  import PodCard from "./PodCard.svelte";

  interface Props {
    /** Currently selected manifestRef(s). */
    selected: string[];
    multiple?: boolean;
    kindFilter?: PodKind[];
    onChange: (selected: string[]) => void;
    /** Optional label shown in the empty-state link. */
    label?: string;
  }

  let { selected, multiple = false, kindFilter, onChange, label = "PODs" }: Props = $props();

  type Phase = "loading" | "ready" | "error";
  let phase = $state<Phase>("loading");
  let pods = $state<PodDirectoryEntry[]>([]);
  let categories = $state<Map<string, string>>(new Map());
  let error = $state("");
  let catFilter = $state("all");

  const BEE_GATEWAY = import.meta.env.VITE_GATEWAY_URL || "https://gateway.woco-net.com";
  void BEE_GATEWAY; // used in PodCard, mentioned for context

  async function load() {
    phase = "loading";
    error = "";
    try {
      const dir = await getMyPods();
      pods = kindFilter
        ? dir.pods.filter((p) => kindFilter.includes(p.kind))
        : dir.pods;
      const m = new Map<string, string>();
      for (const c of dir.categories) m.set(c.id, c.label);
      categories = m;
      phase = "ready";
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load PODs";
      phase = "error";
    }
  }

  const catOptions = $derived.by(() => {
    const seen = new Set<string>();
    const opts: { id: string; label: string }[] = [];
    for (const p of pods) {
      if (p.categoryId && !seen.has(p.categoryId)) {
        seen.add(p.categoryId);
        opts.push({ id: p.categoryId, label: categories.get(p.categoryId) ?? p.categoryId });
      }
    }
    return opts;
  });

  const filtered = $derived.by(() => {
    if (catFilter === "all") return pods;
    if (catFilter === "uncat") return pods.filter((p) => !p.categoryId);
    return pods.filter((p) => p.categoryId === catFilter);
  });

  function toggle(pod: PodDirectoryEntry) {
    const ref = pod.manifestRef;
    if (multiple) {
      const next = selected.includes(ref)
        ? selected.filter((r) => r !== ref)
        : [...selected, ref];
      onChange(next);
    } else {
      onChange(selected.includes(ref) ? [] : [ref]);
    }
  }

  import { onMount } from "svelte";
  onMount(load);
</script>

<div class="picker">
  {#if phase === "loading"}
    <div class="pick-skel-list">
      {#each Array(3) as _, i}
        <div class="pick-skel" style="animation-delay:{i * 0.08}s"></div>
      {/each}
    </div>

  {:else if phase === "error"}
    <div class="pick-empty">
      <span class="pick-kicker">Couldn't load {label}</span>
      <p>{error}</p>
      <button class="btn btn--ghost btn--sm" onclick={load}>Retry</button>
    </div>

  {:else if pods.length === 0}
    <div class="pick-empty">
      <span class="pick-kicker">No {label} yet</span>
      <p>
        Create a POD first — <a class="pick-link" href="/creator/pods">go to POD manager</a>.
      </p>
    </div>

  {:else}
    {#if catOptions.length > 0}
      <div class="pick-filters" role="tablist">
        <button
          class="fchip"
          class:active={catFilter === "all"}
          role="tab"
          aria-selected={catFilter === "all"}
          onclick={() => (catFilter = "all")}
        >All</button>
        {#each catOptions as opt (opt.id)}
          <button
            class="fchip"
            class:active={catFilter === opt.id}
            role="tab"
            aria-selected={catFilter === opt.id}
            onclick={() => (catFilter = opt.id)}
          >{opt.label}</button>
        {/each}
        {#if pods.some((p) => !p.categoryId)}
          <button
            class="fchip"
            class:active={catFilter === "uncat"}
            role="tab"
            aria-selected={catFilter === "uncat"}
            onclick={() => (catFilter = "uncat")}
          >Uncategorised</button>
        {/if}
      </div>
    {/if}

    <div class="pick-list">
      {#each filtered as pod (pod.manifestRef)}
        <PodCard
          {pod}
          variant="picker"
          categoryLabel={pod.categoryId ? categories.get(pod.categoryId) : undefined}
          selected={selected.includes(pod.manifestRef)}
          onSelect={toggle}
        />
      {/each}
      {#if filtered.length === 0}
        <p class="pick-none">Nothing in this category.</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* ── filter chips ───────────────────────────────────────────────── */
  .pick-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 2px;
  }
  .fchip {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    letter-spacing: 0.02em;
    color: var(--text-secondary);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 4px 10px;
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

  /* ── list ───────────────────────────────────────────────────────── */
  .pick-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .pick-none {
    font-size: 0.85rem;
    color: var(--text-muted);
    padding: 10px 0;
    margin: 0;
  }

  /* ── skeleton ───────────────────────────────────────────────────── */
  .pick-skel-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .pick-skel {
    height: 58px;
    border-radius: var(--radius-md);
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
    to { background-position: -200% 0; }
  }

  /* ── empty / error ──────────────────────────────────────────────── */
  .pick-empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    padding: 16px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
  }
  .pick-kicker {
    font-family: var(--font-mono);
    font-size: 0.65rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .pick-empty p {
    font-size: 0.85rem;
    color: var(--text-secondary);
    margin: 0;
    line-height: 1.45;
  }
  .pick-link {
    color: var(--accent-text);
    text-decoration: underline;
  }

  /* ── buttons ─────────────────────────────────────────────────────── */
  .btn {
    display: inline-flex;
    align-items: center;
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 0.86rem;
    padding: 8px 14px;
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    cursor: pointer;
    transition: background var(--transition), border-color var(--transition);
  }
  .btn--ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-hover);
  }
  .btn--ghost:hover { background: var(--bg-surface-hover); }
  .btn--sm { font-size: 0.78rem; padding: 5px 10px; }
</style>
