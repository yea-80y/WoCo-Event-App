<script lang="ts">
  import type { Snippet } from "svelte";
  import { auth } from "../auth/auth-store.svelte.js";
  import { loginRequest } from "../auth/login-request.svelte.js";
  import { router, navigate } from "../router/router.svelte.js";
  import SessionStatus from "../components/auth/SessionStatus.svelte";
  import UserAvatar from "../components/profile/UserAvatar.svelte";
  import WocoWordmark from "../components/brand/WocoWordmark.svelte";
  import LayoutDashboard from "lucide-svelte/icons/layout-dashboard";
  import CalendarDays from "lucide-svelte/icons/calendar-days";
  import Plus from "lucide-svelte/icons/plus";
  import Monitor from "lucide-svelte/icons/monitor";
  import ShoppingBag from "lucide-svelte/icons/shopping-bag";
  import Layers from "lucide-svelte/icons/layers";
  import ArrowLeft from "lucide-svelte/icons/arrow-left";

  interface Props {
    children: Snippet;
  }
  let { children }: Props = $props();

  // Active-tab matchers — multiple legacy/canonical routes resolve to the same nav item.
  const isHome = $derived(router.route === "creator-home");
  const isEvents = $derived(
    router.route === "dashboard-index" ||
    router.route === "dashboard" ||
    router.route === "create" ||
    router.route === "embed-setup"
  );
  const isSites = $derived(router.route === "build" || router.route === "site-builder");
  const isPods = $derived(router.route === "creator-pods");
  const isProfile = $derived(router.route === "profile");

  let createOpen = $state(false);
  function create(path: string) {
    createOpen = false;
    navigate(path);
  }
</script>

<main>
  <header class="top-bar">
    <button class="logo" onclick={() => navigate("/")} aria-label="WoCo home">
      <WocoWordmark height={20} variant="default" />
      <span class="surface-badge">Studio</span>
    </button>

    <div class="top-right">
      {#if !auth.ready}
        <span class="loading">Loading...</span>
      {:else if auth.isConnected && auth.parent}
        <button class="surface-toggle" onclick={() => navigate("/")} title="Back to home">
          <span class="surface-toggle-arrow"><ArrowLeft size={14} strokeWidth={2.5} /></span>
          <span class="surface-toggle-label">Home</span>
        </button>
        <SessionStatus />
        <button class="top-avatar-btn" onclick={() => navigate(`/creator/profile/${auth.parent!.toLowerCase()}`)}>
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
    {#if auth.ready}
      {@render children()}
    {/if}
  </section>

  <nav class="bottom-nav">
    <button
      class="bottom-nav-item"
      class:active={isHome}
      onclick={() => navigate("/creator")}
    >
      <span class="nav-icon"><LayoutDashboard size={20} strokeWidth={2.25} /></span>
      <span class="nav-label">Studio</span>
    </button>
    <button
      class="bottom-nav-item"
      class:active={isEvents}
      onclick={() => navigate("/creator/events")}
    >
      <span class="nav-icon"><CalendarDays size={20} strokeWidth={2.25} /></span>
      <span class="nav-label">Events</span>
    </button>
    <button
      class="bottom-nav-item bottom-nav-item--accent"
      class:active={createOpen}
      aria-haspopup="menu"
      aria-expanded={createOpen}
      onclick={() => { createOpen = !createOpen; }}
    >
      <span class="nav-icon" class:rot={createOpen}><Plus size={20} strokeWidth={2.5} /></span>
      <span class="nav-label">Create</span>
    </button>
    <button
      class="bottom-nav-item"
      class:active={isSites}
      onclick={() => navigate("/creator/sites")}
    >
      <span class="nav-icon"><Monitor size={20} strokeWidth={2.25} /></span>
      <span class="nav-label">Sites</span>
    </button>
    <button
      class="bottom-nav-item"
      class:active={isPods}
      onclick={() => navigate("/creator/pods")}
    >
      <span class="nav-icon"><Layers size={20} strokeWidth={2.25} /></span>
      <span class="nav-label">PODs</span>
    </button>
    {#if auth.isConnected}
      <button
        class="bottom-nav-item profile-nav-item"
        class:active={isProfile}
        onclick={() => navigate(auth.parent ? `/creator/profile/${auth.parent.toLowerCase()}` : "/creator/profile")}
      >
        <span class="nav-avatar">
          <UserAvatar address={auth.parent!} size={24} />
        </span>
        <span class="nav-label">Profile</span>
      </button>
    {/if}
  </nav>

  {#if createOpen}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <button class="create-scrim" aria-label="Close create menu" onclick={() => { createOpen = false; }}></button>
    <div class="create-sheet" role="menu">
      <button class="create-opt" role="menuitem" onclick={() => create("/creator/events/new")}>
        <span class="opt-ic"><CalendarDays size={16} strokeWidth={2.25} /></span>
        <span class="opt-text"><strong>New event</strong><small>Tickets, dates, payments</small></span>
      </button>
      <button class="create-opt" role="menuitem" onclick={() => create("/creator/shops/new")}>
        <span class="opt-ic"><ShoppingBag size={16} strokeWidth={2.25} /></span>
        <span class="opt-text"><strong>New shop</strong><small>Catalog, POS, tap-to-pay</small></span>
      </button>
      <button class="create-opt" role="menuitem" onclick={() => create("/creator/sites")}>
        <span class="opt-ic"><Monitor size={16} strokeWidth={2.25} /></span>
        <span class="opt-text"><strong>New website</strong><small>Multi-page site builder</small></span>
      </button>
      <button class="create-opt" role="menuitem" onclick={() => create("/creator/pods")}>
        <span class="opt-ic"><Layers size={16} strokeWidth={2.25} /></span>
        <span class="opt-text"><strong>New POD</strong><small>Badge, drop, or collectible</small></span>
      </button>
    </div>
  {/if}
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
    flex-shrink: 0;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    transition: transform var(--transition-fast);
  }
  .logo:hover { transform: translate(-1px, -1px); }

  .surface-badge {
    display: inline-block;
    padding: 0.125rem 0.4375rem;
    font-family: var(--font-mono);
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--accent-ink);
    background: var(--accent);
    border-radius: var(--radius-sm);
  }

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
    .surface-badge { display: none; }
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
  .sign-in-btn:hover { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }

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
  .nav-icon { display: inline-flex; align-items: center; line-height: 0; }
  .nav-label { font-size: 0.625rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; font-family: var(--font-mono); }
  .bottom-nav-item--accent .nav-icon {
    background: var(--accent);
    color: var(--accent-ink);
    width: 1.75rem;
    height: 1.75rem;
    border-radius: var(--radius-sm);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .bottom-nav-item--accent.active .nav-icon { background: var(--accent-hover); }
  .bottom-nav-item--accent .nav-icon { transition: transform var(--transition); }
  .bottom-nav-item--accent .nav-icon.rot { transform: rotate(45deg); }

  /* ── Create action sheet ── */
  .create-scrim {
    position: fixed; inset: 0; z-index: 101;
    background: rgba(0, 0, 0, 0.5);
    border: none; cursor: pointer;
    animation: scrim-in 0.15s ease;
  }
  @keyframes scrim-in { from { opacity: 0; } to { opacity: 1; } }

  .create-sheet {
    position: fixed; z-index: 102;
    left: 50%; transform: translateX(-50%);
    bottom: calc(4.25rem + env(safe-area-inset-bottom));
    width: min(320px, calc(100vw - 2rem));
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 0.375rem;
    display: flex; flex-direction: column; gap: 1px;
    box-shadow: 0 20px 48px -20px rgba(0, 0, 0, 0.7);
    animation: sheet-in 0.2s cubic-bezier(0.22, 1, 0.36, 1);
  }
  @keyframes sheet-in { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }

  .create-opt {
    display: flex; align-items: center; gap: 0.75rem;
    padding: 0.625rem 0.75rem;
    background: none; border: none; cursor: pointer; text-align: left;
    border-radius: var(--radius-sm);
    transition: background var(--transition);
  }
  .create-opt:hover { background: var(--accent-subtle); }
  .opt-ic {
    display: grid; place-items: center; flex-shrink: 0;
    width: 2rem; height: 2rem; border-radius: var(--radius-sm);
    background: var(--bg-elevated); border: 1px solid var(--border); color: var(--accent-text);
  }
  .opt-text { display: flex; flex-direction: column; gap: 0.05rem; min-width: 0; }
  .opt-text strong { font-size: 0.875rem; font-weight: 700; color: var(--text); }
  .opt-text small { font-size: 0.6875rem; color: var(--text-muted); }
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
