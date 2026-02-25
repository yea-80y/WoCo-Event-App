<script lang="ts">
  import { auth } from "./lib/auth/auth-store.svelte.js";
  import { loginRequest } from "./lib/auth/login-request.svelte.js";
  import { onMount } from "svelte";
  import SiteLoginModal from "./lib/components/site/SiteLoginModal.svelte";
  import SigningConfirmDialog from "./lib/components/auth/SigningConfirmDialog.svelte";
  import SessionStatus from "./lib/components/auth/SessionStatus.svelte";
  import EventPage from "./lib/components/site/EventPage.svelte";
  import Dashboard from "./lib/components/dashboard/Dashboard.svelte";

  const EVENT_ID = import.meta.env.VITE_EVENT_ID || "";

  let route = $state(parseRoute());

  function parseRoute(): string {
    const hash = window.location.hash.replace(/^#/, "") || "/";
    if (hash === "/dashboard") return "dashboard";
    return "event";
  }

  onMount(() => {
    auth.init();
    window.addEventListener("hashchange", () => {
      route = parseRoute();
    });
  });
</script>

<main>
  <header class="top-bar">
    <div class="logo">
      <span>Events</span>
    </div>

    <div class="top-right">
      {#if !auth.ready}
        <span class="loading">Loading...</span>
      {:else if auth.isConnected}
        <SessionStatus />
      {:else}
        <button class="sign-in-btn" onclick={() => loginRequest.request()}>
          Sign in
        </button>
      {/if}
    </div>
  </header>

  <section class="content">
    {#if !EVENT_ID}
      <p class="config-error">
        Event not configured. Set <code>VITE_EVENT_ID</code> in your .env.site file.
      </p>
    {:else if route === "event"}
      <EventPage eventId={EVENT_ID} ondashboard={() => { window.location.hash = "#/dashboard"; }} />
    {:else if route === "dashboard"}
      <Dashboard eventId={EVENT_ID} />
    {/if}
  </section>
</main>

<SiteLoginModal />
<SigningConfirmDialog />

<style>
  main {
    max-width: 840px;
    margin: 0 auto;
    padding: 0 1.25rem 3rem;
  }

  .top-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.875rem 0;
    border-bottom: 1px solid var(--border);
    margin-bottom: 1.5rem;
    gap: 0.75rem;
  }

  .logo {
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.02em;
    flex-shrink: 0;
  }

  .top-right {
    display: flex;
    align-items: center;
    min-width: 0;
    overflow: hidden;
    flex-shrink: 1;
  }

  .sign-in-btn {
    padding: 0.4375rem 0.875rem;
    font-size: 0.8125rem;
    font-weight: 500;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    transition: all var(--transition);
    white-space: nowrap;
  }

  .sign-in-btn:hover {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }

  .loading {
    color: var(--text-muted);
    font-size: 0.8125rem;
  }

  .content {
    padding: 0.25rem 0 2rem;
  }

  .config-error {
    text-align: center;
    color: var(--error);
    padding: 3rem 0;
    font-size: 0.9375rem;
  }

  .config-error code {
    font-family: monospace;
    background: var(--bg-elevated);
    padding: 0.125rem 0.375rem;
    border-radius: 4px;
  }
</style>
