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
  <header class="top-bar">
    <button class="logo" onclick={() => navigate("/")}>
      <img src="./logo.png" alt="WoCo" class="logo-img" />
      <span>WoCo</span>
    </button>
    <nav>
      <button class="nav-link" onclick={() => navigate("/create")}>
        + Create Event
      </button>
      {#if auth.isConnected}
        <button class="nav-link" onclick={() => navigate("/my-tickets")}>
          My Tickets
        </button>
        <button class="nav-link" onclick={() => navigate("/dashboard")}>
          Dashboard
        </button>
      {/if}
      {#if !auth.ready}
        <span class="loading">Loading...</span>
      {:else if auth.isConnected}
        <SessionStatus />
      {:else}
        <button class="sign-in-btn" onclick={() => loginRequest.request()}>
          Sign in
        </button>
      {/if}
    </nav>
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
</main>

<LoginModal />
<SigningConfirmDialog />

<style>
  main {
    max-width: 840px;
    margin: 0 auto;
    padding: 0 1.25rem;
  }

  .top-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1.25rem 0;
    border-bottom: 1px solid var(--border);
    margin-bottom: 2rem;
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 1.375rem;
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.02em;
  }

  .logo:hover {
    color: var(--accent-text);
  }

  .logo-img {
    width: 28px;
    height: 28px;
    border-radius: 4px;
  }

  nav {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .nav-link {
    padding: 0.5rem 0.875rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--accent-text);
    border-radius: var(--radius-sm);
    transition: background var(--transition);
  }

  .nav-link:hover {
    background: var(--accent-subtle);
  }

  .sign-in-btn {
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

  .loading {
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .content {
    padding: 0.5rem 0 3rem;
  }
</style>
