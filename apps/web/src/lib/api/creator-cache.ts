/**
 * Stale-while-revalidate wrappers for the creator portal.
 *
 * Pattern: each helper returns { cached, refresh }.
 *   - cached:  data from localStorage if present (null if first visit). Show
 *              this immediately for instant paint.
 *   - refresh: lazy fetch. Caller decides when to fire (e.g. after
 *              auth.ensureSession()). On success it writes back to the cache
 *              and returns the fresh value. Never throws — returns null on
 *              network/auth error so the cached view stays put.
 *
 * Usage in components:
 *   const { cached, refresh } = getMyEventsSWR(addr);
 *   if (cached) { events = cached; loading = false; }
 *   const next = await refresh();
 *   if (next) events = next;
 *   loading = false;
 *
 * Cache entries are keyed per-address (or per-eventId for admin views) so a
 * shared device + sign-out cycle never reveals another user's data — and
 * auth-store.logout() wipes USER_SCOPED_PREFIXES on its way out.
 */

import type { EventDirectoryEntry, EventFeed, SiteDirectoryEntry, ShopDirectoryEntry } from "@woco/shared";
import { authGet } from "./client.js";
import { cacheGet, cacheSet, cacheKey, TTL } from "../cache/cache.js";
import {
  getEventOrders,
  getPendingClaims,
  type EventOrdersResponse,
  type PendingClaimEntry,
} from "./events.js";

export interface SWRResult<T> {
  /** Cached value, or null if no cache hit. Show this immediately. */
  cached: T | null;
  /** Fire a fresh fetch when ready. Resolves to null on network/auth error. */
  refresh: () => Promise<T | null>;
}

// ---------------------------------------------------------------------------
// Creator events list — /api/events/mine
// ---------------------------------------------------------------------------

export function getMyEventsSWR(address: string): SWRResult<EventDirectoryEntry[]> {
  const key = cacheKey.creatorEvents(address);
  const cached = cacheGet<EventDirectoryEntry[]>(key);
  const refresh = async (): Promise<EventDirectoryEntry[] | null> => {
    try {
      const resp = await authGet<EventDirectoryEntry[]>("/api/events/mine");
      if (!resp.ok || !resp.data) return null;
      // Never poison the cache with an empty response — could be a transient
      // auth/identity mismatch (session bound to wrong parentAddress, etc).
      // Callers still get the fresh value and decide whether to render it.
      if (resp.data.length > 0) cacheSet(key, resp.data, TTL.CREATOR_EVENTS);
      return resp.data;
    } catch {
      return null;
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
  const refresh = async (): Promise<SiteDirectoryEntry[] | null> => {
    try {
      const resp = await authGet<SiteDirectoryEntry[]>("/api/sites/mine");
      if (!resp.ok || !resp.data) return null;
      if (resp.data.length > 0) cacheSet(key, resp.data, TTL.CREATOR_SITES);
      return resp.data;
    } catch {
      return null;
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
  const refresh = async (): Promise<ShopDirectoryEntry[] | null> => {
    try {
      const resp = await authGet<ShopDirectoryEntry[]>("/api/shops/mine");
      if (!resp.ok || !resp.data) return null;
      if (resp.data.length > 0) cacheSet(key, resp.data, TTL.CREATOR_SHOPS);
      return resp.data;
    } catch {
      return null;
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
  const refresh = async (): Promise<EventFeed | null> => {
    try {
      const resp = await authGet<EventFeed>(`/api/events/${eventId}/owned`);
      if (!resp.data) return null;
      cacheSet(key, resp.data, TTL.EVENT);
      return resp.data;
    } catch {
      return null;
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
  const refresh = async (): Promise<EventOrdersResponse | null> => {
    try {
      const data = await getEventOrders(eventId);
      cacheSet(key, data, TTL.EVENT_ORDERS);
      return data;
    } catch {
      return null;
    }
  };
  return { cached, refresh };
}

// ---------------------------------------------------------------------------
// Event admin: pending approvals — /api/events/:id/pending-claims
// ---------------------------------------------------------------------------

export function getPendingClaimsSWR(eventId: string): SWRResult<PendingClaimEntry[]> {
  const key = cacheKey.pendingClaims(eventId);
  const cached = cacheGet<PendingClaimEntry[]>(key);
  const refresh = async (): Promise<PendingClaimEntry[] | null> => {
    try {
      const data = await getPendingClaims(eventId);
      if (data.length > 0) cacheSet(key, data, TTL.PENDING_CLAIMS);
      return data;
    } catch {
      return null;
    }
  };
  return { cached, refresh };
}
