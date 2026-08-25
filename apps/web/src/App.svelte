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
      // A link that carried a sub-ENS name whose lookup did not answer on the
      // landing page leaves the name stored with no address. Retry it here
      // rather than dropping the referral: "error" is not "unregistered"
      // (#177), and this is the next moment we are online.
      async function resolvePendingName(): Promise<`0x${string}` | null> {
        const capture = await import("./lib/campaign/referral-capture.js");
        const pendingName = capture.unresolvedRefName();
        if (!pendingName) return null;
        const { resolveSubEnsAddress } = await import("./lib/api/sub-ens.js");
        const res = await resolveSubEnsAddress(pendingName).catch(() => null);
        // Only an unregistered name is a dead link worth forgetting; an
        // unanswered lookup keeps the name for the next authenticated visit.
        if (res?.status === "none") { m.clearCapturedRef(); return null; }
        if (res?.status !== "found") return null;
        capture.storeCapturedRef(res.address);
        return capture.readCapturedRef();
      }

      const ref = m.readCapturedRef() ?? (await resolvePendingName());
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

  // Legal pages are lazy for the same reason: policy text is only downloaded by
  // someone who actually opens a policy.
  const legalPagePromise = $derived(
    router.route === "legal"
      ? import("./lib/legal/LegalPage.svelte").then((m) => m.default)
      : null
  );
</script>

{#if router.route === "legal"}
  {#await legalPagePromise}
    <div class="surface-loading">Loading…</div>
  {:then Comp}
    {#if Comp}
      <Comp doc={router.params.doc ?? "index"} />
    {/if}
  {:catch}
    <div class="surface-loading surface-error">Failed to load. Please refresh.</div>
  {/await}
{:else if router.surface === "neutral"}
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
