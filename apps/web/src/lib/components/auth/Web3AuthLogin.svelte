<script lang="ts">
  import { auth } from "../../auth/auth-store.svelte.js";

  interface Props {
    oncomplete?: () => void;
  }

  let { oncomplete }: Props = $props();

  let error = $state<string | null>(null);

  async function login() {
    error = null;
    try {
      const ok = await auth.loginWeb3Auth();
      if (ok) oncomplete?.();
      else error = "Sign-in failed — please try again.";
    } catch (e: unknown) {
      error = e instanceof Error ? e.message.slice(0, 120) : "Sign-in failed";
    }
  }
</script>

<div class="w3a-login">
  <button class="w3a-btn" onclick={login} disabled={auth.busy}>
    {#if auth.busy}
      <span class="spinner"></span>Connecting…
    {:else}
      Continue with Email
    {/if}
  </button>
  {#if error}
    <p class="error">{error}</p>
  {/if}
  <p class="hint">Sign in with email or Google — no extension needed</p>
</div>

<style>
  .w3a-login {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .w3a-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.75rem;
    font-size: 0.9375rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: var(--accent-ink);
    transition: background var(--transition);
  }

  .w3a-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .w3a-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .hint {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin: 0;
    text-align: center;
  }

  .error {
    color: var(--error);
    font-size: 0.875rem;
    margin: 0;
    text-align: center;
  }

  .spinner {
    width: 0.85rem;
    height: 0.85rem;
    flex: none;
    border: 2px solid color-mix(in srgb, var(--accent-ink) 35%, transparent);
    border-top-color: var(--accent-ink);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }
</style>
