import type { EventOrdersResponse } from "./events.js";

/**
 * The browser's cached copy of an event's orders never holds an order's sealed
 * blob (#546). Cached, an attendee's details outlived their erasure for up to a
 * day: the dashboard decrypted the cached blob on first paint, before the
 * server could say the record was gone. First paint shows the rows; the details
 * come only with the fresh response. Applied on read as well as write, so a
 * copy cached before this change is never decrypted.
 */
export function withoutSealedOrders(data: EventOrdersResponse): EventOrdersResponse {
  return { ...data, orders: data.orders.map(({ encryptedOrder: _sealed, ...order }) => order) };
}
