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

import { PROFILE_TEXT_FIELDS, type ProfileTextField, type UpdateProfileRequest, type UserProfile } from "@woco/shared";
import type { ContentFeedResult, SocTransport } from "../swarm/content-feed.js";
import type { FeedRoute } from "../swarm/gateways.js";

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

export const PROFILE_PHOTO_RETRY =
  "Couldn't check your saved photo before changing it - check your connection and try again. Your photo wasn't changed.";

/**
 * Write the profile data feed: read the base, build the profile from it, write it
 * at the version that read proved next (#943) and confirm it landed. If another
 * device took that version in between, read again and build again from theirs,
 * so their save is merged rather than reverted (`writeAtNextVersion`).
 *
 * The base read is thorough and includes the pre-versioning chunk, which is a
 * profile too. No write-time probe: that asked the network about the same
 * never-written version a second time, which is what made a first save fail.
 * Throws `InconclusiveReadError` (message {@link PROFILE_BASE_RETRY}) without
 * writing when the read could not say; refuses an unreadable stored profile.
 */
export async function writeProfileData(args: {
  signer: { privKey: string; address: string };
  topic: string;
  route: FeedRoute;
  build: (existing: UserProfile | null) => UserProfile;
  /** Test seam - production always posts to our server. */
  transport?: SocTransport;
}): Promise<UserProfile> {
  const { writeAtNextVersion } = await import("../swarm/verified-write.js");
  const { data } = await writeAtNextVersion<UserProfile, UserProfile>({
    signerPrivKey: args.signer.privKey,
    ownerAddress: args.signer.address,
    topic: args.topic,
    route: args.route,
    inconclusive: PROFILE_BASE_RETRY,
    build: (read) => {
      const base = profileSaveBase(read);
      if (!base.ok) throw new Error(base.error);
      return args.build(base.base);
    },
    transport: args.transport,
  });
  return data;
}

/**
 * Point the avatar feed at an uploaded image, the same way (#943). A whole
 * replacement, so nothing is built from the read but its version. `skipLegacy`:
 * the probing writer it replaces never looked at the pre-versioning chunk, which
 * cannot change the version chosen, and asking for it costs a missing-chunk search.
 */
export async function writeProfileAvatar(args: {
  signer: { privKey: string; address: string };
  topic: string;
  route: FeedRoute;
  avatarRef: string;
  /** Test seam - production always posts to our server. */
  transport?: SocTransport;
}): Promise<void> {
  const { writeAtNextVersion } = await import("../swarm/verified-write.js");
  await writeAtNextVersion({
    signerPrivKey: args.signer.privKey,
    ownerAddress: args.signer.address,
    topic: args.topic,
    route: args.route,
    skipLegacy: true,
    inconclusive: PROFILE_PHOTO_RETRY,
    build: () => ({ v: 1, avatarRef: args.avatarRef }),
    transport: args.transport,
  });
}

export type ProfileFormFields = Record<ProfileTextField, string>;

/**
 * Only the fields the user changed since the form was filled.
 *
 * The form is filled from a display read, which can lag a save by minutes (an
 * Etherna write reaches our bee late). Re-sending an untouched field would write
 * that stale value over the newer profile the save's own base read found.
 *
 * A field the user emptied is sent as `null`, which removes it (#652). An empty
 * field they never touched is not sent at all - the form can load empty when a
 * read fails, and that must never read as "clear everything" (#171).
 */
export function changedProfileFields(current: ProfileFormFields, loaded: ProfileFormFields): UpdateProfileRequest {
  const changes: UpdateProfileRequest = {};
  for (const field of PROFILE_TEXT_FIELDS) {
    if (current[field] !== loaded[field]) changes[field] = current[field] === "" ? null : current[field];
  }
  return changes;
}
