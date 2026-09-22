<script lang="ts">
  import { auth } from "./lib/auth/auth-store.svelte.js";
  import { router } from "./lib/router/router.svelte.js";
  import LoginModal from "./lib/components/auth/LoginModal.svelte";
  import SigningConfirmDialog from "./lib/components/auth/SigningConfirmDialog.svelte";
  import AccountSetupSheet from "./lib/components/auth/AccountSetupSheet.svelte";
  import TicketGateModal from "./lib/attendee/gate/TicketGateModal.svelte";
  import Splitter from "./lib/landing/Splitter.svelte";
  import AttendeeApp from "./AttendeeApp.svelte";
  import { studioRole } from "./lib/auth/studio-role.svelte.js";
  import { bootRedirectFor } from "./lib/sub-ens/host-label.js";
  import { subEnsName } from "@woco/shared";
  import { onMount } from "svelte";

  onMount(() => {
    auth.init();
    openProfileForNameHost();
  });

  // On a name host the profile IS the destination, so painting the home page
  // and swapping it out a moment later flashes the wrong page. The home page is
  // held back while the lookup runs, and only for so long: it must still paint
  // if the lookup never answers.
  const NAME_HOST_HOLD_MS = 4000;
  const nameHostLabel = bootRedirectFor(window.location.hostname, window.location.hash);
  let holdingForNameProfile = $state(nameHostLabel !== null);

  // A WoCo name (`nabil.woco.eth.<tld>`) resolves to this app's own content, so
  // the app itself has to notice which name it was reached by and open that
  // profile. Deliberately AFTER mount and never awaited: the label→address hop
  // is a network read, and the app must work whether or not it answers.
  function openProfileForNameHost() {
    const label = nameHostLabel;
    if (!label) return;
    // Released on failure and on this timer, never on success: the redirect
    // below changes the route, and releasing first would show the home page
    // for the frame before the hashchange lands.
    setTimeout(() => { holdingForNameProfile = false; }, NAME_HOST_HOLD_MS);
    // Lazy so the resolver's graph is only fetched on a name host — the vast
    // majority of loads are the canonical host and pay nothing for this.
    void import("./lib/api/sub-ens.js").then(async (m) => {
      const res = await m.resolveSubEnsAddress(label).catch(() => null);
      if (res?.status !== "found") {
        // Warn once and stay on the home page. An unregistered or unreadable
        // name is not worth an error screen — the app is still the app.
        console.warn(`[woco] ${label}.woco.eth did not resolve to a profile — showing the home page`);
        holdingForNameProfile = false;
        return;
      }
      // Re-check the route: the user may have navigated during the lookup, and
      // yanking them off the page they chose would be worse than not redirecting.
      if (!bootRedirectFor(window.location.hostname, window.location.hash)) return;
      // replace, not navigate: this redirect is automatic, so a history entry
      // for it would make Back land on the name host's bare home page — a
      // dead end nobody chose.
      // Built from the page's own URL: a relative one resolves against the
      // deploy's <base href>, which sent a profile name's own address to the
      // bare gateway root ("Cannot GET /") instead of the profile (#605).
      window.location.replace(new URL(`#/profile/${res.address}`, window.location.href).href);
    });
  }

  // Referral attribution: a captured #/ref/{address} waits in localStorage
  // until the referee can sign a statement on their OWN feed, at which point
  // this writes it. No server call, no attestation and — the constraint the
  // whole path is built around — no signing prompt: the statement is written on
  // the user's behalf at a moment they did not ask to sign anything, so it uses
  // only a seed already on the device (settleCapturedReferral's contract).
  //
  // BOTH dependencies are read, deliberately. `isAuthenticated` alone was
  // enough while the referral was a server POST; a feed write needs the account
  // SEED as well, and a fresh device has none at sign-in. Depending on
  // `hasIdentitySeed` too means the first user action that establishes one — a
  // like, a publish, a ticket — re-runs this and the statement lands then,
  // still with no ceremony of the campaign's own.
  let refSettleInFlight = false;
  $effect(() => {
    if (!auth.isAuthenticated || !auth.hasIdentitySeed || refSettleInFlight) return;
    refSettleInFlight = true;
    void (async () => {
      try {
        const capture = await import("./lib/campaign/referral-capture.js");
        // Nothing captured and no name left to resolve — almost every sign-in.
        // Bail BEFORE the Swarm write path is pulled in: referral-capture.js
        // imports nothing, records.js drags the feed writer, and a page load
        // with no invite behind it should pay for neither.
        if (!capture.readCapturedRef() && !capture.unresolvedRefName()) return;

        // A link that carried a sub-ENS name whose lookup did not answer on the
        // landing page leaves the name stored with no address. Retry it here
        // rather than dropping the referral: "error" is not "unregistered"
        // (#177), and this is the next moment we are online.
        async function resolvePendingName(): Promise<void> {
          const pendingName = capture.unresolvedRefName();
          if (!pendingName) return;
          const { resolveSubEnsAddress } = await import("./lib/api/sub-ens.js");
          const res = await resolveSubEnsAddress(pendingName).catch(() => null);
          // Only an unregistered name is a dead link worth forgetting; an
          // unanswered lookup keeps the name for the next authenticated visit.
          if (res?.status === "none") { capture.clearCapturedRef(); return; }
          if (res?.status !== "found") return;
          capture.storeCapturedRef(res.address);
        }

        await resolvePendingName();
        const [{ settleCapturedReferral }, { writeReferralStatement }] = await Promise.all([
          import("./lib/campaign/referral-flow.js"),
          import("./lib/campaign/records.js"),
        ]);
        await settleCapturedReferral({
          parent: auth.parent,
          capturedRef: capture.readCapturedRef,
          getSigner: () => auth.getContentFeedSignerIfPresent(),
          write: writeReferralStatement,
          clear: capture.clearCapturedRef,
        });
      } catch {
        // Every outcome that matters is already a return value; a thrown import
        // or resolver failure just leaves the capture for the next visit.
      } finally {
        refSettleInFlight = false;
      }
    })();
  });

  // A device that has never opened Studio learns the account organises from its
  // public event list, so WoCo shows the way into Studio there too.
  // Unauthenticated, so it never prompts; one look per account per page load.
  const organiserChecked = new Set<string>();
  $effect(() => {
    const parent = auth.ready ? auth.parent?.toLowerCase() : undefined;
    if (!parent || studioRole.isOrganiser || organiserChecked.has(parent)) return;
    organiserChecked.add(parent);
    import("./lib/api/events.js")
      .then((m) => m.getEventsByCreatorResult(parent))
      .then((resp) => { if (resp.ok && (resp.data?.length ?? 0) > 0) studioRole.mark(parent); })
      .catch(() => { /* no Studio link until Studio is opened on this device */ });
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

  // Lazy for the same reason: only someone who followed an invite link pays for it.
  const invitePagePromise = $derived(
    router.route === "invite"
      ? import("./lib/landing/InviteLanding.svelte").then((m) => m.default)
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
{:else if router.route === "invite"}
  {#await invitePagePromise}
    <div class="surface-loading">Loading…</div>
  {:then Comp}
    {#if Comp}
      <Comp token={router.params.token ?? ""} />
    {/if}
  {:catch}
    <div class="surface-loading surface-error">Failed to load. Please refresh.</div>
  {/await}
{:else if router.surface === "neutral"}
  {#if holdingForNameProfile && router.route === "splitter"}
    <div class="surface-loading">Opening {subEnsName(nameHostLabel ?? "")}…</div>
  {:else}
    <Splitter />
  {/if}
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
<AccountSetupSheet />

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
