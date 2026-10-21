<script lang="ts">
  import { passkeyWindowSheet } from "../../auth/passkey-window-sheet.svelte.js";

  /**
   * The tap a passkey window needs when nothing on screen was just tapped for it
   * (passkey-window.ts): a browser opens a window only inside a click. Continue opens
   * it in this click; the passkey itself is used in the window.
   */

  const COPY: Record<string, string> = {
    signin: "Sign in with your passkey",
    restore: "Confirm it's you",
    create: "Create your passkey",
    add: "Add a passkey",
    "backup-create": "Create a backup passkey",
    "backup-get": "Use your backup passkey",
  };

  const pending = $derived(passkeyWindowSheet.pending);
  let goEl = $state<HTMLButtonElement | null>(null);

  $effect(() => {
    if (pending) goEl?.focus();
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && passkeyWindowSheet.pending) passkeyWindowSheet.dismiss();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if pending}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="backdrop" role="presentation" onclick={() => passkeyWindowSheet.dismiss()}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="passkey-window-title" tabindex="-1" onclick={(e) => e.stopPropagation()}>
      <h2 id="passkey-window-title">{COPY[pending.action] ?? "Use your passkey"}</h2>
      {#if pending.blocked}
        <p class="body blocked">Your browser blocked the passkey window. Allow pop-ups for this site, or tap Continue again.</p>
      {:else}
        <p class="body">WoCo opens a small window to use your passkey.</p>
      {/if}
      <div class="actions">
        <button class="cancel-btn" onclick={() => passkeyWindowSheet.dismiss()}>Cancel</button>
        <button class="go-btn" bind:this={goEl} onclick={() => passkeyWindowSheet.proceed()}>Continue</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1100;
  }

  .modal {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 1.75rem;
    width: min(400px, calc(100vw - 2rem));
  }

  h2 {
    margin: 0 0 0.75rem;
    font-family: var(--font-display);
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--text);
  }

  .body {
    margin: 0 0 1.25rem;
    font-size: 0.8125rem;
    line-height: 1.55;
    color: var(--text-secondary);
  }

  .blocked {
    color: var(--error);
  }

  .actions {
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
  }

  .cancel-btn {
    padding: 0.625rem 1.25rem;
    font-size: 0.875rem;
    font-weight: 500;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    transition: all var(--transition);
  }

  .cancel-btn:hover {
    border-color: var(--text-secondary);
    color: var(--text);
  }

  .go-btn {
    padding: 0.625rem 1.25rem;
    font-size: 0.875rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: var(--accent-ink);
  }
</style>
