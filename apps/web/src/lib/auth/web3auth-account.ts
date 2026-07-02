/**
 * Web3Auth PnP primary-login helpers — the replacement for para-account.ts.
 * Web3Auth reconstructs a standard secp256k1 key client-side (device + network
 * shares) and exposes it via `private_key`. We hold it in memory for the
 * session; Web3Auth's own localStorage keeps the session alive across page loads.
 *
 * A module-level singleton is kept so `restoreWeb3AuthSession` (called during
 * init) reuses the already-initialised instance without a second network round.
 */

import { buildWeb3AuthOptions, extractRawPrivateKey } from "./web3auth-config";

type MinimalProvider = { request: (args: { method: string }) => Promise<unknown> };

// The bits of the Web3Auth instance we touch. It extends SafeEventEmitter, so the
// listener methods are present; `cachedConnector` tells us whether a stored session
// is (asynchronously) rehydrating after init().
type Web3AuthInstance = {
  connected: boolean;
  provider: MinimalProvider | null;
  cachedConnector: string | null;
  init(): Promise<void>;
  connect(): Promise<MinimalProvider | null>;
  logout(): Promise<void>;
  on(event: string, fn: (...args: unknown[]) => void): void;
  removeListener(event: string, fn: (...args: unknown[]) => void): void;
};

let _instance: Web3AuthInstance | null = null;

async function _getInstance() {
  const clientId = import.meta.env.VITE_WEB3AUTH_CLIENT_ID as string | undefined;
  if (!clientId) return null;

  if (_instance) return _instance;

  const mod = await import("@web3auth/modal");
  const w = new mod.Web3Auth(buildWeb3AuthOptions(mod, clientId));
  await w.init();
  _instance = w as unknown as Web3AuthInstance;
  return _instance;
}

/**
 * Wait for a cached Web3Auth session to finish rehydrating. In v10 the modal
 * rehydrates the stored connector INSIDE a non-awaited `CONNECTORS_UPDATED`
 * handler, so `w.connected` is still false the instant `init()` resolves — reading
 * it immediately makes a valid session look logged-out (silent logout on refresh)
 * and leaves the SDK in a half-connected state that then bypasses the OTP on the
 * next explicit login. We only block when `cachedConnector` says a session exists;
 * a fresh page (no cache) resolves instantly so the login screen isn't delayed.
 */
async function _awaitRehydration(w: Web3AuthInstance): Promise<boolean> {
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

async function _extractKeyAndAddress(provider: MinimalProvider): Promise<{ address: string; privateKey: `0x${string}` }> {
  const { privateKeyToAccount } = await import("viem/accounts");
  const raw = await extractRawPrivateKey(provider);
  const pk = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  const account = privateKeyToAccount(pk);
  return { address: account.address.toLowerCase(), privateKey: pk };
}

/**
 * Open the Web3Auth PnP modal (email / social). Returns the address and raw
 * private key on success. Does NOT log out — the session stays active for
 * `restoreWeb3AuthSession` to pick up on the next page load.
 */
export async function loginWithWeb3Auth(): Promise<{ address: string; privateKey: `0x${string}` }> {
  const w = await _getInstance();
  if (!w) throw new Error("Email login isn't configured yet (missing VITE_WEB3AUTH_CLIENT_ID).");

  // A cached session may still be rehydrating from a prior visit; adopt it silently
  // rather than opening the modal (and never double-prompting the OTP).
  if (await _awaitRehydration(w)) {
    if (w.provider) return _extractKeyAndAddress(w.provider);
  }

  try {
    const provider = await w.connect();
    if (provider) return _extractKeyAndAddress(provider);
  } catch (e) {
    // A session rehydrating while the modal is open can close it and reject with
    // "User closed the modal" even though we ARE now connected — recover from that.
    if (!w.connected) throw e instanceof Error ? e : new Error("Email sign-in was cancelled.");
  }
  if (w.connected && w.provider) return _extractKeyAndAddress(w.provider);
  throw new Error("Email sign-in was cancelled.");
}

/**
 * Silent restore — returns the key if Web3Auth's stored session is still active,
 * null if expired / not configured. Called during auth init(); never shows UI.
 */
export async function restoreWeb3AuthSession(): Promise<{ address: string; privateKey: `0x${string}` } | null> {
  try {
    const w = await _getInstance();
    if (!w) {
      console.debug("[web3auth] restore: no instance (missing clientId?)");
      return null;
    }
    // Give a cached session time to finish rehydrating before deciding it's gone —
    // otherwise every refresh reads connected=false and logs the user out.
    const rehydrated = await _awaitRehydration(w);
    console.debug(
      "[web3auth] restore:",
      { cachedConnector: w.cachedConnector, rehydrated, connected: w.connected, hasProvider: !!w.provider },
    );
    if (!w.connected || !w.provider) return null;
    return await _extractKeyAndAddress(w.provider);
  } catch (e) {
    console.debug("[web3auth] restore threw:", e);
    return null;
  }
}

/** Best-effort logout — clears Web3Auth's stored session. */
export async function logoutWeb3Auth(): Promise<void> {
  try {
    if (_instance?.connected) await _instance.logout();
  } catch {
    // best effort
  } finally {
    _instance = null;
  }
}
