/**
 * Has the signed-in organiser confirmed their privacy notice? Their tickets do
 * not sell until they have: the server refuses every hold and checkout with
 * `PRIVACY_NOTICE_REQUIRED` (apps/server/src/lib/legal/notice-gate.ts). This is
 * the UI's side of that rule - the Home step and the prompt before a paid
 * publish. It reads the organiser's own feed under their own signer, which is
 * the notice the server reads for their events, and never prompts.
 *
 * "unknown" is its own answer: a read that could not say is never shown as
 * either "confirmed" or "missing".
 */

import { auth } from "../auth/auth-store.svelte.js";
import { canonicalUrl } from "../sub-ens/host-label.js";
import { readOwnNotice, type OwnNoticeRead } from "./organiser-notice.js";

export type OwnNoticeStatus = "confirmed" | "missing" | "unknown";

/** The editor, on the canonical host, for opening in a new tab from a builder. */
export const NOTICE_EDITOR_URL = canonicalUrl("#/creator/privacy-notice");

export function ownNoticeStatusOf(read: OwnNoticeRead | null): OwnNoticeStatus {
  if (!read) return "unknown";
  return read.status === "found" ? "confirmed" : read.status === "absent" ? "missing" : "unknown";
}

export async function ownNoticeStatus(): Promise<OwnNoticeStatus> {
  const parent = auth.parent?.toLowerCase();
  if (!parent) return "unknown";
  try {
    const signer = await auth.getContentFeedSignerAddress();
    if (!signer) return "unknown";
    return ownNoticeStatusOf(await readOwnNotice(parent, signer));
  } catch {
    return "unknown";
  }
}
