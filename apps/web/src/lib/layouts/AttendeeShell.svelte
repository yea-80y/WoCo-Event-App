<script lang="ts">
  import type { Snippet } from "svelte";
  import { auth } from "../auth/auth-store.svelte.js";
  import { loginRequest } from "../auth/login-request.svelte.js";
  import { router, navigate } from "../router/router.svelte.js";
  import { hasStudio } from "../auth/studio-flag.js";
  import { inviteSheet } from "../campaign/invite-sheet.svelte.js";
  import SessionStatus from "../components/auth/SessionStatus.svelte";
  import UserAvatar from "../components/profile/UserAvatar.svelte";
  import WocoWordmark from "../components/brand/WocoWordmark.svelte";
  import PreLaunchBanner from "../components/status/PreLaunchBanner.svelte";
  import SessionEndedBanner from "../components/auth/SessionEndedBanner.svelte";
  import ReferralCaptureBanner from "../components/campaign/ReferralCaptureBanner.svelte";

  interface Props {
    children: Snippet;
  }
  let { children }: Props = $props();

  const signedIn = $derived(auth.ready && auth.isConnected && !!auth.parent);
  // Display only: every organiser route checks for itself.
  const showStudio = $derived(signedIn && hasStudio(auth.parent));

  const isHome = $derived(router.route === "member-home");
  const isEvents = $derived(router.route === "home" || router.route === "discover");
  const isProfile = $derived(router.route === "profile");

  // The sheet and its QR library load on first open, never with the shell.
  const loadInviteSheet = () =>
    import("../components/campaign/InviteSheet.svelte").then((m) => m.default);

  // Pixel-drawn like the landing page sprites, so the bar is WoCo's own set
  // rather than a stock icon library. 12 × 12 grid: [x, y, width, height].
  const ICONS = {
    home: [[5,1,2,1],[4,2,1,1],[7,2,1,1],[3,3,1,1],[8,3,1,1],[2,4,1,1],[9,4,1,1],[1,5,1,1],[10,5,1,1],[2,5,1,6],[9,5,1,6],[2,10,8,1],[5,7,2,3]],
    events: [[3,1,1,1],[8,1,1,1],[1,2,10,2],[1,4,1,6],[10,4,1,6],[1,10,10,1],[6,6,2,2]],
    invite: [[0,0,5,1],[0,4,5,1],[0,1,1,3],[4,1,1,3],[2,2,1,1],[7,0,5,1],[7,4,5,1],[7,1,1,3],[11,1,1,3],[9,2,1,1],[0,7,5,1],[0,11,5,1],[0,8,1,3],[4,8,1,3],[2,9,1,1],[7,7,2,2],[10,7,2,1],[9,9,2,1],[7,10,1,2],[10,11,2,1],[6,5,1,1]],
  } satisfies Record<string, number[][]>;
</script>

{#snippet pixel(rects: number[][])}
  <svg viewBox="0 0 12 12" width="24" height="24" shape-rendering="crispEdges" fill="currentColor" aria-hidden="true">
    {#each rects as r, i (i)}<rect x={r[0]} y={r[1]} width={r[2]} height={r[3]} />{/each}
  </svg>
{/snippet}

<main class:with-nav={signedIn}>
  <PreLaunchBanner variant="strip" />
  <SessionEndedBanner />
  <ReferralCaptureBanner />
  <header class="top-bar">
    <button class="logo" onclick={() => navigate(signedIn ? "/home" : "/")} aria-label="WoCo home">
      <WocoWordmark height={20} variant="default" />
    </button>

    <div class="top-right">
      {#if !auth.ready}
        <span class="loading">Loading...</span>
      {:else if signedIn}
        {#if showStudio}
          <button class="top-link" onclick={() => navigate("/creator")}>Studio</button>
        {/if}
        <SessionStatus compact />
      {:else}
        <button class="top-link" onclick={() => loginRequest.request({ context: "attendee" })}>
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

  {#if signedIn}
    <nav class="bottom-nav" aria-label="Main">
      <button
        class="nav-item"
        class:active={isHome}
        aria-current={isHome ? "page" : undefined}
        onclick={() => navigate("/home")}
      >
        <span class="nav-icon">{@render pixel(ICONS.home)}</span>
        <span class="nav-label">Home</span>
      </button>
      <button
        class="nav-item"
        class:active={isEvents}
        aria-current={isEvents ? "page" : undefined}
        onclick={() => navigate("/discover")}
      >
        <span class="nav-icon">{@render pixel(ICONS.events)}</span>
        <span class="nav-label">Events</span>
      </button>
      <button class="nav-item nav-item--key" aria-haspopup="dialog" onclick={() => inviteSheet.show()}>
        <span class="nav-key">{@render pixel(ICONS.invite)}</span>
        <span class="nav-label">Invite</span>
      </button>
      <button
        class="nav-item"
        class:active={isProfile}
        aria-current={isProfile ? "page" : undefined}
        onclick={() => navigate(`/profile/${auth.parent!.toLowerCase()}`)}
      >
        <span class="nav-avatar"><UserAvatar address={auth.parent!} size={24} /></span>
        <span class="nav-label">Profile</span>
      </button>
    </nav>

    {#if inviteSheet.open}
      {#await loadInviteSheet() then InviteSheet}
        <InviteSheet />
      {/await}
    {/if}
  {/if}
</main>

<style>
  main {
    max-width: 840px;
    margin: 0 auto;
    padding: 0 1.25rem 1.5rem;
  }
  main.with-nav { padding-bottom: calc(5rem + env(safe-area-inset-bottom)); }

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
    flex-shrink: 1;
  }

  .top-link {
    padding: 0.3125rem 0;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-muted);
    white-space: nowrap;
    transition: color var(--transition);
  }
  .top-link:hover { color: var(--text); }

  .loading { color: var(--text-muted); font-size: 0.8125rem; }
  .content { padding: 0.25rem 0 2rem; }

  .bottom-nav {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 100;
    display: flex;
    justify-content: center;
    padding: 0.375rem 0.25rem max(0.5rem, env(safe-area-inset-bottom));
    background: var(--bg-elevated);
    border-top: 1px solid var(--border);
  }
  .nav-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    gap: 0.3125rem;
    flex: 1;
    min-width: 0;
    max-width: 6rem;
    padding: 0.25rem 0.5rem;
    color: var(--text-muted);
    transition: color var(--transition);
  }
  .nav-item:hover,
  .nav-item.active { color: var(--text); }
  .nav-item.active .nav-icon { color: var(--accent); }
  .nav-icon,
  .nav-avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 1.5rem;
    line-height: 0;
  }
  .nav-item.active .nav-avatar :global(.avatar) { box-shadow: 0 0 0 2px var(--accent); }

  .nav-item--key { color: var(--text); }
  .nav-key {
    display: grid;
    place-items: center;
    width: 3rem;
    height: 2.25rem;
    background: var(--accent);
    color: var(--accent-ink);
    border-radius: var(--radius-sm);
    transition: background var(--transition);
  }
  .nav-item--key:hover .nav-key { background: var(--accent-hover); }
  .nav-item--key:active .nav-key { background: var(--accent-press); }

  .nav-label { font-size: 0.6875rem; font-weight: 500; line-height: 1; }
</style>
