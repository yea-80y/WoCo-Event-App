import type { Hex0x, UserProfile, UpdateProfileRequest } from "@woco/shared";
import { uploadToBytes } from "../swarm/bytes.js";
import {
  readFeedPage,
  writeFeedPage,
  encodeJsonFeed,
  decodeJsonFeed,
} from "../swarm/feeds.js";
import { topicProfileData, topicProfileAvatar } from "../swarm/topics.js";
import { whitelistHashes } from "../swarm/whitelist.js";

// ---------------------------------------------------------------------------
// Read profile
// ---------------------------------------------------------------------------

export async function getProfile(address: string): Promise<UserProfile | null> {
  const addr = address.toLowerCase() as Hex0x;

  // Read profile data feed
  const dataPage = await readFeedPage(topicProfileData(addr));
  let profile: UserProfile | null = null;
  if (dataPage) {
    profile = decodeJsonFeed<UserProfile>(dataPage);
  }

  // Read avatar feed separately (so avatar can be updated independently)
  const avatarPage = await readFeedPage(topicProfileAvatar(addr));
  if (avatarPage) {
    const avatarData = decodeJsonFeed<{ v: 1; avatarRef: string }>(avatarPage);
    if (avatarData?.avatarRef) {
      if (profile) {
        profile.avatarRef = avatarData.avatarRef;
      } else {
        profile = {
          v: 1,
          address: addr,
          avatarRef: avatarData.avatarRef,
          updatedAt: new Date().toISOString(),
        };
      }
    }
  }

  return profile;
}

// ---------------------------------------------------------------------------
// Update profile display data
// ---------------------------------------------------------------------------

export async function updateProfile(
  address: string,
  updates: UpdateProfileRequest,
): Promise<UserProfile> {
  const addr = address.toLowerCase() as Hex0x;

  // Read existing profile (if any)
  let existing: UserProfile | null = null;
  const dataPage = await readFeedPage(topicProfileData(addr));
  if (dataPage) {
    existing = decodeJsonFeed<UserProfile>(dataPage);
  }

  const profile: UserProfile = {
    v: 1,
    address: addr,
    displayName: updates.displayName ?? existing?.displayName,
    bio: updates.bio ?? existing?.bio,
    website: updates.website ?? existing?.website,
    twitterHandle: updates.twitterHandle ?? existing?.twitterHandle,
    farcasterHandle: updates.farcasterHandle ?? existing?.farcasterHandle,
    // Carry forward so a later display-name edit doesn't wipe the bound name.
    subEnsLabel: updates.subEnsLabel ?? existing?.subEnsLabel,
    updatedAt: new Date().toISOString(),
  };

  // Synchronous upload — profile reads happen immediately after writes
  // (user navigates away and back), so deferred propagation causes stale reads.
  await writeFeedPage(topicProfileData(addr), encodeJsonFeed(profile), { deferred: false });
  console.log(`[profile] wrote feed for ${addr}, subEnsLabel=${profile.subEnsLabel ?? 'none'}`);

  // Verify the write is immediately readable
  const verify = await readFeedPage(topicProfileData(addr));
  console.log(`[profile] read-back after write: ${verify ? `${verify.length} bytes` : 'NULL'}`);

  // Merge avatar ref from existing data (not stored in this feed)
  if (existing?.avatarRef) {
    profile.avatarRef = existing.avatarRef;
  }

  return profile;
}

// ---------------------------------------------------------------------------
// Upload avatar
// ---------------------------------------------------------------------------

export async function uploadAvatar(
  address: string,
  imageData: Uint8Array,
  opts: { writeFeed?: boolean } = {},
): Promise<string> {
  const addr = address.toLowerCase();

  // Upload image bytes to Swarm (the server lends postage either way).
  const avatarRef = await uploadToBytes(imageData);

  // The proxy 403s unwhitelisted content, and UserAvatar reads the image
  // gateway-direct (/bytes/{avatarRef}) — so the gateway can't serve it unless
  // we whitelist the ref. Awaited (not fire-and-forget) because the client
  // re-reads the avatar immediately after this returns. Mirrors event/POD images.
  try {
    await whitelistHashes([avatarRef]);
  } catch (err) {
    console.warn("[profile] avatar whitelist failed (non-fatal):", err);
  }

  // Phase B: a client-owned profile signs its own avatar feed SOC — the server
  // has no key for it and must NOT write the platform feed. The route passes
  // writeFeed:false in that case and the client writes the SOC. Legacy users
  // (no client feed signer): platform-signed write here as before.
  if (opts.writeFeed !== false) {
    const avatarDoc = { v: 1, avatarRef };
    await writeFeedPage(topicProfileAvatar(addr), encodeJsonFeed(avatarDoc));
  }

  return avatarRef;
}
