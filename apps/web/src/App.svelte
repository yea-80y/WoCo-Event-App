<script lang="ts">
  import { auth } from "./lib/auth/auth-store.svelte.js";
  import { router } from "./lib/router/router.svelte.js";
  import LoginModal from "./lib/components/auth/LoginModal.svelte";
  import SigningConfirmDialog from "./lib/components/auth/SigningConfirmDialog.svelte";
  import TicketGateModal from "./lib/attendee/gate/TicketGateModal.svelte";
  import Splitter from "./lib/landing/Splitter.svelte";
  import AttendeeApp from "./AttendeeApp.svelte";
  import { onMount } from "svelte";

  onMount(() => {
    auth.init();
  });

  // Lazy-load the creator bundle — attendees never download builder/dashboard code.
  const creatorAppPromise = $derived(
    router.surface === "creator"
      ? import("./CreatorApp.svelte").then((m) => m.default)
      : null
  );
</script>

{#if router.surface === "neutral"}
  <Splitter />
{:else if router.surface === "creator"}
  {#await creatorAppPromise}
    <div class="surface-loading">Loading creator portal…</div>
  {:then Comp}
    {#if Comp}
      <Comp />
    {/if}
  {:catch}
    <div class="surface-loading surface-error">
      Failed to load creator portal. Please refresh.
    </div>
  {/await}
{:else}
  <AttendeeApp />
{/if}

<TicketGateModal />
<LoginModal />
<SigningConfirmDialog />

<style>
  .surface-loading {
    max-width: 840px;
    margin: 0 auto;
    padding: 4rem 1.25rem;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.875rem;
  }
  .surface-error {
    color: var(--error, #c53030);
  }
</style>
