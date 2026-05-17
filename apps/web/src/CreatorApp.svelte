<script lang="ts">
  import { router, navigate } from "./lib/router/router.svelte.js";
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

  $effect(() => {
    if (router.route === "create" && !import.meta.env.VITE_ENABLE_INAPP_CREATOR) {
      navigate("/site-builder");
    }
  });
</script>

<CreatorShell>
  {#if router.route === "creator-home"}
    <CreatorHome />
  {:else if router.route === "create"}
    <EventForm onpublished={(id) => navigate(`/event/${id}`)} />
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
  {:else if router.route === "profile"}
    <ProfilePage address={router.params.address} />
  {:else if router.route === "stripe-return"}
    <div class="stripe-return-page">
      <h2>Stripe Setup</h2>
      <p>Checking your onboarding status...</p>
      {#await import("./lib/api/stripe.js").then(m => m.getStripeAccountStatus())}
        <p>Loading...</p>
      {:then status}
        {#if status.onboardingComplete}
          <p class="stripe-success">Your Stripe account is connected and ready to accept payments!</p>
        {:else}
          <p>Your onboarding is not yet complete. Some information may still be required.</p>
        {/if}
        <button class="stripe-dashboard-link" onclick={() => navigate("/creator/events")}>Back to dashboard</button>
      {:catch}
        <p>Could not check status. Please try again.</p>
        <button class="stripe-dashboard-link" onclick={() => navigate("/creator/events")}>Back to dashboard</button>
      {/await}
    </div>
  {:else if router.route === "stripe-refresh"}
    <div class="stripe-return-page">
      <h2>Link Expired</h2>
      <p>Your onboarding link has expired. Go back to the dashboard to get a new one.</p>
      <button class="stripe-dashboard-link" onclick={() => navigate("/creator/events")}>Back to dashboard</button>
    </div>
  {/if}
</CreatorShell>

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
