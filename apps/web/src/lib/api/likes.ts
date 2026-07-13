/**
 * Likes API client (#4). Wraps the /api/likes endpoints and exposes a single
 * `toggleLike()` orchestrator so UI (LikeButton) stays thin: the on-chain
 * attest/revoke ordering + sign-in gate + projection record all live here, not
 * in the component.
 *
 * Reads hit the server projection today; they're a cache over on-chain truth
 * (feedback_client_first_architecture) and can later move to chain/EAS-indexer
 * without touching callers.
 */

import type { Hex0x, LikeSubject, LikeCount, TrendingSubject, SubjectType } from "@woco/shared";
import { authPost } from "./client.js";
import { requireAccountForAction } from "../auth/ensure-action.js";

const BASE =
  (typeof window !== "undefined" &&
    (window as unknown as { SITE_CONFIG?: { apiUrl?: string } }).SITE_CONFIG?.apiUrl) ||
  import.meta.env.VITE_API_URL ||
  "";

async function publicGet<T>(path: string): Promise<T | null> {
  try {
    const resp = await fetch(`${BASE}${path}`);
    const json = (await resp.json()) as { ok: boolean; data?: T };
    return json.ok && json.data !== undefined ? json.data : null;
  } catch {
    return null;
  }
}

/** Count + viewer state for a subject. Pass the viewer address to learn
 *  likedByViewer + viewerUid (needed to unlike). */
export function getLikeCount(
  subjectType: SubjectType,
  id: Hex0x,
  viewer?: string,
): Promise<LikeCount | null> {
  const q = viewer ? `?viewer=${viewer}` : "";
  return publicGet<LikeCount>(`/api/likes/${subjectType}/${id}${q}`);
}

/** Subjects an address likes (the "Following" view). */
export function getFollowing(address: string): Promise<LikeSubject[] | null> {
  return publicGet<LikeSubject[]>(`/api/likes/following/${address}`);
}

/** Top subjects by like count. */
export function getTrending(subjectType?: SubjectType, limit = 20): Promise<TrendingSubject[] | null> {
  const params = new URLSearchParams();
  if (subjectType !== undefined) params.set("subjectType", String(subjectType));
  params.set("limit", String(limit));
  return publicGet<TrendingSubject[]>(`/api/likes/trending?${params}`);
}

/** Record an on-chain attest/revoke into the server projection (auth + verified on-chain). */
function recordLike(input: {
  subject: Hex0x;
  subjectType: SubjectType;
  uid: Hex0x;
  action: "like" | "unlike";
}) {
  return authPost<LikeCount>("/api/likes/record", input);
}

export interface ToggleResult {
  liked: boolean;
  count: number;
  /** The viewer's attestation UID after a like (needed for a later unlike). */
  viewerUid?: Hex0x;
}

/**
 * Toggle a like end-to-end: sign-in gate → on-chain attest/revoke → record into
 * projection. Returns null if the user cancelled login. The component drives
 * optimistic UI and reconciles with the returned count.
 *
 * @param currentlyLiked  current viewer state (from getLikeCount.likedByViewer)
 * @param viewerUid       the viewer's attestation UID (from getLikeCount.viewerUid);
 *                        REQUIRED to unlike.
 */
export async function toggleLike(
  subject: LikeSubject,
  currentlyLiked: boolean,
  viewerUid?: Hex0x,
): Promise<ToggleResult | null> {
  const ready = await requireAccountForAction({ onChain: true });
  if (!ready) return null;

  // attest.js drags the EAS + ZeroDev/viem graph — load it only when a like is
  // actually toggled (LikeButton is rendered on every event card at first paint).
  const { attestLike, revokeLike } = await import("../eas/attest.js");

  if (!currentlyLiked) {
    const { uid } = await attestLike(subject);
    const res = await recordLike({ subject: subject.id, subjectType: subject.type, uid, action: "like" });
    if (!res.ok || !res.data) throw new Error(res.error ?? "Failed to record like");
    // The server's LikeCount carries viewerUid for the authed parent; fall back
    // to the on-chain uid we just minted if the projection lags.
    return { liked: true, count: res.data.count, viewerUid: res.data.viewerUid ?? uid };
  }

  if (!viewerUid) throw new Error("Missing attestation UID — cannot unlike.");
  await revokeLike(viewerUid);
  const res = await recordLike({ subject: subject.id, subjectType: subject.type, uid: viewerUid, action: "unlike" });
  if (!res.ok || !res.data) throw new Error(res.error ?? "Failed to record unlike");
  return { liked: false, count: res.data.count };
}
