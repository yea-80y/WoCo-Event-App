<script lang="ts">
  import type { Snippet } from "svelte";
  import { auth } from "../auth/auth-store.svelte.js";
  import { router, navigate } from "../router/router.svelte.js";
  import { organiserRole } from "../auth/organiser-role.svelte.js";
  import { inviteSheet } from "../campaign/invite-sheet.svelte.js";
  import { gate } from "../attendee/gate/gate.svelte.js";
  import { organisesFromUnlock } from "../attendee/home/member-state.js";
  import SessionStatus from "../components/auth/SessionStatus.svelte";
  import UserAvatar from "../components/profile/UserAvatar.svelte";
  import WocoWordmark from "../components/brand/WocoWordmark.svelte";
  import PortalSwitch from "../components/nav/PortalSwitch.svelte";
  import SessionEndedBanner from "../components/auth/SessionEndedBanner.svelte";
  import ReferralCaptureBanner from "../components/campaign/ReferralCaptureBanner.svelte";
  import TabBar, { type TabItem } from "../components/nav/TabBar.svelte";

  interface Props {
    children: Snippet;
  }
  let { children }: Props = $props();

  const signedIn = $derived(auth.ready && auth.isConnected && !!auth.parent);
  // Every top bar offers both portals now (PortalSwitch); this only decides
  // whether to warm organiser mode's bundle for an account that organises.
  const showOrganiser = $derived(
    signedIn && (organiserRole.isOrganiser || organisesFromUnlock(gate.status?.via)),
  );

  const isHome = $derived(router.route === "member-home");
  const isEvents = $derived(router.route === "home" || router.route === "discover");
  const isContacts = $derived(router.route === "contacts");
  const isProfile = $derived(router.route === "profile");

  // The sheet and its QR library load on first open, never with the shell.
  const loadInviteSheet = () =>
    import("../components/campaign/InviteSheet.svelte").then((m) => m.default);

  const tabs = $derived<TabItem[]>([
    { id: "home", label: "Home", icon: "home", active: isHome, onclick: () => navigate("/home") },
    { id: "events", label: "Events", icon: "events", active: isEvents, onclick: () => navigate("/discover") },
    {
      id: "invite", label: "Invite", icon: "invite", key: true, haspopup: "dialog",
      expanded: inviteSheet.open, onclick: () => inviteSheet.show(),
    },
    { id: "contacts", label: "Contacts", icon: "contacts", active: isContacts, onclick: () => navigate("/contacts") },
    {
      id: "profile", label: "Profile", avatar: auth.parent, active: isProfile,
      onclick: () => navigate(`/profile/${auth.parent!.toLowerCase()}`),
    },
  ]);

  // Start fetching organiser mode as soon as its link shows, while the person is
  // still in WoCo, so following the link swaps screens instead of stopping on a
  // blank loading page. The same module App.svelte loads, so it downloads once.
  $effect(() => {
    if (!showOrganiser) return;
    const idle = globalThis.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1200));
    idle(() => { void import("../../CreatorApp.svelte"); });
  });
</script>

<main class:with-nav={signedIn}>
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
  <ReferralCaptureBanner />
  <header class="top-bar">
    <!-- Always the home page, signed in or not: the portals are one tap away on the right. -->
    <button class="logo" onclick={() => navigate("/")} aria-label="WoCo home">
      <WocoWordmark height={20} variant="default" />
    </button>

    <!-- Both portals, signed in or not. No Sign in here: each portal's home
         leads with its own, and the switch is the one way in to either. -->
    <div class="top-right">
      <PortalSwitch current="attendee" />
      {#if signedIn}
        <SessionStatus compact />
      {/if}
    </div>
  </header>

  <section class="content">
    {#if auth.ready}
      {@render children()}
    {/if}
  </section>

  {#if signedIn}
    <TabBar label="Main" items={tabs} />

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

  @media (max-width: 400px) {
    .top-right { gap: 0.625rem; }
  }

  .content { padding: 0.25rem 0 2rem; }

</style>
