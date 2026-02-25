<script lang="ts">
  import { auth } from "./lib/auth/auth-store.svelte.js";
  import { loginRequest } from "./lib/auth/login-request.svelte.js";
  import { onMount } from "svelte";
  import SiteLoginModal from "./lib/components/site/SiteLoginModal.svelte";
  import SigningConfirmDialog from "./lib/components/auth/SigningConfirmDialog.svelte";
  import SessionStatus from "./lib/components/auth/SessionStatus.svelte";
  import EventPage from "./lib/components/site/EventPage.svelte";
  import Dashboard from "./lib/components/dashboard/Dashboard.svelte";

  // Runtime config (injected by deploy endpoint) takes priority over build-time env vars
  const EVENT_ID =
    (typeof window !== "undefined" && window.SITE_CONFIG?.eventId) ||
    import.meta.env.VITE_EVENT_ID ||
    "";

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
  <!--
    Dashboard gets a full header with auth controls.
    The public event page has NO persistent auth UI — auth happens
    inline inside the ClaimButton flow when the attendee clicks "Get ticket".
  -->
  {#if route === "dashboard"}
    <header class="top-bar">
      <button class="logo-back" onclick={() => { window.location.hash = "#/"; }}>
        ← Event
      </button>
      <div class="top-right">
        {#if !auth.ready}
          <span class="loading">Loading…</span>
        {:else if auth.isConnected}
          <SessionStatus />
        {:else}
          <button class="sign-in-btn" onclick={() => loginRequest.request()}>Sign in</button>
        {/if}
      </div>
    </header>
  {/if}

  <section class="content">
    {#if !EVENT_ID}
      <p class="config-error">
        Event not configured. Set <code>VITE_EVENT_ID</code> in your <code>.env.site</code> file.
      </p>
    {:else if route === "event"}
      <EventPage eventId={EVENT_ID} ondashboard={() => { window.location.hash = "#/dashboard"; }} />
    {:else if route === "dashboard"}
      {#if !auth.ready}
        <div class="state-center">
          <div class="loader"></div>
        </div>
      {:else if !auth.isConnected}
        <div class="state-center">
          <p class="state-hint">Sign in to view the organizer dashboard.</p>
          <button class="sign-in-cta" onclick={() => loginRequest.request()}>Sign in</button>
        </div>
      {:else}
        <Dashboard eventId={EVENT_ID} />
      {/if}
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

  /* ── Dashboard header ────────────────────────────────────────────────────── */
  .top-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.875rem 0;
    border-bottom: 1px solid var(--border);
    margin-bottom: 1.5rem;
    gap: 0.75rem;
  }

  .logo-back {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text-muted);
    transition: color var(--transition);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .logo-back:hover {
    color: var(--text);
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

  .state-center {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 5rem 0;
    gap: 1.25rem;
  }

  .loader {
    width: 1.25rem;
    height: 1.25rem;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.75s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .state-hint {
    font-size: 0.9375rem;
    color: var(--text-muted);
    margin: 0;
  }

  .sign-in-cta {
    padding: 0.5625rem 1.5rem;
    font-size: 0.875rem;
    font-weight: 600;
    background: var(--accent);
    color: #fff;
    border-radius: var(--radius-sm);
    transition: background var(--transition);
  }

  .sign-in-cta:hover { background: var(--accent-hover); }

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
