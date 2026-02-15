<script lang="ts">
  import { auth } from "./lib/auth/auth-store.svelte.js";
  import LoginModal from "./lib/components/auth/LoginModal.svelte";
  import SessionStatus from "./lib/components/auth/SessionStatus.svelte";
  import { onMount } from "svelte";

  let showLogin = $state(false);

  onMount(() => {
    auth.init();
  });
</script>

<main>
  <header class="top-bar">
    <h1 class="logo-text">WoCo</h1>
    <nav>
      {#if !auth.ready}
        <span class="loading">Loading...</span>
      {:else if auth.isAuthenticated}
        <SessionStatus />
      {:else}
        <button class="sign-in-btn" onclick={() => showLogin = true}>
          Sign in
        </button>
      {/if}
    </nav>
  </header>

  <section class="content">
    {#if !auth.ready}
      <p class="status">Initialising...</p>
    {:else if auth.isAuthenticated}
      <div class="authenticated">
        <h2>Connected</h2>
        <dl>
          <dt>Primary wallet</dt>
          <dd>{auth.parent}</dd>
          <dt>Session key</dt>
          <dd>{auth.sessionAddress}</dd>
          <dt>POD identity</dt>
          <dd>
            {#if auth.hasPodIdentity}
              {auth.podPublicKeyHex}
            {:else}
              <button class="derive-btn" onclick={() => auth.ensurePodIdentity()} disabled={auth.busy}>
                {auth.busy ? "Deriving..." : "Derive POD Identity"}
              </button>
              <span class="hint">Required for creating/claiming tickets</span>
            {/if}
          </dd>
        </dl>
      </div>
    {:else}
      <div class="welcome">
        <h2>Welcome to WoCo</h2>
        <p>Decentralized event platform built on Swarm and Ethereum.</p>
        <button class="cta-btn" onclick={() => showLogin = true}>
          Get Started
        </button>
      </div>
    {/if}
  </section>
</main>

<LoginModal bind:open={showLogin} />

<style>
  main {
    max-width: 720px;
    margin: 0 auto;
    padding: 1rem;
  }

  .top-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 0;
    border-bottom: 1px solid #2a2a4a;
    margin-bottom: 2rem;
  }

  .logo-text {
    margin: 0;
    font-size: 1.5rem;
    color: #e2e8f0;
  }

  .sign-in-btn {
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    border: 1px solid #4f46e5;
    border-radius: 6px;
    background: transparent;
    color: #818cf8;
    cursor: pointer;
    transition: all 0.15s;
  }

  .sign-in-btn:hover {
    background: #4f46e5;
    color: #fff;
  }

  .loading {
    color: #6b7280;
    font-size: 0.875rem;
  }

  .content {
    padding: 1rem 0;
  }

  .welcome {
    text-align: center;
    padding: 3rem 0;
  }

  .welcome h2 {
    color: #e2e8f0;
    margin-bottom: 0.5rem;
  }

  .welcome p {
    color: #9ca3af;
    margin-bottom: 1.5rem;
  }

  .cta-btn {
    padding: 0.75rem 2rem;
    font-size: 1rem;
    font-weight: 600;
    border: none;
    border-radius: 8px;
    background: #4f46e5;
    color: #fff;
    cursor: pointer;
  }

  .cta-btn:hover {
    background: #4338ca;
  }

  .authenticated h2 {
    color: #e2e8f0;
    margin-bottom: 1rem;
  }

  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.5rem 1rem;
  }

  dt {
    color: #9ca3af;
    font-size: 0.875rem;
    font-weight: 600;
  }

  dd {
    color: #e2e8f0;
    font-family: monospace;
    font-size: 0.8125rem;
    word-break: break-all;
    margin: 0;
  }

  .derive-btn {
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
    border: 1px solid #4f46e5;
    border-radius: 6px;
    background: transparent;
    color: #818cf8;
    cursor: pointer;
  }

  .derive-btn:hover:not(:disabled) {
    background: #4f46e5;
    color: #fff;
  }

  .derive-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .hint {
    display: block;
    color: #6b7280;
    font-size: 0.75rem;
    font-family: sans-serif;
    margin-top: 0.25rem;
  }

  .status {
    text-align: center;
    color: #6b7280;
  }
</style>
