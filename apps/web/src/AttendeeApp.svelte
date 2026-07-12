<script lang="ts">
  import { onMount } from "svelte";
  import { router, navigate } from "./lib/router/router.svelte.js";
  import AttendeeShell from "./lib/layouts/AttendeeShell.svelte";
  import LazyRoute from "./lib/router/LazyRoute.svelte";
  import Home from "./lib/attendee/home/Home.svelte";
  import ComingSoon from "./lib/attendee/coming-soon/ComingSoon.svelte";
  import { getExternalEventApi } from "./lib/api/event-api-registry.js";

  // Route-level code splitting: only Home ships in the boot chunk (Swarm
  // round-trips are slow, so the eager graph must stay minimal). Every other
  // route — and its dependency subtree (payments, EAS, recovery, shop rail) —
  // downloads on first navigation.
  const loadEventDetail = () => import("./lib/attendee/events/EventDetail.svelte");
  const loadEventPage = () => import("./lib/components/site/EventPage.svelte");
  const loadEventPurchased = () => import("./lib/attendee/events/EventPurchased.svelte");
  const loadMyTickets = () => import("./lib/attendee/passport/MyTickets.svelte");
  const loadVerifyTicket = () => import("./lib/attendee/passport/VerifyTicket.svelte");
  const loadProfilePage = () => import("./lib/components/profile/ProfilePage.svelte");
  const loadShopTapScreen = () => import("./lib/attendee/shop/ShopTapScreen.svelte");
  const loadShopOrderScreen = () => import("./lib/attendee/shop/ShopOrderScreen.svelte");
  const loadRecoverySetup = () => import("./lib/components/recovery/AccountRecoverySetup.svelte");
  const loadRecoverPortal = () => import("./lib/components/recovery/AccountRecoverPortal.svelte");

  // Warm the chunks behind the bottom-nav destinations once the landing
  // screen is idle, so first navigation doesn't pay a cold Swarm fetch.
  onMount(() => {
    const warm = () => {
      void loadEventDetail();
      void loadMyTickets();
      void loadProfilePage();
    };
    if ("requestIdleCallback" in window) {
      requestIdleCallback(warm, { timeout: 4000 });
    } else {
      setTimeout(warm, 2000);
    }
  });
</script>

<AttendeeShell>
  {#if router.route === "home" || router.route === "discover"}
    <Home />
  {:else if router.route === "event"}
    {#if getExternalEventApi(router.params.id)}
      <LazyRoute
        loader={loadEventPage}
        props={{
          eventId: router.params.id,
          apiUrl: getExternalEventApi(router.params.id),
          onback: () => navigate("/"),
          ondashboard: () => navigate(`/creator/events/${router.params.id}`),
        }}
      />
    {:else}
      <LazyRoute
        loader={loadEventDetail}
        props={{ eventId: router.params.id, onback: () => navigate("/") }}
      />
    {/if}
  {:else if router.route === "event-purchased"}
    <LazyRoute loader={loadEventPurchased} props={{ eventId: router.params.id }} />
  {:else if router.route === "my-tickets"}
    <LazyRoute loader={loadMyTickets} />
  {:else if router.route === "verify"}
    <LazyRoute loader={loadVerifyTicket} />
  {:else if router.route === "profile"}
    <LazyRoute loader={loadProfilePage} props={{ address: router.params.address }} />
  {:else if router.route === "soon"}
    <ComingSoon feature={router.params.feature} />
  {:else if router.route === "shop-tap"}
    <LazyRoute loader={loadShopTapScreen} props={{ shopId: router.params.shopId }} />
  {:else if router.route === "shop-order"}
    <LazyRoute
      loader={loadShopOrderScreen}
      props={{ shopId: router.params.shopId, code: router.params.code }}
    />
  {:else if router.route === "protect"}
    <LazyRoute loader={loadRecoverySetup} />
  {:else if router.route === "recover"}
    <LazyRoute loader={loadRecoverPortal} />
  {/if}
</AttendeeShell>
