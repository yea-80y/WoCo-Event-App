<script lang="ts">
  /**
   * PodGateEditor — attach an optional POD-holdings gate to a ticket series (or,
   * later, a product). Emits a resolved `PodGate` the server can enforce.
   *
   * Only PODs that are registered on-chain (have `eventId` + `chainId`) can gate,
   * because enforcement reads on-chain slot ownership — so the picker lists only
   * those. Reuses the `PodCard` picker atom; loads the directory once and
   * resolves the chosen POD to the full `PodGate` (manifestRef + the on-chain
   * read coordinates the server needs).
   */
  import type { PodDirectoryEntry, PodGate } from "@woco/shared";
  import { getMyPods } from "../../api/pod.js";
  import PodCard from "./PodCard.svelte";

  interface Props {
    gate: PodGate | undefined;
    onChange: (gate: PodGate | undefined) => void;
  }
  let { gate, onChange }: Props = $props();

  type Phase = "idle" | "loading" | "ready" | "error";
  let phase = $state<Phase>("idle");
  let gateable = $state<PodDirectoryEntry[]>([]);
  let error = $state("");

  let enabled = $state(!!gate);
  let selectedRef = $state<string>(gate?.manifestRef ?? "");
  let minCount = $state<number>(gate?.minCount ?? 1);

  async function load() {
    if (phase === "ready" || phase === "loading") return;
    phase = "loading";
    error = "";
    try {
      const dir = await getMyPods();
      // Only on-chain-registered PODs are gateable (holdings read needs both).
      gateable = dir.pods.filter((p) => p.eventId && p.chainId);
      phase = "ready";
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load PODs";
      phase = "error";
    }
  }

  /** Rebuild + emit the gate from the current selection. Emits undefined when
   *  the toggle is off or no valid POD is chosen. */
  function emit() {
    if (!enabled) {
      onChange(undefined);
      return;
    }
    const entry = gateable.find((p) => p.manifestRef === selectedRef);
    if (!entry || !entry.eventId || !entry.chainId) {
      onChange(undefined);
      return;
    }
    const n = Math.max(1, Math.floor(minCount || 1));
    onChange({
      manifestRef: entry.manifestRef,
      onChainEventId: entry.eventId,
      chainId: entry.chainId,
      podName: entry.name,
      ...(n > 1 ? { minCount: n } : {}),
    });
  }

  function toggleEnabled() {
    enabled = !enabled;
    if (enabled && phase === "idle") load();
    emit();
  }

  function pick(pod: PodDirectoryEntry) {
    selectedRef = selectedRef === pod.manifestRef ? "" : pod.manifestRef;
    emit();
  }

  // Load eagerly when opened pre-enabled (editing an existing gated series).
  $effect(() => {
    if (enabled && phase === "idle") load();
  });
</script>

<div class="gate">
  <label class="gate-toggle">
    <input type="checkbox" checked={enabled} onchange={toggleEnabled} />
    <span class="gate-label">Require holding a POD</span>
    <span class="gate-hint">Only wallets that hold the chosen POD on-chain can claim this tier.</span>
  </label>

  {#if enabled}
    <div class="gate-body">
      {#if phase === "loading"}
        <p class="gate-msg">Loading your PODs…</p>
      {:else if phase === "error"}
        <p class="gate-msg gate-msg--err">{error} <button type="button" class="retry" onclick={load}>Retry</button></p>
      {:else if gateable.length === 0}
        <p class="gate-msg">
          No on-chain PODs yet. Create a badge or collectible in the
          <a href="/creator/pods">POD manager</a> first — only on-chain PODs can gate.
        </p>
      {:else}
        <div class="gate-grid">
          {#each gateable as pod (pod.manifestRef)}
            <PodCard {pod} variant="picker" selected={selectedRef === pod.manifestRef} onSelect={pick} />
          {/each}
        </div>

        {#if selectedRef}
          <label class="gate-min">
            <span class="gate-min-label">Minimum held</span>
            <input
              type="number"
              min="1"
              step="1"
              bind:value={minCount}
              onchange={emit}
              onblur={emit}
            />
          </label>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .gate {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    border-top: 1px dashed var(--border);
    padding-top: 0.75rem;
    margin-top: 0.125rem;
  }
  .gate-toggle {
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    gap: 0.5rem;
    cursor: pointer;
    flex-wrap: wrap;
  }
  .gate-toggle input[type="checkbox"] {
    margin-top: 0.125rem;
    width: 0.9rem;
    height: 0.9rem;
    accent-color: var(--accent);
    flex-shrink: 0;
  }
  .gate-label {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    font-weight: 500;
  }
  .gate-hint {
    font-size: 0.75rem;
    color: var(--text-muted);
    width: 100%;
    margin-left: 1.4rem;
  }
  .gate-body {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    margin-left: 1.4rem;
  }
  .gate-msg {
    font-size: 0.78rem;
    color: var(--text-muted);
    margin: 0;
  }
  .gate-msg--err {
    color: var(--error);
  }
  .gate-msg a {
    color: var(--accent-text);
  }
  .retry {
    color: var(--accent-text);
    background: none;
    border: none;
    cursor: pointer;
    font-size: inherit;
    padding: 0;
    text-decoration: underline;
  }
  .gate-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 0.5rem;
  }
  .gate-min {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    max-width: 8rem;
  }
  .gate-min-label {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-secondary);
  }
  .gate-min input {
    padding: 0.375rem 0.5rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 0.8125rem;
    font-family: inherit;
  }
  .gate-min input:focus {
    outline: none;
    border-color: var(--accent);
  }
</style>
