<script lang="ts">
  import { auth } from "./lib/auth/auth-store.svelte.js";
  import { loginRequest } from "./lib/auth/login-request.svelte.js";
  import { router, navigate } from "./lib/router/router.svelte.js";
  import LoginModal from "./lib/components/auth/LoginModal.svelte";
  import SessionStatus from "./lib/components/auth/SessionStatus.svelte";
  import SigningConfirmDialog from "./lib/components/auth/SigningConfirmDialog.svelte";
  import EventForm from "./lib/components/events/EventForm.svelte";
  import EventDetail from "./lib/components/events/EventDetail.svelte";
  import MyTickets from "./lib/components/passport/MyTickets.svelte";
  import EmbedSetup from "./lib/components/embed/EmbedSetup.svelte";
  import Dashboard from "./lib/components/dashboard/Dashboard.svelte";
  import DashboardIndex from "./lib/components/dashboard/DashboardIndex.svelte";
  import Home from "./lib/components/home/Home.svelte";
  import { onMount } from "svelte";

  onMount(() => {
    auth.init();
  });


</script>

<main>
  <!-- Top bar: logo + auth only -->
  <header class="top-bar">
    <button class="logo" onclick={() => navigate("/")}>
      <img src="./logo.png" alt="WoCo" class="logo-img" />
      <span>WoCo</span>
    </button>

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
    {#if router.route === "home"}
      <Home />
    {:else if router.route === "create"}
      <EventForm onpublished={(id) => navigate(`/event/${id}`)} />
    {:else if router.route === "event"}
      <EventDetail
        eventId={router.params.id}
        onback={() => navigate("/")}
      />
    {:else if router.route === "dashboard-index"}
      <DashboardIndex />
    {:else if router.route === "dashboard"}
      <Dashboard eventId={router.params.id} />
    {:else if router.route === "my-tickets"}
      <MyTickets />
    {:else if router.route === "embed-setup"}
      <EmbedSetup eventId={router.params.id} />
    {/if}
  </section>

  <!-- Bottom nav bar -->
  <nav class="bottom-nav">
    <button
      class="bottom-nav-item"
      class:active={router.route === "home"}
      onclick={() => navigate("/")}
    >
      <span class="nav-icon">&#127968;</span>
      <span class="nav-label">Home</span>
    </button>
    <button
      class="bottom-nav-item"
      class:active={router.route === "create"}
      onclick={() => navigate("/create")}
    >
      <span class="nav-icon">&#43;</span>
      <span class="nav-label">Create</span>
    </button>
    {#if auth.isConnected}
      <button
        class="bottom-nav-item"
        class:active={router.route === "my-tickets"}
        onclick={() => navigate("/my-tickets")}
      >
        <span class="nav-icon">&#127903;</span>
        <span class="nav-label">Tickets</span>
      </button>
      <button
        class="bottom-nav-item"
        class:active={router.route === "dashboard-index" || router.route === "dashboard"}
        onclick={() => navigate("/dashboard")}
      >
        <span class="nav-icon">&#128202;</span>
        <span class="nav-label">Dashboard</span>
      </button>
    {/if}
  </nav>
</main>

<LoginModal />
<SigningConfirmDialog />

<style>
  main {
    max-width: 840px;
    margin: 0 auto;
    padding: 0 1.25rem;
    padding-bottom: 4.5rem; /* space for bottom nav */
  }

  /* Top bar — minimal: logo + auth */
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
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.02em;
    flex-shrink: 0;
  }

  .logo:hover {
    color: var(--accent-text);
  }

  .logo-img {
    width: 26px;
    height: 26px;
    border-radius: 4px;
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

  /* Bottom nav */
  .bottom-nav {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    display: flex;
    justify-content: center;
    gap: 0;
    background: var(--bg-elevated);
    border-top: 1px solid var(--border);
    padding: 0.375rem 0;
    padding-bottom: max(0.375rem, env(safe-area-inset-bottom));
    z-index: 100;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }

  .bottom-nav-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.125rem;
    padding: 0.375rem 1.25rem;
    border-radius: var(--radius-sm);
    transition: all var(--transition);
    min-width: 4rem;
  }

  .bottom-nav-item:hover {
    background: var(--accent-subtle);
  }

  .bottom-nav-item.active {
    color: var(--accent-text);
  }

  .bottom-nav-item:not(.active) {
    color: var(--text-muted);
  }

  .nav-icon {
    font-size: 1.25rem;
    line-height: 1;
  }

  .nav-label {
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* Desktop: wider bottom nav items */
  @media (min-width: 640px) {
    .bottom-nav-item {
      padding: 0.375rem 1.75rem;
    }

    main {
      padding-bottom: 5rem;
    }
  }
</style>
