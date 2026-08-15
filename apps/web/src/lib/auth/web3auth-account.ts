/**
 * Web3Auth PnP primary-login helpers (email + social logins).
 * Web3Auth reconstructs a standard secp256k1 key client-side (device + network
 * shares) and exposes it via `private_key`. We hold it in memory for the
 * session; Web3Auth's own localStorage keeps the session alive across page loads.
 *
 * A module-level singleton is kept so `restoreWeb3AuthSession` (called during
 * init) reuses the already-initialised instance without a second network round.
 */

import { buildWeb3AuthOptions, extractRawPrivateKey } from "./web3auth-config";
import {
  markWeb3AuthSessionEstablished,
  clearWeb3AuthSessionFlag,
  hasWeb3AuthSessionFlag,
} from "./web3auth-session-flag.js";

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
  logout(options?: { cleanup?: boolean }): Promise<void>;
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
 *
 * This function ALWAYS authenticates (#182). An explicit "Continue with
 * Email" click is a request to prove who you are, not to resume whoever was
 * here last: on a shared device a surviving session may be the previous
 * user's, and adopting it here hands over their tickets, dashboard PII and
 * payout config with no OTP and no visible sign. Any session that rehydrates
 * is therefore ENDED before the modal opens. The one legitimate silent
 * adoption — same person, page reload — is `restoreWeb3AuthSession`, the
 * boot path, which runs before any click.
 */
export async function loginWithWeb3Auth(): Promise<{ address: string; privateKey: `0x${string}` }> {
  const w = await _getInstance();
  if (!w) throw new Error("Email login isn't configured yet (missing VITE_WEB3AUTH_CLIENT_ID).");

  if (await _awaitRehydration(w)) {
    // Throws are surfaced, not swallowed: a survivor we could not end must
    // never be adopted, and proceeding to connect() would adopt it.
    await w.logout({ cleanup: true });
  }

  try {
    const provider = await w.connect();
    if (provider) {
      markWeb3AuthSessionEstablished();
      return _extractKeyAndAddress(provider);
    }
  } catch (e) {
    // A stored session hydrating LATE (past _awaitRehydration's 5s window)
    // can close the modal and reject with "User closed the modal". The old
    // recovery here ADOPTED the freshly-hydrated session — the #182 bug
    // through a race window. End it instead and ask for one retry, which
    // will find it already hydrated and take the logout-then-modal path.
    if (w.connected) {
      try {
        await w.logout({ cleanup: true });
      } catch {
        /* the retry's pre-modal logout gets another attempt */
      }
      _instance = null;
      throw new Error("A previous email session interfered with sign-in — please try again.");
    }
    throw e instanceof Error ? e : new Error("Email sign-in was cancelled.");
  }
  throw new Error("Email sign-in was cancelled.");
}

/**
 * Outcome of a silent restore. The distinction is load-bearing: an SDK that can't
 * init (dev dep-optimizer 504, a network blip reaching Web3Auth) is NOT a logout —
 * the stored session may be perfectly valid — so the caller must KEEP the WoCo
 * session and reconnect the key in the background rather than clearing it. Only a
 * successful init that reports no active session is a genuine `expired`.
 */
export type Web3AuthRestore =
  | { status: "restored"; address: string; privateKey: `0x${string}` }
  | { status: "expired" }
  | { status: "unavailable" };

/**
 * Silent restore. Returns the key if Web3Auth's stored session is still active,
 * `expired` if the SDK initialised but the session is gone, `unavailable` if the
 * SDK couldn't be reached at all (transient — do not treat as a logout). Called
 * during auth init(); never shows UI.
 */
export async function restoreWeb3AuthSession(): Promise<Web3AuthRestore> {
  let w: Web3AuthInstance | null;
  try {
    w = await _getInstance();
  } catch (e) {
    // init() threw — the dev dep-optimizer 504 or a transient network failure.
    // The stored session may be intact; signal transient so we keep + retry.
    console.debug("[web3auth] restore: init threw (transient):", e);
    return { status: "unavailable" };
  }
  if (!w) {
    // Missing clientId — a build/config issue, not a user logout. Don't nuke a
    // stored session over it; a genuine misconfig surfaces on the next action.
    console.debug("[web3auth] restore: no instance (missing clientId?)");
    return { status: "unavailable" };
  }
  try {
    // Give a cached session time to finish rehydrating before deciding it's gone —
    // otherwise every refresh reads connected=false and logs the user out.
    const rehydrated = await _awaitRehydration(w);
    console.debug(
      "[web3auth] restore:",
      { cachedConnector: w.cachedConnector, rehydrated, connected: w.connected, hasProvider: !!w.provider },
    );
    if (!w.connected || !w.provider) {
      // Definitive: the SDK initialised and reports no session — keep the
      // sign-out flag honest so future logouts stay cheap (#182).
      clearWeb3AuthSessionFlag();
      return { status: "expired" };
    }
    const { address, privateKey } = await _extractKeyAndAddress(w.provider);
    // Self-healing: any moment we hold a live session, the flag is on.
    markWeb3AuthSessionEstablished();
    return { status: "restored", address, privateKey };
  } catch (e) {
    // Initialised but couldn't pull the key (provider glitch) — transient too.
    console.debug("[web3auth] restore: key extract threw (transient):", e);
    return { status: "unavailable" };
  }
}

/**
 * Deterministic logout — ends Web3Auth's stored session, or THROWS (#182).
 *
 * The old best-effort version no-opped in reachable states: `_instance` null
 * (per-page-load singleton never built), `connected` false while a valid
 * session was still rehydrating, or `logout()` throwing into an empty catch.
 * All three left Web3Auth's localStorage session alive behind a UI that said
 * "signed out" — and the next "Continue with Email" resumed it, as the
 * previous user, with no OTP. So: skip only when no session was ever
 * established here (the flag — keeps sign-out free of the SDK chunk for
 * everyone else), build the instance if absent, await rehydration before
 * trusting `connected`, and surface failure to the caller. "Signed out" must
 * not be displayed unless the stored session is actually gone; the caller
 * decides whether local state may clear anyway (security-refusal paths do).
 */
export async function logoutWeb3Auth(): Promise<void> {
  if (!_instance && !hasWeb3AuthSessionFlag()) return;

  let w: Web3AuthInstance | null;
  try {
    w = await _getInstance();
  } catch (e) {
    _instance = null;
    console.warn("[web3auth] logout: could not build the SDK to end the session:", e);
    throw new Error(
      "Couldn't reach the sign-in service to end your email session — check your connection and try signing out again.",
    );
  }
  // No clientId: the SDK cannot be built, but neither can anything resume a
  // stored session through our code — nothing further to do this build.
  if (!w) return;

  try {
    await _awaitRehydration(w);
    if (w.connected) {
      await w.logout({ cleanup: true });
    } else if (w.cachedConnector) {
      // A stored session exists but would not hydrate; logout() needs a
      // connected instance, so the stored session would survive it.
      throw new Error("stored session did not rehydrate");
    }
    clearWeb3AuthSessionFlag();
  } catch (e) {
    console.warn("[web3auth] logout failed — the stored session may survive:", e);
    throw new Error(
      "Sign-out couldn't end your email session — you may still be signed in to email login. Try signing out again.",
    );
  } finally {
    // Next call rebuilds from storage: after success that's a clean slate;
    // after failure it gives rehydration a fresh attempt.
    _instance = null;
  }
}
