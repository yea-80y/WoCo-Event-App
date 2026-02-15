<script lang="ts">
  import { auth } from "./lib/auth/auth-store.svelte.js";
  import { router, navigate } from "./lib/router/router.svelte.js";
  import LoginModal from "./lib/components/auth/LoginModal.svelte";
  import SessionStatus from "./lib/components/auth/SessionStatus.svelte";
  import EventList from "./lib/components/events/EventList.svelte";
  import EventForm from "./lib/components/events/EventForm.svelte";
  import EventDetail from "./lib/components/events/EventDetail.svelte";
  import { onMount } from "svelte";

  let showLogin = $state(false);

  onMount(() => {
    auth.init();
  });
</script>

<main>
  <header class="top-bar">
    <button class="logo-text" onclick={() => navigate("/")}>WoCo</button>
    <nav>
      <button class="nav-link" onclick={() => navigate("/create")}>
        + Create Event
      </button>
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
    {#if router.route === "home"}
      <EventList onselect={(id) => navigate(`/event/${id}`)} />
    {:else if router.route === "create"}
      <EventForm onpublished={(id) => navigate(`/event/${id}`)} />
    {:else if router.route === "event"}
      <EventDetail
        eventId={router.params.id}
        onback={() => navigate("/")}
      />
    {/if}
  </section>
</main>

<LoginModal bind:open={showLogin} />

<style>
  main {
    max-width: 800px;
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
    font-weight: 700;
    color: #e2e8f0;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
  }

  .logo-text:hover {
    color: #818cf8;
  }

  nav {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .nav-link {
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: #818cf8;
    cursor: pointer;
  }

  .nav-link:hover {
    background: rgba(79, 70, 229, 0.1);
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
</style>
