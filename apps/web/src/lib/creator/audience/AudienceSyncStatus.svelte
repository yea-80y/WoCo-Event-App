<script lang="ts">
  /**
   * Buyers who said yes at checkout join the list by themselves
   * (`audience-sync.ts`). This says so, says when it last looked and what it
   * found, and offers one button. Errors from a background check are shown here
   * and nowhere else.
   */
  import { onDestroy, onMount } from "svelte";
  import { audienceSync, syncAudience } from "./audience-sync.svelte.js";
  import { describeSync } from "./audience-sync.js";

  let now = $state(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    timer = setInterval(() => (now = Date.now()), 30_000);
  });
  onDestroy(() => clearInterval(timer));

  const line = $derived(describeSync(audienceSync.record, audienceSync.running, now));

  function checkNow(): void {
    now = Date.now();
    void syncAudience({ force: true });
  }
</script>

<section class="sync" class:warn={line.warn} aria-label="Ticket buyers who said yes">
  <p class="lede">
    Buyers who said yes to your emails at checkout are added automatically - those who ticked
    "Email me", and, if you only email about your own events, those who didn't tick
    "Don't email me". Anyone who said no, or who you delete, stays off your list.
  </p>
  <div class="row">
    <p class="state" role="status">{line.text}</p>
    <button class="btn-ghost sm" disabled={audienceSync.running} onclick={checkNow}>
      {audienceSync.running ? "Checking…" : "Check now"}
    </button>
  </div>
</section>

<style>
  .sync {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-surface);
    padding: 0.875rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .lede {
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.55;
    color: var(--text-secondary);
    max-width: 62ch;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .state {
    margin: 0;
    flex: 1;
    min-width: 12rem;
    font-size: 0.8125rem;
    line-height: 1.5;
    color: var(--text-muted);
  }
  .sync.warn { border-left: 3px solid var(--warning); }
  .sync.warn .state { color: var(--text); }

  .btn-ghost {
    border: 1px solid var(--border);
    color: var(--text-secondary);
    border-radius: var(--radius-md);
    transition: border-color var(--transition), color var(--transition);
  }
  .btn-ghost:hover:not(:disabled) { border-color: var(--border-hover); color: var(--text); }
  .btn-ghost:disabled { opacity: 0.4; }
  .btn-ghost.sm { font-size: 0.8125rem; padding: 0.375rem 0.75rem; }
</style>
