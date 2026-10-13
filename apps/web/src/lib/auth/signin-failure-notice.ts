/**
 * A coded sign-in failure, as the screen shows it - wherever it is shown.
 *
 * A failure with no words of its own carries a copyable code and, behind a tap,
 * Web3Auth's own reason redacted on the device (#848, #854; `signin-failure.ts`).
 * The email button showed both, but a redirect sign-in (iPhone/iPad, #860) fails
 * on a page that has just LOADED, where the only surface is the sign-in sheet's
 * banner - and that took one flattened line, so the details were lost exactly
 * where they were needed (an iPhone, 2026-10-12: no "Show details"). So the
 * failure travels as this shape: posted once, read once, rendered by the one
 * `SignInFailureDetails` component everywhere.
 *
 * Nothing here is new information: `detail` is already redacted
 * (`signInFailureDetail`) and `code` is built never to copy a message. Kept in
 * sessionStorage (this tab only) for the moment between the store posting it and
 * the sheet reading it, then removed.
 */

import { isSignInFailedError, redactReason, SIGN_IN_FAILED_MESSAGE, SIGN_IN_DETAIL_MAX } from "./signin-failure.js";

export const SIGN_IN_FAILURE_KEY = "woco:auth-failure";

export type SignInFailureView = {
  /** The line the person reads. */
  message: string;
  /** The copyable code, when the failure has one. */
  code: string | null;
  /** Web3Auth's own reason, redacted - behind "Show details". */
  detail: string | null;
};

const MESSAGE_MAX = 160;
const CODE_MAX = 200;

/** What to show for a failed sign-in attempt. */
export function signInFailureView(e: unknown): SignInFailureView {
  if (isSignInFailedError(e)) return { message: e.message, code: e.code, detail: e.detail };
  return { message: e instanceof Error ? e.message.slice(0, MESSAGE_MAX) : SIGN_IN_FAILED_MESSAGE, code: null, detail: null };
}

/** Hand a failure to the sign-in sheet (it opens on it). */
export function postSignInFailure(storage: Pick<Storage, "setItem"> | null | undefined, view: SignInFailureView): void {
  try {
    storage?.setItem(SIGN_IN_FAILURE_KEY, JSON.stringify(view));
  } catch {
    /* the explanation is never a step */
  }
}

const capped = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;

/** The posted failure, once; anything malformed reads as none. */
export function takeSignInFailure(storage: Pick<Storage, "getItem" | "removeItem"> | null | undefined): SignInFailureView | null {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(SIGN_IN_FAILURE_KEY) ?? null;
    if (raw !== null) storage?.removeItem(SIGN_IN_FAILURE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const message = capped(v.message, MESSAGE_MAX);
    if (!message) return null;
    // A detail longer than the redaction ever produces was not written by it.
    // Redacted again on the way out: whatever wrote this entry, nothing unredacted is shown.
    const stored = capped(v.detail, SIGN_IN_DETAIL_MAX);
    const detail = stored === null ? null : redactReason(stored);
    return { message, code: capped(v.code, CODE_MAX), detail };
  } catch {
    return null;
  }
}
