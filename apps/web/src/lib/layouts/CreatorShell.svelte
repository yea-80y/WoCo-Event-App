<script lang="ts">
  import type { Snippet } from "svelte";
  import { FEATURES } from "@woco/shared";
  import { auth } from "../auth/auth-store.svelte.js";
  import { loginRequest } from "../auth/login-request.svelte.js";
  import { router, navigate } from "../router/router.svelte.js";
  import SessionStatus from "../components/auth/SessionStatus.svelte";
  import WocoWordmark from "../components/brand/WocoWordmark.svelte";
  import TabBar, { type TabItem } from "../components/nav/TabBar.svelte";
  import NavIcon from "../components/nav/NavIcon.svelte";
  import ShoppingBag from "lucide-svelte/icons/shopping-bag";
  import Layers from "lucide-svelte/icons/layers";
  import PortalSwitch from "../components/nav/PortalSwitch.svelte";
  import SessionEndedBanner from "../components/auth/SessionEndedBanner.svelte";

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
  const isAudience = $derived(router.route === "audience");
  const isProfile = $derived(router.route === "profile");

  let createOpen = $state(false);
  function create(path: string) {
    createOpen = false;
    navigate(path);
  }

  function openProfile() {
    if (!auth.isConnected || !auth.parent) {
      void loginRequest.request({ context: "creator" });
      return;
    }
    navigate(`/creator/profile/${auth.parent.toLowerCase()}`);
  }

  // Five slots from the first paint, signed in or not, so nothing shifts when
  // sign-in finishes. Websites live in Build's menu: they are set up once and
  // edited now and then, which does not earn a tab.
  const tabs = $derived<TabItem[]>([
    { id: "dashboard", label: "Dashboard", icon: "dashboard", active: isHome, onclick: () => navigate("/creator") },
    { id: "events", label: "Events", icon: "events", active: isEvents, onclick: () => navigate("/creator/events") },
    {
      id: "build", label: "Build", icon: "build", key: true, haspopup: "menu",
      expanded: createOpen, onclick: () => { createOpen = !createOpen; },
    },
    { id: "audience", label: "Audience", icon: "audience", active: isAudience, onclick: () => navigate("/creator/audience") },
    {
      id: "profile", label: "Profile", avatar: auth.isConnected ? auth.parent : null,
      active: isProfile, onclick: openProfile,
    },
  ]);
</script>

<svelte:window onkeydown={(e) => { if (e.key === "Escape" && createOpen) createOpen = false; }} />

<main>
  <SessionEndedBanner />
  {#if auth.kind === "passkey" && auth.hasSession}
    {#await import("../components/passkeys/NewPasskeyBanner.svelte") then { default: NewPasskeyBanner }}
      <NewPasskeyBanner />
    {/await}
  {/if}
  {#if auth.removalProgress || auth.pendingRemoval || auth.removalDone || auth.keyRingNotice}
    {#await import("../components/passkeys/KeyRingStatus.svelte") then { default: KeyRingStatus }}
      <KeyRingStatus />
    {/await}
  {/if}
  <header class="top-bar">
    <!-- Always the home page; "Organisers" lit in the switch says which portal this is. -->
    <button class="logo" onclick={() => navigate("/")} aria-label="WoCo home">
      <WocoWordmark height={20} variant="default" face="display" />
    </button>

    <!-- Both portals, signed in or not. No Sign in here: the dashboard leads
         with its own, and it asks for an organiser's (passkey only). -->
    <div class="top-right">
      <PortalSwitch current="organiser" />
      {#if auth.ready && auth.isConnected && auth.parent}
        <SessionStatus compact />
      {/if}
    </div>
  </header>

  <section class="content">
    {#if auth.ready}
      {@render children()}
    {/if}
  </section>

  <TabBar label="Organiser" items={tabs} />

  {#if createOpen}
    <button class="create-scrim" aria-label="Close menu" onclick={() => { createOpen = false; }}></button>
    <div class="create-sheet" role="menu" aria-label="Build">
      <button class="create-opt" role="menuitem" onclick={() => create("/creator/events/new")}>
        <span class="opt-ic"><NavIcon name="events" size={18} /></span>
        <span class="opt-text"><strong>New event</strong><small>Tickets, dates and payments</small></span>
      </button>
      <button class="create-opt" role="menuitem" onclick={() => create("/creator/sites")}>
        <span class="opt-ic"><NavIcon name="sites" size={18} /></span>
        <span class="opt-text"><strong>Your website</strong><small>Build or edit your pages, and choose which events show</small></span>
      </button>
      <!-- The router refuses /creator/shops/* while the rail is off (#124), so
           offering this would open the create sheet onto the splitter. -->
      {#if FEATURES.shopAllowed}
        <button class="create-opt" role="menuitem" onclick={() => create("/creator/shops/new")}>
          <span class="opt-ic"><ShoppingBag size={16} strokeWidth={2.25} /></span>
          <span class="opt-text"><strong>New shop</strong><small>Catalog, POS, tap-to-pay</small></span>
        </button>
      {/if}
      {#if FEATURES.badgesAllowed}
        <button class="create-opt" role="menuitem" onclick={() => create("/creator/objects")}>
          <span class="opt-ic"><Layers size={16} strokeWidth={2.25} /></span>
          <span class="opt-text"><strong>New object</strong><small>Badge, drop, or access pass</small></span>
        </button>
      {/if}
    </div>
  {/if}
</main>

<style>
  main {
    max-width: 840px;
    margin: 0 auto;
    padding: 0 1.25rem;
    padding-bottom: calc(5rem + env(safe-area-inset-bottom));
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

  .top-right {
    display: flex;
    align-items: center;
    gap: 1rem;
    min-width: 0;
    overflow: hidden;
    flex-shrink: 1;
  }


  /* Logo, both portals and Sign out on one row down to a 360px phone. */
  @media (max-width: 400px) {
    .top-right { gap: 0.625rem; }
  }

  .content { padding: 0.25rem 0 2rem; }

  /* ── Build menu ── */
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
    bottom: calc(4.75rem + env(safe-area-inset-bottom));
    width: min(22rem, calc(100vw - 2rem));
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 0.375rem;
    display: flex; flex-direction: column; gap: 1px;
    box-shadow: 0 20px 48px -20px rgba(0, 0, 0, 0.7);
    animation: sheet-in 0.22s var(--ease-out);
  }
  @keyframes sheet-in { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }

  .create-opt {
    display: flex; align-items: center; gap: 0.75rem;
    padding: 0.6875rem 0.75rem;
    background: none; border: none; cursor: pointer; text-align: left;
    border-radius: var(--radius-sm);
    transition: background var(--transition);
  }
  .create-opt:hover { background: var(--accent-subtle); }
  .create-opt:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .opt-ic {
    display: grid; place-items: center; flex-shrink: 0;
    width: 2.25rem; height: 2.25rem; border-radius: var(--radius-sm);
    background: var(--bg-elevated); border: 1px solid var(--border); color: var(--accent-text);
  }
  .opt-text { display: flex; flex-direction: column; gap: 0.05rem; min-width: 0; }
  .opt-text strong { font-size: 0.9375rem; font-weight: 600; color: var(--text); }
  .opt-text small { font-size: 0.75rem; line-height: 1.35; color: var(--text-muted); }

  @media (prefers-reduced-motion: reduce) {
    .create-scrim, .create-sheet { animation: none; }
  }

</style>
