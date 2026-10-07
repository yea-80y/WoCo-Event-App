/**
 * Surviving-Web3Auth-session handling, shared by the PRIMARY email login
 * (web3auth-account.ts, #182) and the email BACKUP/guardian connector
 * (wallet/backup-signer.ts, #307).
 *
 * Web3Auth keeps its session in localStorage keyed by clientId, so EVERY
 * instance built with our clientId — the login singleton and the backup flow's
 * throwaway instance alike — rehydrates the same stored session, and its
 * `connect()` can then resolve with the SURVIVOR's provider: no modal, no OTP,
 * the previous user's identity silently adopted. #182 closed that on the login
 * surface; #307 is the same hole on the guardian surface, where the stakes are
 * higher — at backup SETUP the adopted identity is registered as the on-chain
 * guardian and the escrow is sealed to it, handing a stranger full takeover
 * power recorded as a deliberate choice.
 *
 * The two flows had already drifted apart once (that is why web3auth-config.ts
 * exists), so the session handling lives here rather than as a third copy.
 */

/** The slice of a Web3Auth instance the survivor logic touches (it extends
 *  SafeEventEmitter, so the listener methods are present; `cachedConnector` is
 *  how the SDK signals that a stored session is asynchronously rehydrating). */
export type Web3AuthSessionInstance = {
  connected: boolean;
  cachedConnector: string | null;
  logout(options?: { cleanup?: boolean }): Promise<void>;
  on(event: string, fn: (...args: unknown[]) => void): void;
  removeListener(event: string, fn: (...args: unknown[]) => void): void;
};

/**
 * What a wait for a stored session found. `pending` is NOT a verdict: a stored
 * session was still rehydrating when the wait ran out, and may be live a moment
 * later. Reading it as "no session" is what signed a valid session out on a slow
 * reload and left it behind for the next sign-in to trip over (#803).
 */
export type Web3AuthRehydration = "connected" | "none" | "pending";

/** Page load: a slow answer keeps the person signed in (restore reads `pending`
 *  as transient and retries), so the wait stays short. */
export const BOOT_REHYDRATION_WAIT_MS = 5_000;

/** An explicit sign-in, sign-out or backup choice: `pending` blocks it outright,
 *  so wait longer before refusing. `init()` resolves before the SDK's connectors
 *  are initialised, so this also covers the login iframe's own start-up. */
export const EXPLICIT_REHYDRATION_WAIT_MS = 20_000;

/**
 * Wait for a cached Web3Auth session to finish rehydrating. In v10 the modal
 * rehydrates the stored connector INSIDE a non-awaited `CONNECTORS_UPDATED`
 * handler, so `w.connected` is still false the instant `init()` resolves — reading
 * it immediately makes a valid session look logged-out (silent logout on refresh)
 * and leaves the SDK in a half-connected state that then bypasses the OTP on the
 * next explicit login. We only block when `cachedConnector` says a session exists;
 * a fresh page (no cache) resolves instantly so the login screen isn't delayed.
 */
export async function awaitWeb3AuthRehydration(
  w: Web3AuthSessionInstance,
  timeoutMs: number = BOOT_REHYDRATION_WAIT_MS,
): Promise<Web3AuthRehydration> {
  if (w.connected) return "connected";
  if (!w.cachedConnector) return "none";

  const { CONNECTOR_EVENTS } = await import("@web3auth/modal");
  // The SDK clears `cachedConnector` before it re-emits a failure, so a failure
  // with the cache still set is read as still pending, never as gone.
  const current = (): Web3AuthRehydration =>
    w.connected ? "connected" : w.cachedConnector ? "pending" : "none";
  return new Promise<Web3AuthRehydration>((resolve) => {
    let settled = false;
    const finish = (v: Web3AuthRehydration) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      w.removeListener(CONNECTOR_EVENTS.CONNECTED, onConnected);
      w.removeListener(CONNECTOR_EVENTS.AUTHORIZED, onConnected);
      w.removeListener(CONNECTOR_EVENTS.ERRORED, onFailed);
      w.removeListener(CONNECTOR_EVENTS.REHYDRATION_ERROR, onFailed);
      resolve(v);
    };
    const onConnected = () => finish("connected");
    const onFailed = () => finish(current());
    const timer = setTimeout(() => finish(current()), timeoutMs);
    w.on(CONNECTOR_EVENTS.CONNECTED, onConnected);
    w.on(CONNECTOR_EVENTS.AUTHORIZED, onConnected);
    w.on(CONNECTOR_EVENTS.ERRORED, onFailed);
    w.on(CONNECTOR_EVENTS.REHYDRATION_ERROR, onFailed);
  });
}

/**
 * The boot restore's reading of a wait (#803). Only a session the SDK has
 * finished with can be `expired`; one still loading is `unavailable` — the
 * caller keeps the WoCo session and retries, exactly as for an SDK that could
 * not start at all.
 */
export function restoreVerdict(
  rehydration: Web3AuthRehydration,
  liveProvider: boolean,
): "live" | "expired" | "unavailable" {
  if (rehydration === "pending") return "unavailable";
  return liveProvider ? "live" : "expired";
}

/** A stored session that never finished loading: it can neither be ended
 *  (logout needs it connected) nor be left to answer connect(). */
export const SURVIVOR_STILL_LOADING_MESSAGE =
  "A previous sign-in on this device is still loading - please try again in a moment.";

/** A session appeared where the logout had just cleared one. */
export const SURVIVOR_INTERFERED_MESSAGE = "A previous email session interfered with sign-in - please try again.";

/**
 * End any session that survives in storage, so the modal ALWAYS runs: an
 * explicit "continue with email" — login or guardian choice — is a request to
 * prove who you are, never to resume whoever was here last. Throws when a
 * survivor could not be ended, or is still loading; the caller MUST NOT proceed
 * to `connect()` on either, because connect() would resolve as the survivor.
 *
 * Resolves `true` when it logged a session out. That instance is then spent -
 * see `instanceForExplicitSignIn` - and must never be used for connect().
 */
export async function endSurvivingWeb3AuthSession(
  w: Web3AuthSessionInstance,
  timeoutMs: number = EXPLICIT_REHYDRATION_WAIT_MS,
): Promise<boolean> {
  const state = await awaitWeb3AuthRehydration(w, timeoutMs);
  if (state === "none") return false;
  if (state === "pending") throw new Error(SURVIVOR_STILL_LOADING_MESSAGE);
  try {
    await w.logout({ cleanup: true });
  } catch (e) {
    // #507: a STALE cached session ("Session Expired or Invalid public key") is
    // discarded by the SDK during its own rehydration, so logout() throws with
    // nothing left to log out of — the goal state, reached by another route.
    // Only the instance can say which happened, so re-read it: no connection and
    // no cached connector means no survivor can answer connect(), which is the
    // whole invariant. Re-throw only while a session still stands.
    if (w.connected || w.cachedConnector) throw e;
  }
  return true;
}

/**
 * An instance that is safe to call `connect()` on for an explicit sign-in: any
 * surviving session has been ended, and the instance that ended it has been
 * swapped for a fresh one (#803).
 *
 * Never reuse the instance that logged out. `logout({ cleanup: true })` leaves
 * the SDK's AUTH connector NOT_READY with no auth instance and nothing ever
 * re-initialises it, while the modal keeps the Google / email buttons from its
 * first init. Every click on that instance then throws inside the SDK, where
 * nobody catches it, and connect() never settles - sign-in is dead until the
 * page reloads. A fresh build starts from the storage the logout just cleared.
 * (Its modal replaces the old one's container, so the two never coexist.)
 */
export async function instanceForExplicitSignIn<T extends Web3AuthSessionInstance>(
  current: T,
  rebuild: () => Promise<T>,
): Promise<T> {
  if (!(await endSurvivingWeb3AuthSession(current))) return current;
  const fresh = await rebuild();
  // The logout above cleared the stored session, so a second survivor means the
  // storage did not clear: refuse rather than loop. The caller discards `fresh`.
  if (await endSurvivingWeb3AuthSession(fresh)) {
    throw new Error(SURVIVOR_INTERFERED_MESSAGE);
  }
  return fresh;
}
