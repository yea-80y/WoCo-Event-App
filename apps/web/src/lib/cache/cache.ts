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
} as const;

// ---------------------------------------------------------------------------
// Typed key builders — single source of truth for key shapes
// ---------------------------------------------------------------------------

export const cacheKey = {
  event: (eventId: string) => `event:${eventId}`,
  directory: () => "events:directory",
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
};
