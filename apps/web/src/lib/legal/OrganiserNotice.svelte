<script lang="ts">
  /**
   * Loads and shows an organiser's privacy notice for an event or a site. Shared
   * by the main app's notice page, the single-event page and organiser sites.
   *
   * Shows ONLY a notice the organiser confirmed (owner decision 2026-10-11). Until
   * they confirm one, the page says so plainly rather than showing WoCo's pre-filled
   * draft in their name - and nothing of theirs is on sale meanwhile, because the
   * server refuses every hold and checkout for them (notice-gate.ts).
   */
  import { onMount } from "svelte";
  import { WOCO_PRIVACY_EMAIL } from "@woco/shared";
  import OrganiserNoticeView from "./OrganiserNoticeView.svelte";
  import { fetchEventNotice, fetchSiteNotice, publicNoticeView, WOCO_POLICY_URL, type PublicNoticeData } from "./organiser-notice.js";

  interface Props {
    eventId?: string;
    siteId?: string;
    apiUrl?: string;
    /** The organiser name the page already shows. */
    name?: string;
    contactForm?: boolean;
    /** Lets a parent learn the trusted creator (to look up a display name). */
    onloaded?: (data: PublicNoticeData | null) => void;
  }

  let { eventId, siteId, apiUrl, name, contactForm, onloaded }: Props = $props();

  /** `undefined` until the server answers; `null` if it could not. */
  let data = $state<PublicNoticeData | null | undefined>(undefined);
  const view = $derived(publicNoticeView(data, { name, contactForm }));

  onMount(() => {
    const load = eventId ? fetchEventNotice(eventId, apiUrl) : siteId ? fetchSiteNotice(siteId, apiUrl) : Promise.resolve(null);
    load
      .catch(() => null)
      .then((d) => {
        data = d;
        onloaded?.(d);
      });
  });
</script>

{#if view.kind === "notice"}
  <OrganiserNoticeView doc={view.doc} />
{:else}
  <article class="notice-state" aria-live="polite">
    <h1>Privacy notice</h1>
    {#if view.kind === "loading"}
      <p class="muted">Loading the organiser's privacy notice…</p>
    {:else if view.kind === "unavailable"}
      <p>The organiser's privacy notice couldn't be loaded just now. Reload the page to try again.</p>
    {:else if view.legacy}
      <p>There's no confirmed privacy notice for this event, and it isn't on sale. The organiser needs to publish it again.</p>
    {:else}
      <p>
        {view.name ?? "The organiser"} hasn't confirmed their privacy notice yet{view.site ? "" : ", so tickets for this event aren't on sale"}.
        Once they confirm it, it appears here.
      </p>
    {/if}
    {#if view.kind !== "loading"}
      <p class="muted">
        For how WoCo itself handles your details, see the
        <a href={WOCO_POLICY_URL} target="_blank" rel="noopener noreferrer">WoCo Privacy Policy</a>
        or write to <a href="mailto:{WOCO_PRIVACY_EMAIL}">{WOCO_PRIVACY_EMAIL}</a>.
      </p>
    {/if}
  </article>
{/if}

<style>
  .notice-state {
    color: var(--text-primary, var(--text));
    font-size: 0.9375rem;
    line-height: 1.6;
    max-width: 720px;
  }
  .notice-state h1 {
    font-size: 1.5rem;
    margin: 0 0 1rem;
  }
  .notice-state p {
    margin: 0 0 0.625rem;
  }
  .notice-state a {
    color: var(--accent);
    text-decoration: underline;
  }
  .muted {
    color: var(--text-muted, var(--muted));
  }
</style>
