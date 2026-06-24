import type { UserProfile, UpdateProfileRequest } from "@woco/shared";
import { profileDataContentTopic, profileAvatarContentTopic } from "@woco/shared";
import { authPost, get } from "./client.js";
import { auth } from "../auth/auth-store.svelte.js";
import { writeContentFeed, readContentFeed } from "../swarm/content-feed.js";

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
// Client-owned feed (Phase B) read — gateway-direct SOC, no server.
// ---------------------------------------------------------------------------

/**
 * Read a client-owned profile straight from the gateway as the data + avatar
 * SOCs owned by `signer`. Mirrors the server's two-feed merge. Returns null when
 * neither SOC exists (e.g. the user has no client-owned profile / not propagated
 * yet) so the caller can fall back to the legacy server read.
 */
async function readClientProfile(address: string, signer: string): Promise<UserProfile | null> {
  const addr = address.toLowerCase() as UserProfile["address"];
  const [data, avatar] = await Promise.all([
    readContentFeed<UserProfile>(signer, profileDataContentTopic(addr)).catch(() => null),
    readContentFeed<{ v: 1; avatarRef: string }>(signer, profileAvatarContentTopic(addr)).catch(() => null),
  ]);

  let profile: UserProfile | null = data ?? null;
  if (avatar?.avatarRef) {
    if (profile) profile.avatarRef = avatar.avatarRef;
    else profile = { v: 1, address: addr, avatarRef: avatar.avatarRef, updatedAt: new Date().toISOString() };
  }
  return profile;
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

/**
 * Fetch a user's profile (public, unauthenticated).
 *
 * Phase B: a client-owned profile is a SOC owned by the user's content-feed
 * signer. Reads resolve that signer WITHOUT a registry: self-reads derive it
 * locally; reads of someone else's profile use `signerHint` carried alongside the
 * reference (e.g. an event's `creatorFeedSigner`, the SAME signer that owns the
 * organiser's profile). With a signer we read gateway-direct; otherwise (legacy
 * platform-signed profile, or no carrier) we fall back to the server read.
 */
export async function getProfile(address: string, signerHint?: string): Promise<UserProfile | null> {
  const cached = cacheHit(address);
  if (cached !== undefined) return cached;

  // Resolve the content-feed signer ADDRESS: explicit hint, or our own signer
  // when reading our own profile (no carrier needed for self). The self path uses
  // the no-prompt address resolver — a passive avatar read must never trigger a
  // passkey PRF prompt.
  let signer: string | null | undefined = signerHint;
  if (!signer && auth.parent && address.toLowerCase() === auth.parent.toLowerCase()) {
    signer = await auth.getContentFeedSignerAddress();
  }

  if (signer) {
    try {
      const profile = await readClientProfile(address, signer);
      if (profile) {
        cacheStore(address, profile);
        return profile;
      }
    } catch {
      // fall through to the legacy server read
    }
  }

  try {
    const resp = await get<UserProfile | null>(`/api/profile/${address.toLowerCase()}`);
    const profile = resp.ok ? (resp.data ?? null) : null;
    cacheStore(address, profile);
    return profile;
  } catch {
    return null;
  }
}

/**
 * Update the authenticated user's profile.
 *
 * Phase B: when the user owns a content-feed signer, the profile data feed is a
 * SOC the CLIENT signs — the server never writes it. We self-read the existing
 * feed, merge the updates, and sign + upload the SOC (server only stamps). The
 * sub-ENS label still goes through a server ownership check (`/verify-label`)
 * before it is bound. Legacy users (external wallet, no client signer) keep the
 * old server-write path.
 */
export async function updateProfile(updates: UpdateProfileRequest): Promise<UserProfile | null> {
  const signer = await auth.getContentFeedSigner();
  const parent = auth.parent?.toLowerCase();

  if (!signer || !parent) {
    const resp = await authPost<UserProfile>("/api/profile", updates as Record<string, unknown>);
    if (resp.ok && resp.data) {
      cacheStore(resp.data.address, resp.data);
      return resp.data;
    }
    throw new Error(resp.error ?? "Failed to update profile");
  }

  const addr = parent as UserProfile["address"];

  // Bind a sub-ENS label only after the server confirms on-chain ownership.
  let verifiedLabel: string | undefined;
  if (updates.subEnsLabel !== undefined && updates.subEnsLabel !== null && updates.subEnsLabel !== "") {
    const res = await authPost<{ label: string }>("/api/profile/verify-label", {
      subEnsLabel: updates.subEnsLabel,
    });
    if (!res.ok || !res.data) throw new Error(res.error ?? "You do not own that name");
    verifiedLabel = res.data.label;
  }

  // Self-read the existing data feed to carry forward unedited fields.
  const existing = await readContentFeed<UserProfile>(
    signer.address,
    profileDataContentTopic(addr),
  ).catch(() => null);

  const profile: UserProfile = {
    v: 1,
    address: addr,
    displayName: updates.displayName ?? existing?.displayName,
    bio: updates.bio ?? existing?.bio,
    website: updates.website ?? existing?.website,
    twitterHandle: updates.twitterHandle ?? existing?.twitterHandle,
    farcasterHandle: updates.farcasterHandle ?? existing?.farcasterHandle,
    // Carry forward the bound name unless this call set a freshly-verified one.
    subEnsLabel: verifiedLabel ?? existing?.subEnsLabel,
    updatedAt: new Date().toISOString(),
  };

  await writeContentFeed({
    signerPrivKey: signer.privKey,
    topic: profileDataContentTopic(addr),
    data: profile,
  });

  cacheStore(addr, profile);
  return profile;
}

/** Upload avatar for the authenticated user. Returns the Swarm ref. */
export async function uploadAvatar(imageDataUrl: string): Promise<string> {
  const signer = await auth.getContentFeedSigner();
  const parent = auth.parent?.toLowerCase();

  // Legacy (external wallet, no client signer): server uploads + writes the feed.
  if (!signer || !parent) {
    const resp = await authPost<{ avatarRef: string }>("/api/profile/avatar", { image: imageDataUrl });
    if (resp.ok && resp.data) return resp.data.avatarRef;
    throw new Error(resp.error ?? "Failed to upload avatar");
  }

  // Phase B: server only stamps the image bytes (clientOwned skips its feed write);
  // the client signs the avatar feed SOC itself.
  const resp = await authPost<{ avatarRef: string }>("/api/profile/avatar", {
    image: imageDataUrl,
    clientOwned: true,
  });
  if (!resp.ok || !resp.data) throw new Error(resp.error ?? "Failed to upload avatar");
  const avatarRef = resp.data.avatarRef;

  await writeContentFeed({
    signerPrivKey: signer.privKey,
    topic: profileAvatarContentTopic(parent),
    data: { v: 1, avatarRef },
  });

  // Patch the cache with the new ref so navigating back doesn't trigger a
  // gateway re-read before the SOC has propagated (which would blank the avatar).
  const cached = cacheHit(parent);
  cacheStore(
    parent,
    cached
      ? { ...cached, avatarRef }
      : { v: 1, address: parent as UserProfile["address"], avatarRef, updatedAt: new Date().toISOString() },
  );

  return avatarRef;
}
