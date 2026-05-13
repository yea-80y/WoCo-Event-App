<script lang="ts">
  import { router, navigate } from "./lib/router/router.svelte.js";
  import AttendeeShell from "./lib/layouts/AttendeeShell.svelte";
  import EventDetail from "./lib/attendee/events/EventDetail.svelte";
  import EventPage from "./lib/components/site/EventPage.svelte";
  import Home from "./lib/attendee/home/Home.svelte";
  import MyTickets from "./lib/attendee/passport/MyTickets.svelte";
  import VerifyTicket from "./lib/attendee/passport/VerifyTicket.svelte";
  import ProfilePage from "./lib/components/profile/ProfilePage.svelte";
  import { getExternalEventApi } from "./lib/api/event-api-registry.js";
</script>

<AttendeeShell>
  {#if router.route === "home"}
    <Home />
  {:else if router.route === "event"}
    {#if getExternalEventApi(router.params.id)}
      <EventPage
        eventId={router.params.id}
        apiUrl={getExternalEventApi(router.params.id)}
        onback={() => navigate("/")}
        ondashboard={() => navigate(`/creator/events/${router.params.id}`)}
      />
    {:else}
      <EventDetail
        eventId={router.params.id}
        onback={() => navigate("/")}
      />
    {/if}
  {:else if router.route === "my-tickets"}
    <MyTickets />
  {:else if router.route === "verify"}
    <VerifyTicket />
  {:else if router.route === "profile"}
    <ProfilePage address={router.params.address} />
  {/if}
</AttendeeShell>
