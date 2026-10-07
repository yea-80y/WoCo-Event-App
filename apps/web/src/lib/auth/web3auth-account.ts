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
import { buildEnv } from "../build-env.js";
import {
  markWeb3AuthSessionEstablished,
  clearWeb3AuthSessionFlag,
  hasWeb3AuthSessionFlag,
} from "./web3auth-session-flag.js";
import {
  awaitWeb3AuthRehydration,
  instanceForExplicitSignIn,
  restoreVerdict,
  EXPLICIT_REHYDRATION_WAIT_MS,
  SURVIVOR_INTERFERED_MESSAGE,
  SURVIVOR_STILL_LOADING_MESSAGE,
} from "./web3auth-survivor.js";
import { Web3AuthSignInError, isWeb3AuthCancel } from "./web3auth-signin-error.js";

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

type Web3AuthFactory = () => Promise<Web3AuthInstance | null>;

/** Builds and initialises one SDK instance; null = no clientId in this build. */
const buildSdkInstance: Web3AuthFactory = async () => {
  const clientId = buildEnv(() => import.meta.env.VITE_WEB3AUTH_CLIENT_ID as string | undefined);
  if (!clientId) return null;
  const mod = await import("@web3auth/modal");
  const w = new mod.Web3Auth(buildWeb3AuthOptions(mod, clientId));
  await w.init();
  return w as unknown as Web3AuthInstance;
};

let _factory: Web3AuthFactory = buildSdkInstance;
let _instance: Web3AuthInstance | null = null;
let _building: Promise<Web3AuthInstance | null> | null = null;
/** Bumped by every reset, so a build that started before one never installs itself after it. */
let _generation = 0;

/**
 * The page's one instance, built once. Single-flight: a background restore
 * retry and a sign-in click arriving together must not build two - the second
 * modal removes the first one's container, leaving that instance's modal
 * detached.
 */
async function _getInstance(): Promise<Web3AuthInstance | null> {
  if (_instance) return _instance;
  if (!_building) {
    const gen = _generation;
    const build = _factory().then((w) => {
      if (gen === _generation) _instance = w;
      return w;
    });
    _building = build;
    void build
      .finally(() => {
        if (_building === build) _building = null;
      })
      .catch(() => {});
  }
  return _building;
}

/** Drop the instance (spent, unknown, or signed out): the next call builds afresh. */
function _resetInstance(): void {
  _generation++;
  _instance = null;
  _building = null;
}

/** Test seam: swap the SDK for a fake (null restores the real one). */
export function setWeb3AuthFactoryForTests(factory: Web3AuthFactory | null): void {
  _factory = factory ?? buildSdkInstance;
  _resetInstance();
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
  const NOT_CONFIGURED = "Email login isn't configured yet (missing VITE_WEB3AUTH_CLIENT_ID).";
  let w = await _getInstance();
  if (!w) throw new Error(NOT_CONFIGURED);

  // Throws are surfaced, not swallowed: a survivor we could not end must
  // never be adopted, and proceeding to connect() would adopt it. Shared with
  // the guardian connector (#307), which has the same hole with higher stakes.
  // An instance that ended a survivor is swapped for a fresh one (#803).
  try {
    w = await instanceForExplicitSignIn(w, async () => {
      _resetInstance();
      const fresh = await _getInstance();
      if (!fresh) throw new Error(NOT_CONFIGURED);
      return fresh;
    });
  } catch (e) {
    // Whatever instance this touched is spent or unknown: the next attempt builds anew.
    _resetInstance();
    const said = e instanceof Error ? e.message : "";
    const shown = [SURVIVOR_STILL_LOADING_MESSAGE, SURVIVOR_INTERFERED_MESSAGE, NOT_CONFIGURED].includes(said);
    throw new Web3AuthSignInError(shown ? said : PREVIOUS_SESSION_NOT_CLEARED_MESSAGE);
  }

  let provider: MinimalProvider | null;
  try {
    provider = await w.connect();
  } catch (e) {
    // Defence in depth: the modal never opens over a session still loading
    // (that refuses above), but if one hydrates mid-modal anyway it can close
    // the modal and reject with "User closed the modal". The old recovery here
    // ADOPTED it — the #182 bug through a race window. End it instead and ask
    // for one retry, which builds a fresh instance from the cleared storage.
    if (w.connected) {
      try {
        await w.logout({ cleanup: true });
      } catch {
        /* the retry's pre-modal logout gets another attempt */
      }
      _resetInstance();
      throw new Web3AuthSignInError(SURVIVOR_INTERFERED_MESSAGE);
    }
    if (isWeb3AuthCancel(e)) throw new Web3AuthSignInError(SIGN_IN_CANCELLED_MESSAGE, true);
    throw e instanceof Error ? e : new Error("Email sign-in failed - please try again.");
  } finally {
    _closeModal(w);
  }
  if (!provider) throw new Web3AuthSignInError(SIGN_IN_CANCELLED_MESSAGE, true);
  markWeb3AuthSessionEstablished();
  return _extractKeyAndAddress(provider);
}

const SIGN_IN_CANCELLED_MESSAGE = "Sign-in was cancelled.";
const PREVIOUS_SESSION_NOT_CLEARED_MESSAGE =
  "A previous sign-in on this device couldn't be cleared - check your connection and try again.";

/**
 * Close the SDK's modal once our sign-in stops listening to it. It does not
 * close itself after a sign-in (it sits on a success screen over ours), and it
 * STAYS OPEN after an error such as a closed or blocked popup - by then connect()
 * has already rejected, so a second tap there completes a sign-in nothing
 * receives and the person has to start again (#803). Internal field, guarded: a
 * future SDK shape change only loses the close, which is cosmetic.
 */
function _closeModal(w: Web3AuthInstance): void {
  try {
    (w as unknown as { loginModal?: { closeModal?: () => void } }).loginModal?.closeModal?.();
  } catch {
    /* best effort */
  }
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
    const rehydration = await awaitWeb3AuthRehydration(w);
    console.debug(
      "[web3auth] restore:",
      { cachedConnector: w.cachedConnector, rehydration, connected: w.connected, hasProvider: !!w.provider },
    );
    const verdict = restoreVerdict(rehydration, w.connected && !!w.provider);
    if (verdict === "unavailable") {
      // Still loading when the wait ran out: no answer yet, so NOT a logout
      // (#803). Reading it as `expired` signed a valid session out on a slow
      // reload and left it behind for the next sign-in to trip over. The caller
      // keeps the WoCo session and retries the key in the background.
      return { status: "unavailable" };
    }
    if (verdict === "expired" || !w.provider) {
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
    _resetInstance();
    console.warn("[web3auth] logout: could not build the SDK to end the session:", e);
    throw new Error(
      "Couldn't reach the sign-in service to end your email session — check your connection and try signing out again.",
    );
  }
  // No clientId: the SDK cannot be built, but neither can anything resume a
  // stored session through our code — nothing further to do this build.
  if (!w) return;

  try {
    const rehydration = await awaitWeb3AuthRehydration(w, EXPLICIT_REHYDRATION_WAIT_MS);
    if (rehydration === "connected") {
      await w.logout({ cleanup: true });
    } else if (rehydration === "pending") {
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
    _resetInstance();
  }
}
