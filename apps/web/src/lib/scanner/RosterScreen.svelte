<script lang="ts">
  /**
   * Attendee list — search + manual check-in. Manual check-in is
   * two-tap-to-confirm because the nullifier set is monotone: once synced, a
   * check-in can't be undone (by design — un-checking would reopen the door
   * for a forwarded QR).
   */
  import { scanner } from "./store.svelte.js";
  import type { RosterEntry } from "@woco/shared";

  let search = $state("");
  let confirming = $state<string | null>(null);
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;
  /** Why the last manual check-in did not go through - with several scanners it
   *  can fail for want of signal, and a tap that does nothing reads as "done". */
  let notice = $state<string | null>(null);
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;

  const filtered = $derived.by(() => {
    const q = search.trim().toLowerCase();
    const entries = [...scanner.roster].sort(
      (a, b) => a.seriesId.localeCompare(b.seriesId) || a.edition - b.edition,
    );
    if (!q) return entries;
    return entries.filter(
      (r) =>
        r.name?.toLowerCase().includes(q) ||
        r.email?.toLowerCase().includes(q) ||
        String(r.edition) === q.replace(/^#/, "") ||
        Object.values(r.fields ?? {}).some((v) => v.toLowerCase().includes(q)),
    );
  });

  function key(r: RosterEntry): string {
    return `${r.seriesId} ${r.edition}`;
  }

  function seriesName(seriesId: string): string {
    return scanner.pack?.series.find((s) => s.seriesId === seriesId)?.name ?? "";
  }

  function tapCheckin(r: RosterEntry): void {
    const k = key(r);
    if (confirming !== k) {
      confirming = k;
      if (confirmTimer) clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => (confirming = null), 3500);
      return;
    }
    confirming = null;
    void manualCheckin(r);
  }

  async function manualCheckin(r: RosterEntry): Promise<void> {
    let message: string | null = null;
    try {
      const result = await scanner.manualCheckin(r.seriesId, r.edition);
      if (result.kind === "cant-confirm") message = `Not checked in - ${result.message}`;
      else if (result.kind === "refunded") message = "Not checked in - this ticket was refunded";
      else if (result.kind === "duplicate") message = `Already in since ${formatTime(result.record.at)}`;
    } catch {
      message = "Not checked in - something went wrong on this phone, try again";
    }
    notice = message;
    if (noticeTimer) clearTimeout(noticeTimer);
    if (message) noticeTimer = setTimeout(() => (notice = null), 5000);
  }

  function formatTime(iso: string): string {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return iso;
    }
  }
</script>

<div class="roster">
  <input
    class="search"
    bind:value={search}
    placeholder="Search name, email or ticket #"
    autocapitalize="off"
    autocomplete="off"
    spellcheck="false"
  />

  {#if scanner.claiming}
    <p class="notice" aria-live="polite">Checking with WoCo…</p>
  {:else if notice}
    <p class="notice warn" aria-live="polite">{notice}</p>
  {/if}

  {#if scanner.roster.length === 0}
    <div class="empty">
      <p>No attendee list on this device.</p>
      <p class="hint">
        The organiser pushes it from the event dashboard ("Door check-in" panel), then tap
        refresh in the top bar. Scanning works without it — you just won't see names.
      </p>
    </div>
  {:else if filtered.length === 0}
    <div class="empty"><p>No match for “{search}”.</p></div>
  {:else}
    <ul>
      {#each filtered as entry (key(entry))}
        {@const record = scanner.isCheckedIn(entry.seriesId, entry.edition)}
        <li>
          <div class="who">
            <span class="name">{entry.name || entry.email || `Ticket #${entry.edition}`}</span>
            <span class="meta">
              {seriesName(entry.seriesId)} · #{String(entry.edition).padStart(3, "0")}
              {#if entry.name && entry.email}· {entry.email}{/if}
            </span>
          </div>
          {#if record}
            <span class="pill in">✓ {formatTime(record.at)}{record.method === "manual" ? " ·M" : ""}</span>
          {:else if scanner.isRefunded(entry.seriesId, entry.edition)}
            <span class="pill refunded">Refunded</span>
          {:else if scanner.claiming}
            <span class="pill action">…</span>
          {:else if confirming === key(entry)}
            <button class="pill confirm" onclick={() => tapCheckin(entry)}>Tap to confirm</button>
          {:else}
            <button class="pill action" onclick={() => tapCheckin(entry)}>Check in</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .roster {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .search {
    margin: 0.75rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text);
    padding: 0.7rem 0.85rem;
    font-size: 1rem;
  }
  .search:focus {
    outline: none;
    border-color: var(--accent);
  }
  ul {
    flex: 1;
    overflow-y: auto;
    list-style: none;
    margin: 0;
    padding: 0 0.75rem 1rem;
  }
  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.7rem 0.25rem;
    border-bottom: 1px solid var(--border);
  }
  .who {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }
  .name {
    font-weight: 600;
    font-size: 0.9875rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    color: var(--text-muted);
    font-size: 0.8125rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pill {
    flex-shrink: 0;
    border-radius: var(--radius-sm);
    font-size: 0.8125rem;
    font-weight: 700;
    padding: 0.45rem 0.7rem;
    border: none;
  }
  .pill.in {
    background: var(--accent-subtle);
    color: var(--accent);
    font-family: var(--font-mono);
  }
  .pill.action {
    background: var(--bg-elevated);
    color: var(--text);
    border: 1px solid var(--border-hover);
  }
  .pill.confirm {
    background: var(--warning);
    color: #1a1200;
  }
  .pill.refunded {
    background: var(--error-subtle);
    color: var(--error);
  }
  .notice {
    margin: 0 0.75rem 0.5rem;
    padding: 0.55rem 0.75rem;
    border-radius: var(--radius-md);
    background: var(--bg-elevated);
    color: var(--text-secondary);
    font-size: 0.875rem;
  }
  .notice.warn {
    background: var(--warning-subtle);
    color: var(--warning);
  }
  .empty {
    padding: 2rem 1.25rem;
    text-align: center;
    color: var(--text-secondary);
  }
  .empty .hint {
    font-size: 0.85rem;
    color: var(--text-muted);
  }
</style>
