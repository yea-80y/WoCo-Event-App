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

export class Web3AuthSignInError extends Error {
  /** They closed the modal or the popup: nothing went wrong, so say nothing. */
  readonly cancelled: boolean;

  constructor(message: string, cancelled = false) {
    super(message);
    this.name = WEB3AUTH_SIGNIN_ERROR_NAME;
    this.cancelled = cancelled;
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
