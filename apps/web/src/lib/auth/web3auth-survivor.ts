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
 * Wait for a cached Web3Auth session to finish rehydrating. In v10 the modal
 * rehydrates the stored connector INSIDE a non-awaited `CONNECTORS_UPDATED`
 * handler, so `w.connected` is still false the instant `init()` resolves — reading
 * it immediately makes a valid session look logged-out (silent logout on refresh)
 * and leaves the SDK in a half-connected state that then bypasses the OTP on the
 * next explicit login. We only block when `cachedConnector` says a session exists;
 * a fresh page (no cache) resolves instantly so the login screen isn't delayed.
 */
export async function awaitWeb3AuthRehydration(w: Web3AuthSessionInstance): Promise<boolean> {
  if (w.connected) return true;
  if (!w.cachedConnector) return false;

  const { CONNECTOR_EVENTS } = await import("@web3auth/modal");
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      w.removeListener(CONNECTOR_EVENTS.CONNECTED, onConnected);
      w.removeListener(CONNECTOR_EVENTS.AUTHORIZED, onConnected);
      w.removeListener(CONNECTOR_EVENTS.ERRORED, onFailed);
      w.removeListener(CONNECTOR_EVENTS.REHYDRATION_ERROR, onFailed);
      resolve(v);
    };
    const onConnected = () => finish(true);
    const onFailed = () => finish(false);
    // Fallback: don't hang the UI if the SDK never emits (fall back to whatever
    // connected state it reached). Rehydration normally settles in well under 1s.
    const timer = setTimeout(() => finish(w.connected), 5000);
    w.on(CONNECTOR_EVENTS.CONNECTED, onConnected);
    w.on(CONNECTOR_EVENTS.AUTHORIZED, onConnected);
    w.on(CONNECTOR_EVENTS.ERRORED, onFailed);
    w.on(CONNECTOR_EVENTS.REHYDRATION_ERROR, onFailed);
  });
}

/**
 * End any session that survives in storage, so the modal ALWAYS runs: an
 * explicit "continue with email" — login or guardian choice — is a request to
 * prove who you are, never to resume whoever was here last. Throws when a
 * survivor could not be ended; the caller MUST NOT proceed to `connect()` on
 * that failure, because connect() would resolve as the survivor.
 */
export async function endSurvivingWeb3AuthSession(w: Web3AuthSessionInstance): Promise<void> {
  if (await awaitWeb3AuthRehydration(w)) {
    await w.logout({ cleanup: true });
  }
}
