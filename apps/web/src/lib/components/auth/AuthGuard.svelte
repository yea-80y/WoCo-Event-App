<script lang="ts">
  import type { Snippet } from "svelte";
  import { auth } from "../../auth/auth-store.svelte.js";
  import LoginModal from "./LoginModal.svelte";

  interface Props {
    children: Snippet;
    fallback?: Snippet;
  }

  let { children, fallback }: Props = $props();
  let showLogin = $state(false);
</script>

{#if auth.isConnected}
  {@render children()}
{:else if fallback}
  {@render fallback()}
{:else}
  <div class="auth-guard">
    <p>You need to sign in to access this.</p>
    <button class="sign-in-btn" onclick={() => showLogin = true}>
      Sign in
    </button>
  </div>
  <LoginModal bind:open={showLogin} />
{/if}

<style>
  .auth-guard {
    text-align: center;
    padding: 2rem;
    color: #9ca3af;
  }

  .sign-in-btn {
    margin-top: 0.5rem;
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    border: none;
    border-radius: 6px;
    background: #4f46e5;
    color: #fff;
    cursor: pointer;
  }

  .sign-in-btn:hover {
    background: #4338ca;
  }
</style>
