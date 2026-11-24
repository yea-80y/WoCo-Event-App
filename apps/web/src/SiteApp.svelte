<script lang="ts">
  import { auth } from "./lib/auth/auth-store.svelte.js";
  import { onMount } from "svelte";
  import SiteLoginModal from "./lib/components/site/SiteLoginModal.svelte";
  import SigningConfirmDialog from "./lib/components/auth/SigningConfirmDialog.svelte";
  import AccountSetupSheet from "./lib/components/auth/AccountSetupSheet.svelte";
  import EventPage from "./lib/components/site/EventPage.svelte";
  import OrganiserNotice from "./lib/legal/OrganiserNotice.svelte";
  import { FEATURES } from "@woco/shared";

  // Runtime config (injected by deploy endpoint) takes priority over build-time env vars
  const EVENT_ID =
    (typeof window !== "undefined" && window.SITE_CONFIG?.eventId) ||
    import.meta.env.VITE_EVENT_ID ||
    "";

  // The page's canonical, baked at publish when it has a WoCo name (#70): the url its
  // schema.org Event states (#55). None = no stable address, so the Event states none -
  // never the gateway URL this page happens to be read through.
  const PAGE_URL =
    (typeof document !== "undefined" && document.querySelector('link[rel="canonical"]')?.getAttribute("href")) || null;

  let route = $state(parseRoute());

  // An event page is checkout only for launch (owner, 2026-10-08): its one way in
  // was a wallet, and wallet login is off (#186). Signing in here to check out with
  // an account is later work.
  const signInHere = FEATURES.walletLoginAllowed;

  // No organiser route: the organiser manages an event in the app
  // (`#/creator/events/{id}`). An event page is served on many origins, and the
  // organiser's powers (sealed orders, seat moves, the door list) stay off all of them.
  function parseRoute(): string {
    const hash = window.location.hash.replace(/^#/, "") || "/";
    // The organiser's privacy notice, a page of this event page (#/privacy-notice/{id}
    // from its footer; whatever the id, this page shows its own event's notice).
    if (hash === "/privacy-notice" || hash.startsWith("/privacy-notice/")) return "privacy";
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
  <section class="content">
    {#if !EVENT_ID}
      <p class="config-error">
        Event not configured. Set <code>VITE_EVENT_ID</code> in your <code>.env.site</code> file.
      </p>
    {:else if route === "privacy"}
      <div class="notice-wrap">
        <button class="logo-back" onclick={() => { window.location.hash = "#/"; }}>← Event</button>
        <OrganiserNotice eventId={EVENT_ID} />
      </div>
    {:else}
      <EventPage eventId={EVENT_ID} pageUrl={PAGE_URL} />
    {/if}
  </section>
</main>

{#if signInHere}
  <SiteLoginModal />
{/if}
<SigningConfirmDialog />
<AccountSetupSheet />

<style>
  main {
    max-width: 840px;
    margin: 0 auto;
    padding: 0 1.25rem 3rem;
  }

  .notice-wrap {
    padding: 1.5rem 0;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    align-items: flex-start;
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
