import type { Hex0x, UserProfile, UpdateProfileRequest } from "@woco/shared";
import { uploadToBytes } from "../swarm/bytes.js";
import {
  readFeedPage,
  writeFeedPage,
  encodeJsonFeed,
  decodeJsonFeed,
} from "../swarm/feeds.js";
import { topicProfileData, topicProfileAvatar } from "../swarm/topics.js";

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
    updatedAt: new Date().toISOString(),
  };

  // Write to Swarm feed
  await writeFeedPage(topicProfileData(addr), encodeJsonFeed(profile));

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
): Promise<string> {
  const addr = address.toLowerCase();

  // Upload image bytes to Swarm
  const avatarRef = await uploadToBytes(imageData);

  // Write avatar reference to its own feed
  const avatarDoc = { v: 1, avatarRef };
  await writeFeedPage(topicProfileAvatar(addr), encodeJsonFeed(avatarDoc));

  return avatarRef;
}
