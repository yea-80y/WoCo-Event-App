/**
 * Whether an authenticated request may start a sign-in to get a session.
 *
 * An ordinary request may: `ensureSession` signs a delegation, silently for most
 * logins. A BACKGROUND request (the organiser dashboard's order poll) must not -
 * `ensureSession` can ask for the passkey once the unlock has lapsed, and it
 * would quietly mint a new session for an account signed out in another tab. Such
 * a request passes `establish: false` and fails instead (Fable sign-off on the
 * live dashboard orders, 2026-10-14).
 */

export interface RequestSigningOptions {
  /** False: never start a sign-in for this request - no usable session here means it fails. */
  establish?: boolean;
}

/** Before signing: a session in memory, or (when allowed) one established now. */
export async function sessionForRequest(
  deps: { hasSession: () => boolean; ensureSession: () => Promise<boolean> },
  opts: RequestSigningOptions = {},
): Promise<boolean> {
  if (deps.hasSession()) return true;
  if (opts.establish === false) return false;
  return deps.ensureSession();
}

/**
 * Sign with the stored session. The in-memory flag can outlive the stored
 * delegation (expired, signed out elsewhere, storage cleared): then, when allowed,
 * forget it and establish a new one once.
 */
export async function signWithStoredSession<R>(
  deps: {
    sign: () => Promise<R | null>;
    forget: () => void;
    ensureSession: () => Promise<boolean>;
  },
  opts: RequestSigningOptions = {},
): Promise<R | null> {
  const result = await deps.sign();
  if (result || opts.establish === false) return result;
  deps.forget();
  if (!(await deps.ensureSession())) return null;
  return deps.sign();
}
