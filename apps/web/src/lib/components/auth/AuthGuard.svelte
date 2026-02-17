<script lang="ts">
  import type { Snippet } from "svelte";
  import { auth } from "../../auth/auth-store.svelte.js";
  import { loginRequest } from "../../auth/login-request.svelte.js";

  interface Props {
    children: Snippet;
    fallback?: Snippet;
  }

  let { children, fallback }: Props = $props();
</script>

{#if auth.isConnected}
  {@render children()}
{:else if fallback}
  {@render fallback()}
{:else}
  <div class="auth-guard">
    <p>You need to sign in to access this.</p>
    <button class="sign-in-btn" onclick={() => loginRequest.request()}>
      Sign in
    </button>
  </div>
{/if}

<style>
  .auth-guard {
    text-align: center;
    padding: 2rem;
    color: var(--text-muted);
  }

  .sign-in-btn {
    margin-top: 0.5rem;
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    transition: all var(--transition);
  }

  .sign-in-btn:hover {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
</style>
