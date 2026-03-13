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
  updatedAt: string;
}

/** Request body for POST /api/profile */
export interface UpdateProfileRequest {
  displayName?: string;
  bio?: string;
  website?: string;
  twitterHandle?: string;
  farcasterHandle?: string;
}

/** Request body for POST /api/profile/avatar */
export interface UploadAvatarRequest {
  /** Base64-encoded image data */
  image: string;
}
