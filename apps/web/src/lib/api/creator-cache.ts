/**
 * Stale-while-revalidate wrappers for the creator portal.
 *
 * Pattern: each helper returns { cached, refresh }.
 *   - cached:  data from localStorage if present (null if first visit). Show
 *              this immediately for instant paint.
 *   - refresh: lazy fetch. Caller decides when to fire (e.g. after
 *              auth.ensureSession()). On success it writes back to the cache
 *              and returns the fresh value. Never throws — a failure comes back
 *              as `{ ok: false }`.
 *
 * refresh() returns the ApiResponse envelope rather than `T | null` because a
 * null conflated "you have none" with "we could not find out" (#291). Callers
 * collapsed both into "No events yet", so a rejected session, an offline phone
 * and a 500 all rendered as an organiser's work having vanished. `ok: false` is
 * the caller's cue to say it could not load, and `code` is there for the few
 * screens that take a session-specific action (see isSessionInvalid in
 * api/errors.ts). getPayoutsSWR in api/payouts.ts already worked this way; this
 * brings the creator lists to the same contract.
 *
 * Usage in components:
 *   const { cached, refresh } = getMyEventsSWR(addr);
 *   if (cached) { events = cached; loading = false; }
 *   const next = await refresh();
 *   if (next.ok && next.data) events = next.data;
 *   else if (!cached) loadFailed = true;   // never render this as "none yet"
 *   loading = false;
 *
 * Cache entries are keyed per-address (or per-eventId for admin views) so a
 * shared device + sign-out cycle never reveals another user's data — and
 * auth-store.logout() wipes USER_SCOPED_PREFIXES on its way out.
 */

import type { ApiResponse, EventDirectoryEntry, EventFeed, SiteDirectoryEntry, ShopDirectoryEntry } from "@woco/shared";
import { authGet } from "./client.js";
import { cacheGet, cacheSet, cacheKey, TTL } from "../cache/cache.js";
import {
  getEventOrders,
  type EventOrdersResponse,
} from "./events.js";

export interface SWRResult<T> {
  /** Cached value, or null if no cache hit. Show this immediately. */
  cached: T | null;
  /** Fire a fresh fetch when ready. Never throws; a failure is `ok: false`. */
  refresh: () => Promise<ApiResponse<T>>;
}

/** Turn a thrown error into the same envelope every other path returns, so a
 *  caller never has to handle two failure shapes for one read. */
function failed<T>(err: unknown, fallback: string): ApiResponse<T> {
  return { ok: false, error: err instanceof Error ? err.message : fallback };
}

// ---------------------------------------------------------------------------
// Creator events list — /api/events/mine
// ---------------------------------------------------------------------------

export function getMyEventsSWR(address: string): SWRResult<EventDirectoryEntry[]> {
  const key = cacheKey.creatorEvents(address);
  const cached = cacheGet<EventDirectoryEntry[]>(key);
  const refresh = async (): Promise<ApiResponse<EventDirectoryEntry[]>> => {
    try {
      const resp = await authGet<EventDirectoryEntry[]>("/api/events/mine");
      if (!resp.ok || !resp.data) return resp.ok ? { ok: false, error: "Empty response" } : resp;
      // Never poison the cache with an empty response — could be a transient
      // auth/identity mismatch (session bound to wrong parentAddress, etc).
      // Callers still get the fresh value and decide whether to render it.
      if (resp.data.length > 0) cacheSet(key, resp.data, TTL.CREATOR_EVENTS);
      return resp;
    } catch (err) {
      return failed(err, "Could not load your events");
    }
  };
  return { cached, refresh };
}

// ---------------------------------------------------------------------------
// Creator sites list — /api/sites/mine
// ---------------------------------------------------------------------------

export function getMySitesSWR(address: string): SWRResult<SiteDirectoryEntry[]> {
  const key = cacheKey.creatorSites(address);
  const cached = cacheGet<SiteDirectoryEntry[]>(key);
  const refresh = async (): Promise<ApiResponse<SiteDirectoryEntry[]>> => {
    try {
      const resp = await authGet<SiteDirectoryEntry[]>("/api/sites/mine");
      if (!resp.ok || !resp.data) return resp.ok ? { ok: false, error: "Empty response" } : resp;
      if (resp.data.length > 0) cacheSet(key, resp.data, TTL.CREATOR_SITES);
      return resp;
    } catch (err) {
      return failed(err, "Could not load your sites");
    }
  };
  return { cached, refresh };
}

// ---------------------------------------------------------------------------
// Creator shops list — /api/shops/mine
// ---------------------------------------------------------------------------

export function getMyShopsSWR(address: string): SWRResult<ShopDirectoryEntry[]> {
  const key = cacheKey.creatorShops(address);
  const cached = cacheGet<ShopDirectoryEntry[]>(key);
  const refresh = async (): Promise<ApiResponse<ShopDirectoryEntry[]>> => {
    try {
      const resp = await authGet<ShopDirectoryEntry[]>("/api/shops/mine");
      if (!resp.ok || !resp.data) return resp.ok ? { ok: false, error: "Empty response" } : resp;
      if (resp.data.length > 0) cacheSet(key, resp.data, TTL.CREATOR_SHOPS);
      return resp;
    } catch (err) {
      return failed(err, "Could not load your shops");
    }
  };
  return { cached, refresh };
}

// ---------------------------------------------------------------------------
// Event metadata — /api/events/:id/owned (organiser read; auth'd)
//
// The public /api/events/:id resolves an event's content-feed signer from the
// GLOBAL directory, which an unlisted (skipAutoList) client-signed event is never
// in — so the creator's own dashboard 404s on it. The auth'd route resolves the
// signer from the caller's own creator index instead (issue #14).
// ---------------------------------------------------------------------------

export function getEventSWR(eventId: string): SWRResult<EventFeed> {
  const key = cacheKey.event(eventId);
  const cached = cacheGet<EventFeed>(key);
  const refresh = async (): Promise<ApiResponse<EventFeed>> => {
    try {
      const resp = await authGet<EventFeed>(`/api/events/${eventId}/owned`);
      if (!resp.data) return resp.ok ? { ok: false, error: "Empty response" } : resp;
      cacheSet(key, resp.data, TTL.EVENT);
      return resp;
    } catch (err) {
      return failed(err, "Could not load this event");
    }
  };
  return { cached, refresh };
}

// ---------------------------------------------------------------------------
// Event admin: orders — /api/events/:id/orders
// ---------------------------------------------------------------------------

export function getEventOrdersSWR(eventId: string): SWRResult<EventOrdersResponse> {
  const key = cacheKey.eventOrders(eventId);
  const cached = cacheGet<EventOrdersResponse>(key);
  const refresh = async (): Promise<ApiResponse<EventOrdersResponse>> => {
    try {
      const data = await getEventOrders(eventId);
      cacheSet(key, data, TTL.EVENT_ORDERS);
      return { ok: true, data };
    } catch (err) {
      return failed(err, "Could not load orders");
    }
  };
  return { cached, refresh };
}

// ---------------------------------------------------------------------------
// Event admin: pending approvals — /api/events/:id/pending-claims
// ---------------------------------------------------------------------------
