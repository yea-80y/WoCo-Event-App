<script lang="ts">
  import type { Snippet } from "svelte";
  import { auth } from "../auth/auth-store.svelte.js";
  import { loginRequest } from "../auth/login-request.svelte.js";
  import { router, navigate } from "../router/router.svelte.js";
  import SessionStatus from "../components/auth/SessionStatus.svelte";
  import UserAvatar from "../components/profile/UserAvatar.svelte";

  interface Props {
    children: Snippet;
  }
  let { children }: Props = $props();
</script>

<main>
  <header class="top-bar">
    <button class="logo" onclick={() => navigate("/")}>
      <img src="./logo.png" alt="WoCo" class="logo-img" />
      <span>WoCo</span>
    </button>

    <div class="top-right">
      {#if !auth.ready}
        <span class="loading">Loading...</span>
      {:else if auth.isConnected && auth.parent}
        <button class="surface-toggle" onclick={() => navigate("/creator")} title="Go to creator portal">
          <span class="surface-toggle-label">Creator portal</span>
          <span class="surface-toggle-arrow">→</span>
        </button>
        <SessionStatus />
        <button class="top-avatar-btn" onclick={() => navigate(`/profile/${auth.parent!.toLowerCase()}`)}>
          <UserAvatar address={auth.parent} size={28} />
        </button>
      {:else}
        <button class="sign-in-btn" onclick={() => loginRequest.request()}>
          Sign in
        </button>
      {/if}
    </div>
  </header>

  <section class="content">
    {@render children()}
  </section>

  <nav class="bottom-nav">
    <button
      class="bottom-nav-item"
      class:active={router.route === "home"}
      onclick={() => navigate("/")}
    >
      <span class="nav-icon">&#127968;</span>
      <span class="nav-label">Events</span>
    </button>
    {#if auth.isConnected}
      <button
        class="bottom-nav-item"
        class:active={router.route === "my-tickets"}
        onclick={() => navigate("/tickets")}
      >
        <span class="nav-icon">&#127903;</span>
        <span class="nav-label">Tickets</span>
      </button>
      <button
        class="bottom-nav-item profile-nav-item"
        class:active={router.route === "profile"}
        onclick={() => navigate(auth.parent ? `/profile/${auth.parent.toLowerCase()}` : "/profile")}
      >
        <span class="nav-avatar">
          <UserAvatar address={auth.parent!} size={24} />
        </span>
        <span class="nav-label">Profile</span>
      </button>
    {/if}
  </nav>
</main>

<style>
  main {
    max-width: 840px;
    margin: 0 auto;
    padding: 0 1.25rem;
    padding-bottom: 4.5rem;
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
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.02em;
    flex-shrink: 0;
  }
  .logo:hover { color: var(--accent-text); }
  .logo-img { width: 26px; height: 26px; border-radius: 4px; }

  .top-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    overflow: hidden;
    flex-shrink: 1;
  }

  .surface-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.3125rem 0.625rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    transition: all var(--transition);
    white-space: nowrap;
  }
  .surface-toggle:hover {
    color: var(--accent-text);
    border-color: var(--accent);
  }
  .surface-toggle-arrow { font-size: 0.875rem; line-height: 1; }

  @media (max-width: 480px) {
    .surface-toggle-label { display: none; }
    .surface-toggle { padding: 0.3125rem 0.5rem; }
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
  .sign-in-btn:hover { background: var(--accent); border-color: var(--accent); color: #fff; }

  .top-avatar-btn {
    margin-left: 0.375rem;
    border-radius: 50%;
    flex-shrink: 0;
    transition: opacity var(--transition), box-shadow var(--transition);
    line-height: 0;
  }
  .top-avatar-btn:hover { opacity: 0.85; box-shadow: 0 0 0 2px var(--accent-subtle); }

  .loading { color: var(--text-muted); font-size: 0.8125rem; }
  .content { padding: 0.25rem 0 2rem; }

  .bottom-nav {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    display: flex;
    justify-content: center;
    gap: 0;
    background: var(--bg-elevated);
    border-top: 1px solid var(--border);
    padding: 0.375rem 0;
    padding-bottom: max(0.375rem, env(safe-area-inset-bottom));
    z-index: 100;
    flex-wrap: nowrap;
  }
  .bottom-nav-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.125rem;
    padding: 0.375rem 0.75rem;
    border-radius: var(--radius-sm);
    transition: all var(--transition);
    min-width: 0;
    flex: 1;
    max-width: 5rem;
  }
  .bottom-nav-item:hover { background: var(--accent-subtle); }
  .bottom-nav-item.active { color: var(--accent-text); }
  .bottom-nav-item:not(.active) { color: var(--text-muted); }
  .nav-icon { font-size: 1.25rem; line-height: 1; }
  .nav-label { font-size: 0.625rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .nav-avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    line-height: 1;
  }
  .profile-nav-item.active .nav-avatar :global(.avatar) { box-shadow: 0 0 0 2px var(--accent); }

  @media (min-width: 640px) {
    .bottom-nav-item { padding: 0.375rem 1.75rem; }
    main { padding-bottom: 5rem; }
  }
</style>
