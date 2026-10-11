<script lang="ts">
  /**
   * Loads and shows an organiser's privacy notice for an event or a site. Shared
   * by the main app's notice page, the single-event page and organiser sites.
   *
   * Renders the pre-filled notice straight away from what the page already knows
   * (`name`, the site's contact details) and swaps in the organiser's confirmed
   * notice when the server answers: never blank, and never waiting on the network
   * to show an attendee who is responsible for their details.
   */
  import { onMount } from "svelte";
  import OrganiserNoticeView from "./OrganiserNoticeView.svelte";
  import { fetchEventNotice, fetchSiteNotice, publicNoticeDoc, type PublicNoticeData } from "./organiser-notice.js";

  interface Props {
    eventId?: string;
    siteId?: string;
    apiUrl?: string;
    /** The organiser name the page already shows. */
    name?: string;
    contactEmail?: string;
    postalAddress?: string;
    contactForm?: boolean;
    /** Lets a parent learn the trusted creator (to look up a display name). */
    onloaded?: (data: PublicNoticeData | null) => void;
  }
  let { eventId, siteId, apiUrl, name, contactEmail, postalAddress, contactForm, onloaded }: Props = $props();

  let data = $state<PublicNoticeData | null>(null);
  const doc = $derived(publicNoticeDoc(data, { name, contactEmail, postalAddress, contactForm }));

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

<OrganiserNoticeView {doc} />
