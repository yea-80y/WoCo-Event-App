/**
 * A Web3Auth sign-in outcome whose message is fit to show the person (#803).
 * Dependency-free so the sign-in button can recognise it without loading the
 * Web3Auth chunk; matched by name, never `instanceof`, across lazy chunks.
 */

export const WEB3AUTH_SIGNIN_ERROR_NAME = "Web3AuthSignInError";

/** The in-memory Web3Auth key is gone (its session ended) and an action needs it. */
export const WEB3AUTH_KEY_GONE_MESSAGE =
  "Your Google or email sign-in has ended on this device - sign out, then sign in again with the same account.";

/** The key is not in memory YET: the reload's background retry is still bringing it back. */
export const WEB3AUTH_KEY_LOADING_MESSAGE =
  "Your Google or email sign-in is still loading - please try again in a moment.";

/** The pop-up's result never reached this page, even after the stalled wait's grace. */
export const WEB3AUTH_TIMED_OUT_MESSAGE =
  "Your Google or email sign-in didn't come back to this page. Tap Try again - or, inside an app's built-in browser, open WoCo in your real browser first.";

/** The browser refused the sign-in window: the panel offers one tap, a fresh gesture, to open it. */
export const WEB3AUTH_POPUP_BLOCKED_MESSAGE = "Your browser kept the sign-in window closed.";

export class Web3AuthSignInError extends Error {
  /** They closed the modal or the popup: nothing went wrong, so say nothing. */
  readonly cancelled: boolean;
  /** The wait ran out with no result (web3auth-signin-wait.ts): offer a retry and the way out. */
  readonly timedOut: boolean;
  /** The pop-up never opened (WEB3AUTH_POPUP_BLOCKED_MESSAGE). */
  readonly blocked: boolean;

  constructor(message: string, cancelled = false, timedOut = false, blocked = false) {
    super(message);
    this.name = WEB3AUTH_SIGNIN_ERROR_NAME;
    this.cancelled = cancelled;
    this.timedOut = timedOut;
    this.blocked = blocked;
  }
}

export function isWeb3AuthSignInError(e: unknown): e is Web3AuthSignInError {
  return e instanceof Error && e.name === WEB3AUTH_SIGNIN_ERROR_NAME;
}

/** The SDK's two ways of saying the person backed out: the modal's close
 *  button, and WalletLoginError 5114 (the login popup was closed). */
export function isWeb3AuthCancel(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.message === "User closed the modal" || (e as { code?: unknown }).code === 5114;
}

/**
 * The browser refused the sign-in pop-up. The sign-in path opens it through
 * customauth's PopupHandler (re-exported by `@web3auth/auth`), whose `open()`
 * throws a plain `Error("popup window is blocked")` with no code; the connector
 * emits that raw error, or wraps it as the cause of its own 5111. `@web3auth/auth`'s
 * own LoginError 5115 is kept for its other pop-ups. Matched at any depth. A browser
 * allows a pop-up only shortly after a tap, and a click that waited on the SDK can miss that.
 */
export function isWeb3AuthPopupBlocked(e: unknown): boolean {
  let x: unknown = e;
  for (let depth = 0; depth < 4 && typeof x === "object" && x !== null; depth++) {
    if ((x as { code?: unknown }).code === 5115) return true;
    const message = (x as { message?: unknown }).message;
    if (typeof message === "string" && message.toLowerCase().includes("popup window is blocked")) return true;
    x = (x as { cause?: unknown }).cause;
  }
  return false;
}
