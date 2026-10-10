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
  isWeb3AuthSessionLive,
  restoreVerdict,
  EXPLICIT_REHYDRATION_WAIT_MS,
  SURVIVOR_INTERFERED_MESSAGE,
  SURVIVOR_STILL_LOADING_MESSAGE,
} from "./web3auth-survivor.js";
import { Web3AuthSignInError, WEB3AUTH_TIMED_OUT_MESSAGE, isWeb3AuthCancel } from "./web3auth-signin-error.js";
import { awaitWeb3AuthSignIn, browserSignInWaitDeps, type SignInWaitDeps } from "./web3auth-signin-wait.js";
import { markSignInStep } from "./signin-failure.js";

import { adaptWeb3AuthSdk, type KeyProvider, type Web3AuthInstance, type Web3AuthV11Like } from "./web3auth-sdk-adapter.js";

type MinimalProvider = KeyProvider;

// The bits of the Web3Auth instance we touch, in the shape the sign-in rules were
// built on (v10's); v11 is presented in it by web3auth-sdk-adapter.ts.
// `cachedConnector` tells us whether a stored session is (asynchronously)
// rehydrating after init().

type Web3AuthFactory = () => Promise<Web3AuthInstance | null>;

/** Builds and initialises one SDK instance; null = no clientId in this build. */
const buildSdkInstance: Web3AuthFactory = async () => {
  const clientId = buildEnv(() => import.meta.env.VITE_WEB3AUTH_CLIENT_ID as string | undefined);
  if (!clientId) return null;
  const mod = await import("@web3auth/modal");
  const w = adaptWeb3AuthSdk(new mod.Web3Auth(buildWeb3AuthOptions(mod, clientId)) as unknown as Web3AuthV11Like);
  await w.init();
  return w;
};

let _factory: Web3AuthFactory = buildSdkInstance;
let _waitDeps: () => SignInWaitDeps = browserSignInWaitDeps;
let _instance: Web3AuthInstance | null = null;
let _building: Promise<Web3AuthInstance | null> | null = null;
/** Ends the sign-in wait that is open (the sheet was closed over it); null = none. */
let _abortWait: (() => void) | null = null;
/** Bumped by every reset, so a build that started before one never installs itself after it. */
let _generation = 0;
/** Instances a sign-out has logged out. Marked BEFORE the logout, because the
 *  sign-out resets the singleton only once it finishes - a sign-in arriving in
 *  between would otherwise read the spent instance as fresh (#803). */
const _loggedOut = new WeakSet<Web3AuthInstance>();

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

/** Test seam: swap the SDK for a fake (null restores the real one), and the page
 *  the sign-in wait watches (null restores the browser's). */
export function setWeb3AuthFactoryForTests(factory: Web3AuthFactory | null, waitDeps?: () => SignInWaitDeps): void {
  _factory = factory ?? buildSdkInstance;
  _waitDeps = waitDeps ?? browserSignInWaitDeps;
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
 *
 * The wait for the pop-up's result is `awaitWeb3AuthSignIn` (a page the browser
 * suspended can be handed the result long after the person is back; owner
 * decision 2026-10-10): `onStall` fires when the spinner's time is up, the SDK's
 * loader is closed, and a result that lands in the grace after that still signs
 * the person in.
 */
export async function loginWithWeb3Auth(
  opts: { onStall?: () => void } = {},
): Promise<{ address: string; privateKey: `0x${string}` }> {
  const NOT_CONFIGURED = "Email login isn't configured yet (missing VITE_WEB3AUTH_CLIENT_ID).";
  // Each raw failure below is marked with its step, for the code the sign-in
  // button shows (signin-failure.ts); the error itself is passed on unchanged.
  let w: Web3AuthInstance | null;
  try {
    w = await _getInstance();
  } catch (e) {
    throw markSignInStep(e, "sdk");
  }
  if (!w) throw markSignInStep(new Error(NOT_CONFIGURED), "sdk", ["no-client-id"]);

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

  // A sign-out running alongside may have just logged this very instance out:
  // never connect on it (#803).
  if (_loggedOut.has(w) || w !== _instance) {
    _resetInstance();
    throw new Web3AuthSignInError(SURVIVOR_INTERFERED_MESSAGE);
  }

  let provider: MinimalProvider | null;
  const instance = w;
  const wait = awaitWeb3AuthSignIn<MinimalProvider>(
    instance,
    instance.connect(),
    {
      onStall: () => {
        // The SDK's loader has no close of its own while connecting (#841); its
        // modal closing is what lets the sheet show the message instead. The
        // connector goes on waiting for the pop-up underneath, and so do we.
        _closeModal(instance);
        opts.onStall?.();
      },
      isCancel: isWeb3AuthCancel,
    },
    _waitDeps(),
  );
  _abortWait = wait.abort;
  try {
    const outcome = await wait.outcome;
    if (outcome.kind === "failed") {
      const e = outcome.error;
      // Defence in depth: the modal never opens over a session still loading
      // (that refuses above), but if one hydrates mid-modal anyway it can close
      // the modal and reject with "User closed the modal". The old recovery here
      // ADOPTED it — the #182 bug through a race window. End it instead and ask
      // for one retry, which builds a fresh instance from the cleared storage.
      // `connected` (the stored name) is deliberately the wider read here, not
      // `isWeb3AuthSessionLive`: anything the SDK still names is ended or refused,
      // and a logout it cannot run is swallowed.
      if (w.connected) await _endInterferingSession(w);
      // A non-Error rejection (the auth iframe's LOGIN_FAILED string) is wrapped
      // with its value kept as the cause - that value is the clue the code carries.
      throw markSignInStep(e, "connect", [`st.${w.status}`]);
    }
    if (outcome.kind === "cancelled") {
      // The same hydrated-survivor read as a failure: a cancel over a session
      // the SDK names is never a clean cancel (the "survivor-mid-modal" case).
      if (w.connected) await _endInterferingSession(w);
      throw new Web3AuthSignInError(SIGN_IN_CANCELLED_MESSAGE, true);
    }
    if (outcome.kind === "timed-out") throw new Web3AuthSignInError(WEB3AUTH_TIMED_OUT_MESSAGE, false, true);
    if (outcome.recovered) console.debug("[web3auth] sign-in result picked up by the re-check, not the SDK's promise");
    provider = outcome.provider;
  } finally {
    _abortWait = null;
    _closeModal(w);
  }
  if (!provider) throw new Web3AuthSignInError(SIGN_IN_CANCELLED_MESSAGE, true);
  markWeb3AuthSessionEstablished();
  try {
    return await _extractKeyAndAddress(provider);
  } catch (e) {
    throw markSignInStep(e, "key");
  }
}

/** A session the SDK names where the sign-in did not make one: ended, never adopted (#182). */
async function _endInterferingSession(w: Web3AuthInstance): Promise<never> {
  try {
    await w.logout({ cleanup: true });
  } catch {
    /* the retry's pre-modal logout gets another attempt */
  }
  _resetInstance();
  throw new Web3AuthSignInError(SURVIVOR_INTERFERED_MESSAGE);
}

const SIGN_IN_CANCELLED_MESSAGE = "Sign-in was cancelled.";
const PREVIOUS_SESSION_NOT_CLEARED_MESSAGE =
  "A previous sign-in on this device couldn't be cleared - check your connection and try again.";

/**
 * The person closed OUR sign-in sheet while a sign-in was still waiting on the
 * SDK's pop-up (an iPhone, 2026-10-09: the pop-up's result never came back, and
 * the SDK's "connecting" loader stayed on screen). That loader has no way out of
 * its own while connecting - its close acts only once connected (modal `Widget`,
 * `onCloseLoader`) - so without this the spinner outlives the sheet behind it.
 * Closing the SDK's modal makes connect() settle: rejected as a cancel while
 * nothing is connected, resolved as a sign-in if the pop-up had just finished.
 * After a stall the modal is already closed and the wait is listening on its
 * own, so the wait is ended too (web3auth-signin-wait.ts).
 */
export function cancelWeb3AuthSignIn(): void {
  if (_instance) _closeModal(_instance);
  _abortWait?.();
}

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
      { cachedConnector: w.cachedConnector, rehydration, status: w.status, hasProvider: !!w.provider },
    );
    const verdict = restoreVerdict(rehydration, isWeb3AuthSessionLive(w) && !!w.provider);
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
      _loggedOut.add(w);
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
