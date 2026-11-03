<script lang="ts">
  /**
   * Where a signed ticket change stands, with "Cancel" while it is still saving
   * (`lib/ledger2/organiser-changes.ts`). Plain words only: no mention of how the
   * change is recorded.
   */
  import type { ChangePhase } from "../../ledger2/organiser-changes.js";

  interface Props {
    phase: ChangePhase | null;
    oncancel: () => void;
    /** What was being changed, for the sentences: "ticket numbers", "end date". */
    what?: string;
  }

  let { phase, oncancel, what = "change" }: Props = $props();
</script>

{#if phase}
  <div class="status" class:ok={phase.phase === "saved" || phase.phase === "cancelled"} class:bad={phase.phase === "failed"} role="status">
    {#if phase.phase === "saving"}
      <span>Saving your {what}…</span>
      <button class="cancel" onclick={oncancel}>Cancel</button>
    {:else if phase.phase === "cancelling"}
      <span>Cancelling…</span>
    {:else if phase.phase === "saved"}
      <span>Saved.</span>
    {:else if phase.phase === "partly_saved"}
      <span>Saved for some ticket types. The others were changed on another device first - reload to see the latest.</span>
    {:else if phase.phase === "cancelled"}
      <span>Cancelled - nothing was changed.</span>
    {:else if phase.phase === "already_saved"}
      <span>Too late to cancel - your {what} had already saved.</span>
    {:else if phase.phase === "changed_elsewhere"}
      <span>This event was changed on another device in the meantime. Reload to see the latest, then try again.</span>
    {:else if phase.phase === "failed"}
      <span>{phase.message}</span>
    {/if}
  </div>
{/if}

<style>
  .status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 0.625rem 0.875rem;
  }

  .status.ok {
    color: var(--accent-text);
  }

  .status.bad {
    color: var(--error);
    border-color: var(--error-subtle);
  }

  .cancel {
    flex-shrink: 0;
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font: inherit;
    font-weight: 500;
    padding: 0.3rem 0.75rem;
    cursor: pointer;
  }

  .cancel:hover {
    border-color: var(--border-hover);
  }
</style>
