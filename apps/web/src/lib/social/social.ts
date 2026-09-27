/**
 * Likes and follows for the signed-in user: the auth store supplies the signer,
 * `social-core.ts` does the rest (and says what a statement is).
 */

import { auth } from "../auth/auth-store.svelte.js";
import type { Hex0x } from "@woco/shared";
import {
  readFollows,
  readStatement,
  readSubjects,
  writeStatement,
  type MyFollowsRead,
  type SocialKind,
  type SocialSigner,
  type SocialWriteResult,
} from "./social-core.js";

export type { MyFollowsRead, SocialKind, SocialWriteResult } from "./social-core.js";

async function requireSigner(): Promise<SocialSigner> {
  const signer = await auth.getContentFeedSigner();
  if (!signer) throw new Error("Sign in to like or follow — a statement is signed by your own key.");
  return { privKey: signer.privKey, address: signer.address };
}

/** The caller's current statement about `subject` - see `readStatement`. */
export async function readMyStatement(kind: SocialKind, subject: Hex0x): Promise<boolean | null> {
  const signer = await auth.getContentFeedSigner();
  if (!signer) return null;
  return readStatement(signer, kind, subject);
}

/** Write the caller's statement about `subject` - see `writeStatement`. */
export async function writeMyStatement(kind: SocialKind, subject: Hex0x, value: boolean): Promise<SocialWriteResult> {
  let signer: SocialSigner;
  try {
    signer = await requireSigner();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save that." };
  }
  return writeStatement(signer, kind, subject, value);
}

/** Every subject the caller has ever written a statement about, for this kind. */
export async function readMySubjects(kind: SocialKind): Promise<Hex0x[]> {
  const signer = await auth.getContentFeedSigner();
  if (!signer) return [];
  return readSubjects(signer, kind);
}

/**
 * The accounts this user currently follows, for a screen that must never raise
 * a prompt: only a seed already on this device is used, and `not-ready` means
 * there is none yet. `readMySubjects` cannot serve here — its signer getter
 * prompts on web3 and passkey.
 */
export async function readMyFollowsIfReady(): Promise<MyFollowsRead> {
  const signer = await auth.getContentFeedSignerIfPresent();
  if (!signer) return { status: "not-ready" };
  return readFollows(signer);
}
