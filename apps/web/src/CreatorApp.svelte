<script lang="ts">
  import { router, navigate } from "./lib/router/router.svelte.js";
  import { auth } from "./lib/auth/auth-store.svelte.js";
  import { canOrganise } from "./lib/auth/organiser-account.js";
  import CreatorShell from "./lib/layouts/CreatorShell.svelte";
  import EventForm from "./lib/creator/events/EventForm.svelte";
  import EmbedSetup from "./lib/creator/embed/EmbedSetup.svelte";
  import Dashboard from "./lib/creator/dashboard/Dashboard.svelte";
  import DashboardIndex from "./lib/creator/dashboard/DashboardIndex.svelte";
  import CreatorHome from "./lib/creator/home/CreatorHome.svelte";
  import SiteBuilder from "./lib/creator/SiteBuilder.svelte";
  import MultiSiteBuilder from "./lib/creator/builder/MultiSiteBuilder.svelte";
  import ProfilePage from "./lib/components/profile/ProfilePage.svelte";
  import SiteEventsManager from "./lib/creator/sites/SiteEventsManager.svelte";
  import LazyRoute from "./lib/router/LazyRoute.svelte";
  import ObjectManager from "./lib/components/object/ObjectManager.svelte";
  import AudienceScreen from "./lib/creator/audience/AudienceScreen.svelte";
  import PayoutsScreen from "./lib/creator/payouts/PayoutsScreen.svelte";
  import type { StripeAccountStatus } from "./lib/api/stripe.js";
  import { syncAudience } from "./lib/creator/audience/audience-sync.svelte.js";
  import { untrack } from "svelte";
  import {
    STRIPE_REFRESH_GUARD_KEY,
    mayAutoRefreshLink,
    postStripeReturn,
    stripeReturnVariant,
  } from "./lib/creator/dashboard/stripe-return-handoff.js";

  // The shop rail is flagged off for launch (#124), and the router refuses its
  // routes while it is. Static imports would still drag the three screens — and
  // the spend-permission/USDC subtree behind them — into the creator boot chunk
  // for a feature nobody can reach, so they load on navigation instead.
  const loadMyShopsScreen = () => import("./lib/creator/shops/MyShopsScreen.svelte");
  const loadShopEditor = () => import("./lib/creator/shops/ShopEditor.svelte");
  const loadShopPosShell = () => import("./lib/creator/shops/ShopPosShell.svelte");

  $effect(() => {
    if (router.route === "create" && !import.meta.env.VITE_ENABLE_INAPP_CREATOR) {
      navigate("/site-builder");
    }
  });

  // Opted-in ticket buyers join the organiser's list while they use WoCo
  // (audience-sync.ts) - here on the organiser home and event pages, and only on an
  // account already unlocked on this device: never a prompt. syncAudience throttles
  // to once per 10 minutes per tab; the Audience screen runs it itself.
  const AUDIENCE_SYNC_ROUTES = new Set(["creator-home", "dashboard-index", "dashboard"]);
  $effect(() => {
    if (!AUDIENCE_SYNC_ROUTES.has(router.route)) return;
    if (!auth.ready || !auth.isConnected || !auth.parent || !canOrganise(auth.kind)) return;
    if (!auth.hasSession || !auth.hasIdentitySeed) return;
    untrack(() => void syncAudience());
  });

  let stripeStatus = $state<StripeAccountStatus | null>(null);
  let stripeStatusError = $state(false);
  let stripeStatusLoading = $state(false);

  // Read ONCE, at load: `window.opener` is not reactive, and it is at its most
  // truthful before the opener tab can go away (#508).
  const returnVariant = stripeReturnVariant(typeof window === "undefined" ? null : window.opener);
  // A tab this app script-opened has done its job once the read lands — the
  // user's session, and their unsaved form, is in the tab behind it. An
  // unverifiable read is not "all done", so it keeps the neutral heading.
  const stripeReturnHeading = $derived(
    returnVariant === "close" && stripeStatus
      ? "All done — you can close this tab and carry on where you were"
      : "Stripe Setup",
  );

  $effect(() => {
    if (router.route !== "stripe-return") {
      stripeStatus = null;
      stripeStatusError = false;
      stripeStatusLoading = false;
      return;
    }
    if (!auth.ready) return;
    if (!auth.isConnected) return;
    if (stripeStatus || stripeStatusError || stripeStatusLoading) return;
    stripeStatusLoading = true;
    import("./lib/api/stripe.js").then(m => m.getStripeAccountStatus()).then(s => {
      // An error envelope is truthy — storing it as `stripeStatus` used to tell
      // someone who JUST finished onboarding "your onboarding is not yet
      // complete" off a rejected read (#256). Unverifiable is the error branch.
      if (s.ok) stripeStatus = s;
      else stripeStatusError = true;
      stripeStatusLoading = false;
      // Tell the tab that opened onboarding, which is still sitting on a manual
      // "I've finished setup" button with nothing to tell it otherwise (#508).
      // Only off a read that succeeded — an unverifiable one has no answer to
      // send, and the waiting tab re-checks on focus anyway.
      if (s.ok) postStripeReturn(s.onboardingComplete === true);
    }).catch(() => {
      stripeStatusError = true;
      stripeStatusLoading = false;
    });
  });

  // Stripe sends an already-used or expired Account Link here, and its docs say to
  // mint a new link and redirect to it. Same tab, so no tap is needed (iPhone), and
  // the tab keeps its opener, so the return page can still close it (#508).
  let stripeRefreshFailed = $state(false);
  let stripeRefreshStarted = false;
  $effect(() => {
    if (router.route !== "stripe-refresh") {
      stripeRefreshFailed = false;
      stripeRefreshStarted = false;
      return;
    }
    if (!auth.ready || !auth.isConnected) return;
    if (!canOrganise(auth.kind)) {
      stripeRefreshFailed = true;
      return;
    }
    if (stripeRefreshStarted) return;
    stripeRefreshStarted = true;
    const now = Date.now();
    try {
      const last = sessionStorage.getItem(STRIPE_REFRESH_GUARD_KEY);
      if (!mayAutoRefreshLink(last === null ? null : Number(last), now)) {
        stripeRefreshFailed = true;
        return;
      }
      sessionStorage.setItem(STRIPE_REFRESH_GUARD_KEY, String(now));
    } catch {
      // No storage = no loop guard, so no automatic redirect: the button still works.
      stripeRefreshFailed = true;
      return;
    }
    void renewStripeLink();
  });

  async function renewStripeLink() {
    stripeRefreshFailed = false;
    try {
      const link = await import("./lib/api/stripe.js").then(m => m.getOnboardingLink());
      if (link.url) {
        window.location.replace(link.url);
        return;
      }
      if (link.alreadyComplete) {
        navigate("/stripe/return");
        return;
      }
      stripeRefreshFailed = true;
    } catch {
      stripeRefreshFailed = true;
    }
  }
</script>

<CreatorShell>
  <!-- Organising needs a passkey account (#746 step 5); deep links land here too. -->
  {#if auth.ready && auth.isConnected && !canOrganise(auth.kind) && router.route !== "profile"}
    <LazyRoute loader={() => import("./lib/creator/gate/OrganiserNeedsPasskey.svelte")} />
  {:else if router.route === "creator-home"}
    <CreatorHome />
  {:else if router.route === "create"}
    <EventForm />
  {:else if router.route === "dashboard-index"}
    <DashboardIndex />
  {:else if router.route === "dashboard"}
    <Dashboard eventId={router.params.id} />
  {:else if router.route === "embed-setup"}
    <EmbedSetup eventId={router.params.id} />
  {:else if router.route === "site-events"}
    <SiteEventsManager siteId={router.params.siteId} />
  {:else if router.route === "site-builder"}
    <SiteBuilder />
  {:else if router.route === "build"}
    <MultiSiteBuilder />
  {:else if router.route === "my-shops"}
    <LazyRoute loader={loadMyShopsScreen} />
  {:else if router.route === "shop-editor"}
    {#key router.params.shopId}
      <LazyRoute loader={loadShopEditor} props={{ shopId: router.params.shopId }} />
    {/key}
  {:else if router.route === "shop-pos"}
    <LazyRoute loader={loadShopPosShell} props={{ shopId: router.params.shopId }} />
  {:else if router.route === "creator-objects"}
    <ObjectManager />
  {:else if router.route === "audience"}
    <AudienceScreen />
  {:else if router.route === "privacy-notice-editor"}
    <LazyRoute loader={() => import("./lib/creator/privacy/PrivacyNoticeEditor.svelte")} />
  {:else if router.route === "payouts"}
    <PayoutsScreen />
  {:else if router.route === "profile"}
    <ProfilePage address={router.params.address} />
  {:else if router.route === "stripe-return"}
    <div class="stripe-return-page">
      <h2>{stripeReturnHeading}</h2>
      {#if !auth.ready || (!auth.isConnected && !stripeStatusError)}
        <p>Reconnecting your account…</p>
      {:else if stripeStatusLoading}
        <p>Checking your onboarding status…</p>
      {:else if stripeStatusError}
        <p>Could not check status. Please try again.</p>
        {@render stripeReturnExit()}
      {:else if stripeStatus}
        {#if stripeStatus.onboardingComplete}
          <p class="stripe-success">Your Stripe account is connected and ready to accept payments!</p>
        {:else}
          <p>Your onboarding is not yet complete. Some information may still be required.</p>
        {/if}
        {@render stripeReturnExit()}
      {:else}
        <p>Checking your onboarding status…</p>
      {/if}
    </div>
  {:else if router.route === "stripe-refresh"}
    <div class="stripe-return-page">
      {#if stripeRefreshFailed || (auth.ready && !auth.isConnected)}
        <h2>Link Expired</h2>
        <p>Your Stripe link has expired.</p>
        {#if auth.isConnected}
          <button class="stripe-dashboard-link" onclick={() => void renewStripeLink()}>Get a new link</button>
        {/if}
        {@render stripeReturnExit()}
      {:else}
        <h2>Stripe Setup</h2>
        <p>Getting you a fresh Stripe link…</p>
      {/if}
    </div>
  {/if}
</CreatorShell>

{#snippet stripeReturnExit()}
  {#if returnVariant === "close"}
    <button class="stripe-dashboard-link" onclick={() => window.close()}>Close this tab</button>
  {:else}
    <button class="stripe-dashboard-link" onclick={() => navigate("/creator/events")}>Back to dashboard</button>
  {/if}
{/snippet}

<style>
  .stripe-return-page {
    max-width: 480px;
    margin: 2rem auto;
    text-align: center;
    padding: 2rem 1rem;
  }
  .stripe-return-page h2 {
    color: var(--text);
    margin: 0 0 0.75rem;
  }
  .stripe-return-page p {
    color: var(--text-muted);
    margin: 0 0 1rem;
    font-size: 0.875rem;
  }
  .stripe-success {
    color: var(--success) !important;
  }
  .stripe-dashboard-link {
    padding: 0.5rem 1.25rem;
    background: var(--accent);
    color: var(--accent-ink);
    border-radius: var(--radius-sm);
    font-size: 0.875rem;
    font-weight: 500;
  }
  .stripe-dashboard-link:hover {
    background: var(--accent-hover);
  }
</style>
