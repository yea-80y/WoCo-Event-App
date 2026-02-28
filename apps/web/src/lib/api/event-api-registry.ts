/**
 * In-memory registry mapping eventId → external API base URL.
 * Set when navigating to an externally-listed event from the home page.
 * Read by EventDetail to route fetches and claims to the right server.
 */
const registry = new Map<string, string>();

export function setExternalEventApi(eventId: string, apiUrl: string): void {
  registry.set(eventId, apiUrl);
}

export function getExternalEventApi(eventId: string): string | undefined {
  return registry.get(eventId);
}
