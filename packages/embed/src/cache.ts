/**
 * Lightweight localStorage cache for the embed widget.
 * Identical logic to apps/web/src/lib/cache/cache.ts — kept separate
 * because embed is a standalone IIFE bundle (no shared browser-only imports).
 */

const PREFIX = "woco:v1:";

interface CacheEntry<T> {
  data: T;
  cachedAt: number;
  ttl: number | null;
}

export function cacheGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const entry: CacheEntry<T> = JSON.parse(raw);
    if (entry.ttl !== null && Date.now() > entry.cachedAt + entry.ttl * 1000) {
      localStorage.removeItem(PREFIX + key);
      return null;
    }
    return entry.data;
  } catch {
    return null;
  }
}

export function cacheSet<T>(key: string, data: T, ttlSeconds: number | null): void {
  try {
    const entry: CacheEntry<T> = { data, cachedAt: Date.now(), ttl: ttlSeconds };
    localStorage.setItem(PREFIX + key, JSON.stringify(entry));
  } catch {}
}

export const TTL_7D = 7 * 24 * 60 * 60;

export const embedCacheKey = {
  event: (eventId: string) => `event:${eventId}`,
  claimStatus: (eventId: string, seriesId: string) =>
    `claim-status:${eventId}:${seriesId}:anon`,
};
