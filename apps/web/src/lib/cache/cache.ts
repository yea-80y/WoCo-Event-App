/**
 * Lightweight localStorage cache with TTL.
 *
 * Strategy: stale-while-revalidate
 * - Callers always show cached data immediately (no spinner)
 * - Always fire a background fetch; silently patch UI if data changed
 * - TTL controls how long entries live in localStorage (eviction)
 *   NOT whether stale data is shown — stale data is always shown
 *
 * Key format: woco:v1:{key}
 */

const PREFIX = "woco:v1:";

interface CacheEntry<T> {
  data: T;
  cachedAt: number;
  ttl: number | null; // seconds; null = permanent
}

/** Read a cache entry. Returns null if absent or eviction-expired. */
export function cacheGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const entry: CacheEntry<T> = JSON.parse(raw);
    // Evict if TTL has passed (cleanup — data was stale for too long)
    if (entry.ttl !== null && Date.now() > entry.cachedAt + entry.ttl * 1000) {
      localStorage.removeItem(PREFIX + key);
      return null;
    }
    return entry.data;
  } catch {
    return null;
  }
}

/** Write a cache entry. ttlSeconds=null = permanent. Fails silently (quota, private mode). */
export function cacheSet<T>(key: string, data: T, ttlSeconds: number | null): void {
  try {
    const entry: CacheEntry<T> = { data, cachedAt: Date.now(), ttl: ttlSeconds };
    localStorage.setItem(PREFIX + key, JSON.stringify(entry));
  } catch {
    // Quota exceeded or private browsing — degrade gracefully
  }
}

/** Delete a cache entry (e.g. after logout). */
export function cacheDel(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {}
}

/** Clear all woco cache entries (e.g. full sign-out on new device concern). */
export function cacheClearAll(): void {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) toRemove.push(k);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  } catch {}
}

// ---------------------------------------------------------------------------
// TTL constants (seconds)
// ---------------------------------------------------------------------------

export const TTL = {
  /** Truly immutable data — cryptographically signed, never changes. */
  PERMANENT: null as null,
  /** Event/directory data — organizers rarely edit after creation. */
  EVENT: 7 * 24 * 60 * 60,
  /** Claim status — mutable but server enforces at claim time. */
  CLAIM_STATUS: 7 * 24 * 60 * 60,
  /** User's ticket collection. */
  COLLECTION: 7 * 24 * 60 * 60,
  /** Full event list for a deployed site — evict after 2 hours; grid always revalidates in background. */
  SITE_EVENTS: 2 * 60 * 60,
  /** Creator's own events list — long TTL; background refresh patches UI on every load. */
  CREATOR_EVENTS: 24 * 60 * 60,
  /** Creator's own sites list — long TTL; background refresh patches UI on every load. */
  CREATOR_SITES: 24 * 60 * 60,
  /** Event admin order list — server is source of truth; this is just a fast paint cache. */
  EVENT_ORDERS: 24 * 60 * 60,
  /** Pending-approval queue for an event. */
  PENDING_CLAIMS: 24 * 60 * 60,
  /** Shop product catalog for a deployed site section. */
  SHOP_PRODUCTS: 5 * 60,
  /** Merchant's own shop list. */
  CREATOR_SHOPS: 24 * 60 * 60,
  /**
   * Confirmed "no profile published for this address". Suppresses the SOC probe
   * fan-out (gateway 403 + server 404 per miss) that floods the console; short
   * TTL so a freshly published profile appears within minutes.
   */
  PROFILE_MISS: 10 * 60,
} as const;

// ---------------------------------------------------------------------------
// Typed key builders — single source of truth for key shapes
// ---------------------------------------------------------------------------

export const cacheKey = {
  event: (eventId: string) => `event:${eventId}`,
  directory: () => "events:directory:v2",
  /** address is the wallet address (lowercase) or "anon" for unauthenticated checks. */
  claimStatus: (eventId: string, seriesId: string, address = "anon") =>
    `claim-status:${eventId}:${seriesId}:${address}`,
  /** Permanent record that this address claimed this series. */
  claimed: (eventId: string, seriesId: string, address: string) =>
    `claimed:${eventId}:${seriesId}:${address.toLowerCase()}`,
  /** User's collection, keyed by address. */
  collection: (address: string) => `collection:${address.toLowerCase()}`,
  /** Individual ticket POD — immutable. */
  ticket: (ref: string) => `ticket:${ref}`,
  /** Full event list for a deployed site (bundled fetch). */
  siteEvents: (siteId: string) => `site-events:${siteId}`,
  /** Creator's own events list — keyed by creator address. */
  creatorEvents: (address: string) => `creator-events:${address.toLowerCase()}`,
  /** Creator's own sites list — keyed by creator address. */
  creatorSites: (address: string) => `creator-sites:${address.toLowerCase()}`,
  /** Event admin: order list for a given event. */
  eventOrders: (eventId: string) => `event-orders:${eventId}`,
  /** Event admin: pending-approval queue for a given event. */
  pendingClaims: (eventId: string) => `pending-claims:${eventId}`,
  /** Shop product catalog (deployed site section). */
  shopProducts: (shopId: string) => `shop-products:${shopId}`,
  /** Merchant's own shop list. */
  creatorShops: (address: string) => `creator-shops:${address.toLowerCase()}`,
  /** Negative profile-lookup record — see TTL.PROFILE_MISS. */
  profileMiss: (address: string) => `profile-miss:${address.toLowerCase()}`,
};

// ---------------------------------------------------------------------------
// Bulk eviction — user-scoped cache wipe on sign-out
// ---------------------------------------------------------------------------

/**
 * Remove all cache entries whose key starts with any of the given prefixes.
 * Used on logout to prevent the next user on a shared device from seeing
 * the previous user's creator lists, orders, or collection.
 */
export function cacheClearByPrefix(prefixes: string[]): void {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      const inner = k.slice(PREFIX.length);
      if (prefixes.some((p) => inner.startsWith(p))) toRemove.push(k);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  } catch {}
}

/**
 * Prefixes that hold user-specific data and must be cleared on sign-out.
 * Immutable per-event/per-ticket caches are intentionally retained.
 */
export const USER_SCOPED_PREFIXES = [
  "creator-events:",
  "creator-sites:",
  "event-orders:",
  "pending-claims:",
  "collection:",
  "claim-status:",
  "claimed:",
];
