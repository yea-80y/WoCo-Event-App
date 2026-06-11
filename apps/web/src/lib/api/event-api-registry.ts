/**
 * In-memory registry mapping eventId → external API base URL.
 * Set when navigating to an externally-listed event from the home page.
 * Read by EventDetail to route fetches and claims to the right server.
 */
import { apiBase } from "./client.js";

const registry = new Map<string, string>();

const normalize = (url: string) => url.trim().replace(/\/+$/, "").toLowerCase();

export function setExternalEventApi(eventId: string, apiUrl: string): void {
  // Directory entries carry apiUrl even when it IS our own API. Registering it
  // would route the event through the external-event surface (EventPage — no
  // likes/social UI) instead of the native EventDetail. Only genuinely foreign
  // servers belong in this registry.
  if (normalize(apiUrl) === normalize(apiBase)) {
    registry.delete(eventId);
    return;
  }
  registry.set(eventId, apiUrl);
}

export function getExternalEventApi(eventId: string): string | undefined {
  return registry.get(eventId);
}
