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

  // Referral attribution: a captured #/ref/{address} waits in localStorage
  // until the account's first authenticated moment (a session already exists,
  // so this never triggers an unsolicited signing prompt), then registers the
  // pending referral server-side. First attribution wins; self-referral is
  // dropped client-side and rejected server-side.
  let refPostInFlight = false;
  $effect(() => {
    if (!auth.isAuthenticated || refPostInFlight) return;
    void import("./lib/api/campaign.js").then(async (m) => {
      const ref = m.readCapturedRef();
      if (!ref) return;
      if (auth.parent && ref === auth.parent.toLowerCase()) {
        m.clearCapturedRef();
        return;
      }
      refPostInFlight = true;
      try {
        const resp = await m.postPendingReferral(ref);
        // 4xx (self-referral, already attributed) is final too — stop retrying.
        if (resp.ok || resp.error) m.clearCapturedRef();
      } catch {
        // Network failure — keep the capture for the next authenticated visit.
      } finally {
        refPostInFlight = false;
      }
    });
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
