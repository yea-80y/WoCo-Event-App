/**
 * In-memory per-event navigation hints, set when navigating to an event from a
 * listing (home, profile, directory) and read by EventDetail.
 *
 * - apiUrl: external API base for federated (self-hosted) events.
 * - feedSigner (Phase B): the organiser's content-feed-signer address (the SOC
 *   owner). Carried from the directory entry so EventDetail reads the client-owned
 *   event feed DIRECTLY from the gateway (computed-address SOC, self-authenticating)
 *   instead of proxying through the server — the server's own read hits the same
 *   gateway, so the hop buys nothing.
 */
import { apiBase } from "./client.js";

const apiRegistry = new Map<string, string>();
const signerRegistry = new Map<string, string>();

const normalize = (url: string) => url.trim().replace(/\/+$/, "").toLowerCase();

export function setExternalEventApi(eventId: string, apiUrl: string): void {
  // Directory entries carry apiUrl even when it IS our own API. Registering it
  // would route the event through the external-event surface (EventPage — no
  // likes/social UI) instead of the native EventDetail. Only genuinely foreign
  // servers belong in this registry.
  if (normalize(apiUrl) === normalize(apiBase)) {
    apiRegistry.delete(eventId);
    return;
  }
  apiRegistry.set(eventId, apiUrl);
}

export function getExternalEventApi(eventId: string): string | undefined {
  return apiRegistry.get(eventId);
}

/** Stash the organiser's content-feed-signer (discovery carrier) for an event. */
export function setEventFeedSigner(eventId: string, signer: string | undefined): void {
  if (signer) signerRegistry.set(eventId, signer.toLowerCase());
}

/** The organiser's content-feed-signer for an event, if a listing carried it. */
export function getEventFeedSigner(eventId: string): string | undefined {
  return signerRegistry.get(eventId);
}
