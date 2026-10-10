/**
 * Open an event from a card or a ticket, carrying what the event page needs to
 * read it fast: a federated organiser's API, and the organiser's feed signer so
 * the page reads their own record without a directory scan.
 */

import { setEventFeedSigner, setExternalEventApi } from "../../api/event-api-registry.js";
import { navigate } from "../../router/router.svelte.js";

export function openEvent(event: { eventId: string; apiUrl?: string; creatorFeedSigner?: string }): void {
  if (event.apiUrl) setExternalEventApi(event.eventId, event.apiUrl);
  setEventFeedSigner(event.eventId, event.creatorFeedSigner);
  navigate(`/event/${event.eventId}`);
}
