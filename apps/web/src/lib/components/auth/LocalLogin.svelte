<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";
  import { restoreLocalAccount } from "../../auth/local-account.js";
  import { onMount } from "svelte";

  interface Props {
    oncomplete?: () => void;
  }

  let { oncomplete }: Props = $props();
  let error = $state<string | null>(null);
  let hasExisting = $state(false);

  onMount(async () => {
    const existing = await restoreLocalAccount();
    hasExisting = existing !== null;
  });

  async function handleLogin() {
    error = null;
    const ok = await auth.login("local");
    if (ok) {
      oncomplete?.();
    } else {
      error = "Failed to create local account.";
    }
  }
</script>

<div class="local-login">
  <button
    class="local-btn"
    onclick={handleLogin}
    disabled={auth.busy}
  >
    {#if auth.busy}
      Setting up...
    {:else if hasExisting}
      Use Local Account
    {:else}
      Create Local Account
    {/if}
  </button>
  <p class="hint">No wallet needed. Keys stored in this browser only.</p>
  {#if error}
    <p class="error">{error}</p>
  {/if}
</div>

<style>
  .local-login {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.5rem;
  }

  .local-btn {
    padding: 0.75rem;
    font-size: 0.9375rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    color: var(--text);
    border: 1px solid var(--border);
    transition: all var(--transition);
  }

  .local-btn:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent-text);
  }

  .local-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .hint {
    color: var(--text-muted);
    font-size: 0.75rem;
    text-align: center;
    margin: 0;
  }

  .error {
    color: var(--error);
    font-size: 0.875rem;
    margin: 0;
    text-align: center;
  }
</style>
