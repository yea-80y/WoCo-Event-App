/**
 * Feed topics for seating. Shared so every writer and reader derives the same strings.
 *
 * - The organiser's layout library: an index at `woco/seating/layouts/{address}` and one
 *   feed per layout at `woco/seating/layout/{address}/{layoutId}`, owned by their feed
 *   signer. Layouts hold no prices.
 * - An event's seat state (`woco.seatstate.v1`) at `woco/event/{eventId}/seats`, owned by
 *   the same signer as the event feed. Distinct from the event feed's own overflow pages
 *   (`woco/event/{eventId}/p{n}`).
 */

export function seatLayoutLibraryTopic(address: string): string {
  return `woco/seating/layouts/${address.toLowerCase()}`;
}

export function seatLayoutTopic(address: string, layoutId: string): string {
  return `woco/seating/layout/${address.toLowerCase()}/${layoutId}`;
}

export function eventSeatStateTopic(eventId: string): string {
  return `woco/event/${eventId}/seats`;
}
