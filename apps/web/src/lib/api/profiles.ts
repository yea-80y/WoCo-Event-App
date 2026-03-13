import type { UserProfile, UpdateProfileRequest } from "@woco/shared";
import { authPost, get } from "./client.js";

// ---------------------------------------------------------------------------
// In-memory cache — profile data changes rarely
// ---------------------------------------------------------------------------

const profileCache = new Map<string, { profile: UserProfile | null; fetchedAt: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function cacheHit(address: string): UserProfile | null | undefined {
  const entry = profileCache.get(address.toLowerCase());
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt > CACHE_TTL) {
    profileCache.delete(address.toLowerCase());
    return undefined;
  }
  return entry.profile;
}

function cacheStore(address: string, profile: UserProfile | null) {
  profileCache.set(address.toLowerCase(), { profile, fetchedAt: Date.now() });
}

/** Invalidate cache for an address (after update). */
export function invalidateProfileCache(address: string) {
  profileCache.delete(address.toLowerCase());
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

/** Fetch a user's profile (public, unauthenticated). */
export async function getProfile(address: string): Promise<UserProfile | null> {
  const cached = cacheHit(address);
  if (cached !== undefined) return cached;

  try {
    const resp = await get<UserProfile | null>(`/api/profile/${address.toLowerCase()}`);
    const profile = resp.ok ? (resp.data ?? null) : null;
    cacheStore(address, profile);
    return profile;
  } catch {
    return null;
  }
}

/** Update the authenticated user's profile. */
export async function updateProfile(updates: UpdateProfileRequest): Promise<UserProfile | null> {
  const resp = await authPost<UserProfile>("/api/profile", updates as Record<string, unknown>);
  if (resp.ok && resp.data) {
    cacheStore(resp.data.address, resp.data);
    return resp.data;
  }
  throw new Error(resp.error ?? "Failed to update profile");
}

/** Upload avatar for the authenticated user. Returns the Swarm ref. */
export async function uploadAvatar(imageDataUrl: string): Promise<string> {
  const resp = await authPost<{ avatarRef: string }>("/api/profile/avatar", { image: imageDataUrl });
  if (resp.ok && resp.data) {
    return resp.data.avatarRef;
  }
  throw new Error(resp.error ?? "Failed to upload avatar");
}
