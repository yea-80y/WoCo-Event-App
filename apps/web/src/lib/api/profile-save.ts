/**
 * The two decisions a profile save rests on, kept free of the auth store so the
 * node test runner can load them.
 *
 * A save rewrites the WHOLE profile: every field it does not set is carried
 * forward from a base it read first. So the base must be the newest version,
 * and the form must not re-send what it did not change. Either one wrong and the
 * save reverts the previous save or blanks the profile, while reporting success
 * (#171, #651).
 */

import type { UpdateProfileRequest, UserProfile } from "@woco/shared";
import type { ContentFeedResult } from "../swarm/content-feed.js";

export const PROFILE_BASE_RETRY =
  "Couldn't load your current profile to update it - check your connection and try again. Nothing was changed.";
export const PROFILE_BASE_RELOAD =
  "Your saved profile can't be read by this version of WoCo, so it wasn't changed. Reload to update the app, then try again.";

/**
 * The profile a save may merge onto, or why it must not proceed.
 *
 * Only a definitive "no profile here" may start from nothing, and only a found
 * version whose scan was CLEAN may be merged onto. A found version under a dirty
 * scan is the best version this read could reach, not necessarily the newest:
 * merging onto it reverts whatever the unreachable version held.
 */
export function profileSaveBase(
  read: ContentFeedResult<UserProfile>,
): { ok: true; base: UserProfile | null } | { ok: false; error: string } {
  if (read.status === "absent") return { ok: true, base: null };
  if (read.status === "found") {
    return read.scanClean ? { ok: true, base: read.value } : { ok: false, error: PROFILE_BASE_RETRY };
  }
  // A permanent verdict must not be dressed as a connection problem: the user
  // would retry forever on advice that cannot work (#190). Reloading CAN work -
  // the usual cause is an app older than the payload it is being asked to read.
  return { ok: false, error: read.unusableAt !== undefined ? PROFILE_BASE_RELOAD : PROFILE_BASE_RETRY };
}

export const PROFILE_FORM_FIELDS = ["displayName", "bio", "website", "twitterHandle", "farcasterHandle"] as const;
export type ProfileFormFields = Record<(typeof PROFILE_FORM_FIELDS)[number], string>;

/**
 * Only the fields the user changed since the form was filled.
 *
 * The form is filled from a display read, which can lag a save by minutes (an
 * Etherna write reaches our bee late). Re-sending an untouched field would write
 * that stale value over the newer profile the save's own base read found.
 *
 * A field changed to empty is not sent, which keeps its current value: the merge
 * treats a missing field as "keep", and clearing has no representation yet (#652).
 */
export function changedProfileFields(current: ProfileFormFields, loaded: ProfileFormFields): UpdateProfileRequest {
  const changes: UpdateProfileRequest = {};
  for (const field of PROFILE_FORM_FIELDS) {
    if (current[field] !== loaded[field] && current[field] !== "") changes[field] = current[field];
  }
  return changes;
}
