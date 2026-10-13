<script lang="ts">
  /**
   * `#/privacy-notice/:eventId` - the organiser's privacy notice for one event, on
   * the main app. Every checkout links here in a new tab (the embed on an
   * organiser's own domain included), so it needs no sign-in and loads lazily.
   */
  import OrganiserNotice from "./OrganiserNotice.svelte";
  import { getProfile } from "../api/profiles.js";
  import { navigate } from "../router/router.svelte.js";
  import { WOCO_POLICY_URL, type PublicNoticeData } from "./organiser-notice.js";

  interface Props {
    eventId: string;
  }
  let { eventId }: Props = $props();

  let name = $state<string | undefined>(undefined);

  function onloaded(d: PublicNoticeData | null) {
    // Only a name the organiser has not confirmed a notice over needs looking up.
    if (!d || d.notice || !d.creator) return;
    getProfile(d.creator, d.feedSigner ?? undefined)
      .then((p) => { if (p?.displayName) name = p.displayName; })
      .catch(() => { /* the notice stays under "the event organiser" */ });
  }
</script>

<main class="notice-page">
  <OrganiserNotice {eventId} {name} {onloaded} />
  <p class="notice-page-links">
    <!-- A button, not a fragment href: under the deploy's <base href> a bare
         fragment resolves onto the gateway (#605). -->
    {#if eventId}
      <button class="link-btn" onclick={() => navigate(`/event/${encodeURIComponent(eventId)}`)}>Back to the event</button>
      <span aria-hidden="true">·</span>
    {/if}
    <a href={WOCO_POLICY_URL} target="_blank" rel="noopener noreferrer">WoCo Privacy Policy</a>
  </p>
</main>

<style>
  .notice-page {
    max-width: 760px;
    margin: 0 auto;
    padding: 2rem 1.25rem 3rem;
  }
  .notice-page-links {
    margin-top: 1.5rem;
    font-size: 0.875rem;
    color: var(--text-muted);
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .notice-page-links a,
  .link-btn {
    color: var(--accent);
  }
  .link-btn {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    cursor: pointer;
  }
</style>
