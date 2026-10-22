/**
 * What the sign-in sheet knows about THIS device, so it can lead with the right button
 * (owner + Fable 10-22). WebAuthn never tells a page whether a passkey exists, so a
 * first-time iPhone user who tapped "Sign in" met iOS's own "no passkeys for this site"
 * sheet. Two facts kept on the device stand in: a passkey pinned here under the window's
 * RP ID, and which way in was last used.
 *
 * UI only. Neither fact is an input to any ceremony or account decision, and both only
 * know this device: a returning user on a new phone reads as new, which is why the
 * first-visit sheet asks rather than assumes (PasskeyLogin's "new" state).
 */

import { StorageKeys, type AuthKind } from "@woco/shared";
import { getKV } from "./storage/indexeddb.js";
import { PASSKEY_WINDOW } from "./passkey-window.js";

export type WayIn = "passkey" | "email";

/**
 * - `known`: a WoCo passkey was used here - sign in leads, tagged "Last used".
 * - `email`: email or social was used last - that button is tagged instead.
 * - `new`: nothing known - sign in and create side by side, each saying who it is for.
 */
export type SheetState = "known" | "email" | "new";

export interface SignInHint {
  /** A passkey is pinned here under the window's RP ID (pins from before it never open). */
  passkeyHere: boolean;
  last: WayIn | null;
}

/** The way in a committed sign-in of `kind` was, or null for one the sheet does not offer. */
export function wayInOf(kind: AuthKind | null): WayIn | null {
  return kind === "passkey" ? "passkey" : kind === "web3auth" ? "email" : null;
}

export function sheetState(hint: SignInHint, organiser: boolean): SheetState {
  // An organiser sheet offers no email, so email last time says nothing there.
  if (hint.last === "email" && !organiser) return "email";
  return hint.passkeyHere ? "known" : "new";
}

/** The hint from what is stored. Pure. */
export function signInHint(pin: { rpId?: unknown } | null, last: unknown, rpId: string): SignInHint {
  return { passkeyHere: pin?.rpId === rpId, last: last === "passkey" || last === "email" ? last : null };
}

/** Never throws: an unreadable store reads as a device we know nothing about. */
export async function readSignInHint(): Promise<SignInHint> {
  const [pin, last] = await Promise.all([
    getKV<{ rpId?: string }>(StorageKeys.PASSKEY_CREDENTIAL).catch(() => null),
    getKV<string>(StorageKeys.LAST_WAY_IN).catch(() => null),
  ]);
  return signInHint(pin, last, new URL(PASSKEY_WINDOW).hostname);
}
