import type { Hex0x } from "../types.js";

/** User profile stored in Swarm feed */
export interface UserProfile {
  v: 1;
  address: Hex0x;
  displayName?: string;
  bio?: string;
  website?: string;
  twitterHandle?: string;
  farcasterHandle?: string;
  avatarRef?: string;
  /** Claimed sub-ENS label (e.g. "punkpub" for punkpub.woco.eth). Makes the
   *  profile a likeable/followable subject — its namehash is the like subject
   *  (see `profileSubject`). Written client-side after a successful claim. */
  subEnsLabel?: string;
  updatedAt: string;
}

/** Request body for POST /api/profile */
export interface UpdateProfileRequest {
  displayName?: string;
  bio?: string;
  website?: string;
  twitterHandle?: string;
  farcasterHandle?: string;
  /** Sub-ENS label to bind to this profile. The server verifies the caller
   *  owns `{label}.woco.eth` on-chain before persisting (see profiles route). */
  subEnsLabel?: string;
}

/** Request body for POST /api/profile/avatar */
export interface UploadAvatarRequest {
  /** Base64-encoded image data */
  image: string;
}
