<script lang="ts">
  /**
   * PodGateEditor — attach an optional POD-holdings gate to a ticket series or
   * product. Supports single and multi-POD (any/all) with a group-level time
   * window. Emits `PodGateGroup | undefined`.
   *
   * Back-compat: a prop `gate` that is a legacy `PodGate` (no `gates` field) is
   * normalised to a single-element group on first render so the UI hydrates
   * correctly from existing event/product data.
   */
  import type { PodDirectoryEntry, PodGate, PodGateGroup } from "@woco/shared";
  import { getMyPods } from "../../api/pod.js";
  import PodCard from "./PodCard.svelte";

  interface Props {
    gate: PodGate | PodGateGroup | undefined;
    onChange: (gate: PodGateGroup | undefined) => void;
  }
  let { gate, onChange }: Props = $props();

  // Normalise legacy PodGate → PodGateGroup for initial state.
  function toGroup(g: PodGate | PodGateGroup | undefined): PodGateGroup | undefined {
    if (!g) return undefined;
    if ("gates" in g) return g as PodGateGroup;
    return { mode: "any", gates: [g as PodGate], window: { kind: "always" } };
  }

  // One-time capture on first render (per the back-compat note above) — the
  // editor is a local draft; later prop refreshes must not reset it.
  // svelte-ignore state_referenced_locally
  const initGate = gate;
  const initGroup = toGroup(initGate);

  type Phase = "idle" | "loading" | "ready" | "error";
  let phase = $state<Phase>("idle");
  let gateable = $state<PodDirectoryEntry[]>([]);
  let error = $state("");

  let enabled = $state(!!initGate);
  let selectedRefs = $state<string[]>(initGroup?.gates.map((g) => g.manifestRef) ?? []);
  let mode = $state<"any" | "all">(initGroup?.mode ?? "any");
  let windowKind = $state<"always" | "time" | "firstN">(
    initGroup?.window?.kind === "time" || initGroup?.window?.kind === "firstN"
      ? initGroup.window.kind
      : "always",
  );
  let winNotBefore = $state<string>(
    initGroup?.window?.kind === "time" && initGroup.window.notBefore
      ? new Date(initGroup.window.notBefore).toISOString().slice(0, 16)
      : "",
  );
  let winNotAfter = $state<string>(
    initGroup?.window?.kind === "time" && initGroup.window.notAfter
      ? new Date(initGroup.window.notAfter).toISOString().slice(0, 16)
      : "",
  );
  let winFirstN = $state<number>(
    initGroup?.window?.kind === "firstN" ? initGroup.window.n : 50,
  );

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

  function buildWindow(): PodGateGroup["window"] {
    if (windowKind === "firstN") {
      const n = Math.max(1, Math.floor(winFirstN) || 1);
      return { kind: "firstN", n };
    }
    if (windowKind !== "time") return { kind: "always" };
    const nb = winNotBefore ? new Date(winNotBefore).getTime() : undefined;
    const na = winNotAfter ? new Date(winNotAfter).getTime() : undefined;
    return { kind: "time", ...(nb ? { notBefore: nb } : {}), ...(na ? { notAfter: na } : {}) };
  }

  /** Rebuild + emit the group from current UI state. Emits undefined when the
   *  toggle is off or no valid POD is chosen. */
  function emit() {
    if (!enabled || selectedRefs.length === 0) {
      onChange(undefined);
      return;
    }
    const gates: PodGate[] = selectedRefs.flatMap((ref) => {
      const entry = gateable.find((p) => p.manifestRef === ref);
      if (!entry?.eventId || !entry?.chainId) return [];
      return [{
        manifestRef: entry.manifestRef,
        onChainEventId: entry.eventId,
        chainId: entry.chainId,
        podName: entry.name,
      }];
    });
    if (gates.length === 0) { onChange(undefined); return; }
    onChange({ mode, gates, window: buildWindow() });
  }

  function toggleEnabled() {
    enabled = !enabled;
    if (enabled && phase === "idle") load();
    emit();
  }

  function togglePod(pod: PodDirectoryEntry) {
    if (selectedRefs.includes(pod.manifestRef)) {
      selectedRefs = selectedRefs.filter((r) => r !== pod.manifestRef);
    } else {
      selectedRefs = [...selectedRefs, pod.manifestRef];
    }
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
    <span class="gate-hint">Buyers must be signed in with a wallet that holds the chosen POD(s) on-chain. They can still pay any way you accept — card or crypto.</span>
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
            <PodCard
              {pod}
              variant="picker"
              selected={selectedRefs.includes(pod.manifestRef)}
              onSelect={togglePod}
            />
          {/each}
        </div>

        {#if selectedRefs.length > 1}
          <!-- any/all toggle only shown when 2+ PODs selected -->
          <div class="mode-row">
            <span class="mode-label">Require</span>
            <div class="mode-btns" role="group" aria-label="Gate mode">
              <button
                type="button"
                class="mode-btn"
                class:active={mode === "any"}
                onclick={() => { mode = "any"; emit(); }}
              >any one</button>
              <button
                type="button"
                class="mode-btn"
                class:active={mode === "all"}
                onclick={() => { mode = "all"; emit(); }}
              >all of them</button>
            </div>
          </div>
        {/if}

        <!-- window picker -->
        <div class="window-row">
          <span class="mode-label">Active</span>
          <div class="mode-btns" role="group" aria-label="Gate window">
            <button
              type="button"
              class="mode-btn"
              class:active={windowKind === "always"}
              onclick={() => { windowKind = "always"; emit(); }}
            >always</button>
            <button
              type="button"
              class="mode-btn"
              class:active={windowKind === "time"}
              onclick={() => { windowKind = "time"; emit(); }}
            >time window</button>
            <button
              type="button"
              class="mode-btn"
              class:active={windowKind === "firstN"}
              onclick={() => { windowKind = "firstN"; emit(); }}
            >early access</button>
          </div>
        </div>

        {#if windowKind === "time"}
          <div class="time-fields">
            <label class="time-field">
              <span class="time-label">From</span>
              <input
                type="datetime-local"
                class="time-input"
                bind:value={winNotBefore}
                onchange={emit}
              />
            </label>
            <label class="time-field">
              <span class="time-label">Until</span>
              <input
                type="datetime-local"
                class="time-input"
                bind:value={winNotAfter}
                onchange={emit}
              />
            </label>
          </div>
        {:else if windowKind === "firstN"}
          <div class="firstn-row">
            <label class="time-field firstn-field">
              <span class="time-label">First</span>
              <input
                type="number"
                min="1"
                step="1"
                class="time-input firstn-input"
                bind:value={winFirstN}
                onchange={emit}
              />
            </label>
            <span class="firstn-hint">
              tickets are POD-holder only; after {Math.max(1, Math.floor(winFirstN) || 1)} are
              claimed it opens to everyone (any payment method).
            </span>
          </div>
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
    width: 0.9rem; height: 0.9rem;
    accent-color: var(--accent);
    flex-shrink: 0;
  }
  .gate-label { font-size: 0.8125rem; color: var(--text-secondary); font-weight: 500; }
  .gate-hint { font-size: 0.75rem; color: var(--text-muted); width: 100%; margin-left: 1.4rem; }

  .gate-body {
    display: flex; flex-direction: column; gap: 0.625rem;
    margin-left: 1.4rem;
  }
  .gate-msg { font-size: 0.78rem; color: var(--text-muted); margin: 0; }
  .gate-msg--err { color: var(--error); }
  .gate-msg a { color: var(--accent-text); }
  .retry {
    color: var(--accent-text); background: none; border: none;
    cursor: pointer; font-size: inherit; padding: 0; text-decoration: underline;
  }

  .gate-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 0.5rem;
  }

  .mode-row, .window-row {
    display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
  }
  .mode-label {
    font-size: 0.6875rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted);
    white-space: nowrap;
  }
  .mode-btns {
    display: flex; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden;
  }
  .mode-btn {
    background: transparent; border: none; cursor: pointer;
    padding: 0.25rem 0.625rem; font-size: 0.75rem; color: var(--text-muted);
    transition: background 0.1s, color 0.1s; font-family: inherit;
  }
  .mode-btn + .mode-btn { border-left: 1px solid var(--border); }
  .mode-btn.active { background: var(--accent); color: var(--accent-ink, #111); font-weight: 600; }
  .mode-btn:not(.active):hover { background: var(--bg-elevated); color: var(--text); }

  .time-fields {
    display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem;
  }
  .time-field { display: flex; flex-direction: column; gap: 0.25rem; }
  .time-label {
    font-size: 0.5625rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--text-muted);
  }
  .time-input {
    background: var(--bg-input); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text);
    padding: 0.375rem 0.5rem; font-size: 0.75rem; font-family: inherit;
  }
  .time-input:focus { outline: none; border-color: var(--accent); }

  .firstn-row {
    display: flex; align-items: flex-end; gap: 0.625rem; flex-wrap: wrap;
  }
  .firstn-field { flex-shrink: 0; }
  .firstn-input { width: 5rem; }
  .firstn-hint {
    font-size: 0.72rem; color: var(--text-muted); line-height: 1.3;
    flex: 1; min-width: 12rem; padding-bottom: 0.375rem;
  }
</style>
