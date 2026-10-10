import type { UpdateProfileRequest, UserProfile } from "./types.js";

/** The profile's free-text fields: the form, the client save and the server save all use this list. */
export const PROFILE_TEXT_FIELDS = ["displayName", "bio", "website", "twitterHandle", "farcasterHandle"] as const;
export type ProfileTextField = (typeof PROFILE_TEXT_FIELDS)[number];
export type ProfileText = Partial<Pick<UserProfile, ProfileTextField>>;

/**
 * The text fields a profile save writes. A field the request sets to a string
 * takes it; `null` or an empty string REMOVES it (#652); a field the request
 * leaves out keeps its current value.
 *
 * Anything else in a field - a number, an object, from a malformed request - is
 * ignored and the current value kept: only an explicit clear may remove.
 *
 * Shared by both save paths - the client's own feed and the server's - so an
 * account cannot be left holding a value it cleared because of which path it
 * saved through.
 */
export function mergeProfileText(updates: UpdateProfileRequest, existing: ProfileText | null | undefined): ProfileText {
  const merged: ProfileText = {};
  for (const field of PROFILE_TEXT_FIELDS) {
    const update: unknown = updates[field];
    if (update === null || update === "") continue;
    const value = typeof update === "string" ? update : existing?.[field];
    if (typeof value === "string" && value !== "") merged[field] = value;
  }
  return merged;
}
