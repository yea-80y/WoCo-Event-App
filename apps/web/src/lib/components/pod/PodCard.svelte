<script lang="ts">
  /**
   * PodCard — the reused visual atom of the creator POD layer (Concrete & Acid).
   *
   * A POD *type* (one manifest) rendered two ways, sharing one supply language:
   *  - "grid":   artwork + kind chip + name + the allocation hairline (issued/
   *              supply), the POD analogue of ProductCard's loud price. Tappable.
   *  - "picker": compact row for selecting a POD when configuring an event gate
   *              or a product reward; lime ring + check when `selected`.
   *
   * Signature detail: the lime ALLOCATION HAIRLINE under the artwork shows how
   * much of a capped drop is claimed — scarcity ("first 100") is visible at a
   * glance. Lime is the single accent surface (selected/affordance), matching
   * the shop. Vermillion never appears here (nothing destructive).
   */
  import type { PodDirectoryEntry, PodKind } from "@woco/shared";

  interface Props {
    pod: PodDirectoryEntry;
    variant?: "grid" | "picker";
    /** Category label (grid only) — shown as a mono kicker above the name. */
    categoryLabel?: string;
    /** Picker selection state. */
    selected?: boolean;
    onSelect?: (pod: PodDirectoryEntry) => void;
  }

  let { pod, variant = "grid", categoryLabel, selected = false, onSelect }: Props = $props();

  const BEE_GATEWAY = import.meta.env.VITE_GATEWAY_URL || "https://gateway.woco-net.com";

  /** Short human label per kind — the chip text (Bungee). */
  const KIND_LABEL: Record<PodKind, string> = {
    ticket: "TICKET",
    badge: "BADGE",
    collectible: "DROP",
    authenticity: "AUTHENTIC",
  };

  const imageUrl = $derived(pod.image ? `${BEE_GATEWAY}/bytes/${pod.image}` : null);
  const issued = $derived(pod.issuedCount ?? 0);
  /** Claimed fraction of the cap, 0..1 — drives the allocation hairline width. */
  const fillPct = $derived(pod.supply > 0 ? Math.min(100, (issued / pod.supply) * 100) : 0);
  /** Transferable provenance is the one special kind — marked, not color-coded. */
  const isAuthentic = $derived(pod.kind === "authenticity");

  function select() {
    onSelect?.(pod);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      select();
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="podc podc--{variant}"
  class:selected
  class:authentic={isAuthentic}
  role="button"
  tabindex="0"
  aria-pressed={variant === "picker" ? selected : undefined}
  onclick={select}
  onkeydown={onKey}
>
  {#if variant === "grid"}
    <div class="media">
      {#if imageUrl}
        <img src={imageUrl} alt={pod.name} loading="lazy" />
      {:else}
        <div class="media-blank" aria-hidden="true">
          <span class="glyph">◈</span>
        </div>
      {/if}
      <span class="chip" class:chip-auth={isAuthentic}>{KIND_LABEL[pod.kind]}</span>
    </div>

    <!-- Allocation hairline: claimed / supply -->
    <div class="alloc" title="{issued} of {pod.supply} issued">
      <div class="alloc-fill" style="width:{fillPct}%"></div>
    </div>

    <div class="body">
      {#if categoryLabel}
        <span class="kicker">{categoryLabel}</span>
      {/if}
      <h3 class="name" title={pod.name}>{pod.name}</h3>
      <div class="supply">
        <span class="num">{issued}</span><span class="sep">/</span><span class="cap"
          >{pod.supply}</span
        >
        <span class="supply-label">issued</span>
      </div>
    </div>
  {:else}
    <!-- picker row -->
    <div class="thumb">
      {#if imageUrl}
        <img src={imageUrl} alt={pod.name} loading="lazy" />
      {:else}
        <span class="glyph" aria-hidden="true">◈</span>
      {/if}
    </div>
    <div class="pick-body">
      <span class="chip chip-inline" class:chip-auth={isAuthentic}>{KIND_LABEL[pod.kind]}</span>
      <span class="pick-name" title={pod.name}>{pod.name}</span>
      <span class="pick-supply">{issued} / {pod.supply}</span>
    </div>
    <span class="check" aria-hidden="true"></span>
  {/if}
</div>

<style>
  .podc {
    position: relative;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    cursor: pointer;
    transition: border-color var(--transition), background var(--transition), transform var(--transition);
    -webkit-tap-highlight-color: transparent;
  }
  .podc:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* ── grid variant ───────────────────────────────────────────────── */
  .podc--grid {
    border-radius: var(--radius-lg);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .podc--grid:hover {
    border-color: var(--border-hover);
    background: var(--bg-surface-hover);
    transform: translateY(-2px);
  }

  .media {
    position: relative;
    aspect-ratio: 4 / 3;
    background: var(--bg-input);
    overflow: hidden;
  }
  .media img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .media-blank {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    background:
      radial-gradient(120% 120% at 50% 0%, var(--bg-elevated), var(--bg-input));
  }
  .glyph {
    font-size: 2rem;
    color: var(--text-dim);
    line-height: 1;
  }

  .chip {
    position: absolute;
    top: 8px;
    left: 8px;
    font-family: var(--font-tag);
    font-size: 0.6rem;
    letter-spacing: 0.06em;
    color: var(--text);
    background: rgba(11, 11, 9, 0.78);
    backdrop-filter: blur(4px);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 3px 7px 2px;
    line-height: 1;
  }
  /* Transferable provenance — the one kind that gets the lime mark. */
  .chip-auth {
    color: var(--accent-ink);
    background: var(--accent);
    border-color: var(--accent);
  }

  .alloc {
    height: 2px;
    background: var(--border);
    width: 100%;
  }
  .alloc-fill {
    height: 100%;
    background: var(--accent);
    transition: width var(--transition);
  }

  .body {
    padding: 11px 12px 13px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
  }
  .kicker {
    font-family: var(--font-mono);
    font-size: 0.62rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .name {
    font-family: var(--font-display);
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--text);
    margin: 0;
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .supply {
    margin-top: 4px;
    display: flex;
    align-items: baseline;
    gap: 4px;
    font-family: var(--font-mono);
  }
  .supply .num {
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--text);
  }
  .supply .sep {
    color: var(--text-dim);
  }
  .supply .cap {
    color: var(--text-secondary);
    font-size: 0.95rem;
  }
  .supply-label {
    margin-left: auto;
    font-size: 0.6rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-dim);
    align-self: center;
  }

  /* ── picker variant ─────────────────────────────────────────────── */
  .podc--picker {
    border-radius: var(--radius-md);
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
  }
  .podc--picker:hover {
    border-color: var(--border-hover);
    background: var(--bg-surface-hover);
  }
  .podc--picker.selected {
    border-color: var(--accent);
    background: var(--accent-subtle);
  }
  .thumb {
    flex: 0 0 auto;
    width: 40px;
    height: 40px;
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--bg-input);
    display: grid;
    place-items: center;
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .thumb .glyph {
    font-size: 1.1rem;
  }
  .pick-body {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .chip-inline {
    position: static;
    top: auto;
    left: auto;
    backdrop-filter: none;
    flex: 0 0 auto;
  }
  .pick-name {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 0.88rem;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pick-supply {
    margin-left: auto;
    flex: 0 0 auto;
    font-family: var(--font-mono);
    font-size: 0.78rem;
    color: var(--text-muted);
  }
  .check {
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 1.5px solid var(--border-hover);
    position: relative;
    transition: border-color var(--transition), background var(--transition);
  }
  .selected .check {
    border-color: var(--accent);
    background: var(--accent);
  }
  .selected .check::after {
    content: "";
    position: absolute;
    left: 5px;
    top: 2px;
    width: 4px;
    height: 8px;
    border: solid var(--accent-ink);
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }
</style>
