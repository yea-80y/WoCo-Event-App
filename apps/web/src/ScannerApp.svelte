<script lang="ts">
  /**
   * Scanner shell: provisioning gate, event header with sync state, conflict
   * and dead-pass banners, and the Scan / Attendees tab pair.
   */
  import { onMount } from "svelte";
  import { scanner } from "./lib/scanner/store.svelte.js";
  import ScanScreen from "./lib/scanner/ScanScreen.svelte";
  import RosterScreen from "./lib/scanner/RosterScreen.svelte";
  import ProvisionScreen from "./lib/scanner/ProvisionScreen.svelte";

  let tab = $state<"scan" | "roster">("scan");
  let refreshing = $state(false);
  let confirmReset = $state(false);

  onMount(() => void scanner.init());

  async function refresh(): Promise<void> {
    refreshing = true;
    await scanner.refreshPack();
    await scanner.sync();
    refreshing = false;
  }

  function resetTap(): void {
    if (!confirmReset) {
      confirmReset = true;
      setTimeout(() => (confirmReset = false), 3500);
      return;
    }
    void scanner.reset();
  }
</script>

{#if scanner.phase === "loading"}
  <div class="center-note">Loading…</div>
{:else if scanner.phase === "unprovisioned" || (scanner.phase === "provisioning" && !scanner.pack)}
  <ProvisionScreen />
{:else if scanner.pack}
  <div class="shell">
    <header>
      <div class="title">
        <span class="event">{scanner.pack.eventTitle}</span>
        <span class="stats">
          <strong>{scanner.checkedInCount}</strong> / {scanner.totalCapacity} in
          {#if scanner.pendingCount > 0}· {scanner.pendingCount} unsynced{/if}
        </span>
      </div>
      <div class="header-actions">
        <span class="dot" class:on={scanner.online} title={scanner.online ? "Online" : "Offline"}></span>
        <button class="icon-btn" onclick={() => void refresh()} disabled={refreshing || !scanner.online} title="Refresh event data">
          {refreshing ? "…" : "↻"}
        </button>
        <button class="icon-btn danger" onclick={resetTap} title="Reset this device">
          {confirmReset ? "Sure?" : "⏏"}
        </button>
      </div>
    </header>

    {#if scanner.passDead}
      <div class="banner dead">{scanner.passDead}. Scans still record locally — re-provision with a new pass to sync.</div>
    {:else if !scanner.online}
      <div class="banner offline">Offline — scans are verified locally and will sync when back online.</div>
    {/if}
    {#if scanner.conflicts.length > 0}
      <div class="banner conflict">
        ⚠ {scanner.conflicts.length} ticket{scanner.conflicts.length === 1 ? "" : "s"} accepted on two devices while
        offline — check with the door team.
      </div>
    {/if}

    <main>
      {#if tab === "scan"}
        <ScanScreen />
      {:else}
        <RosterScreen />
      {/if}
    </main>

    <nav>
      <button class:active={tab === "scan"} onclick={() => (tab = "scan")}>Scan</button>
      <button class:active={tab === "roster"} onclick={() => (tab = "roster")}>
        Attendees{scanner.roster.length ? ` (${scanner.roster.length})` : ""}
      </button>
    </nav>
  </div>
{/if}

<style>
  .center-note {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
  }
  .shell {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.65rem 0.85rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
  }
  .title {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }
  .event {
    font-weight: 700;
    font-size: 0.9875rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .stats {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    color: var(--text-muted);
  }
  .stats strong {
    color: var(--accent);
  }
  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--text-dim);
  }
  .dot.on {
    background: var(--accent);
  }
  .icon-btn {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text);
    font-size: 0.9rem;
    padding: 0.35rem 0.6rem;
  }
  .icon-btn:disabled {
    opacity: 0.4;
  }
  .icon-btn.danger {
    color: var(--error);
  }
  .banner {
    padding: 0.5rem 0.85rem;
    font-size: 0.8125rem;
    line-height: 1.4;
  }
  .banner.offline {
    background: var(--warning-subtle);
    color: var(--warning);
  }
  .banner.dead {
    background: var(--error-subtle);
    color: var(--error);
  }
  .banner.conflict {
    background: var(--warning-subtle);
    color: var(--warning);
  }
  main {
    flex: 1;
    min-height: 0;
    position: relative;
  }
  nav {
    display: flex;
    border-top: 1px solid var(--border);
    background: var(--bg-surface);
    padding-bottom: env(safe-area-inset-bottom);
  }
  nav button {
    flex: 1;
    background: none;
    border: none;
    color: var(--text-muted);
    font-weight: 700;
    font-size: 0.9375rem;
    padding: 0.85rem 0;
    border-top: 2px solid transparent;
  }
  nav button.active {
    color: var(--accent);
    border-top-color: var(--accent);
  }
</style>
