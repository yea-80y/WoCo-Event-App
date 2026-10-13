/**
 * The wait for a Web3Auth sign-in result, made to survive a page the browser put
 * to sleep (an iPhone, 2026-10-10, owner decision).
 *
 * How a pop-up result reaches this page in SDK v10 (`@web3auth/modal` 10.15):
 * pop-up -> Web3Auth's session server -> the SDK's auth iframe (remote code) ->
 * `postMessage` -> `connect()` resolves. The channel is a socket that the SDK
 * re-asks only on `visibilitychange`, and only when it already knows the socket is
 * gone; a tab iOS suspended keeps a socket that reads connected and says nothing
 * until its ping times out. So the result can arrive a long time after the person
 * came back to the loader, and inside an app's built-in browser `visibilitychange`
 * may never fire at all. #841 made that loader closable by hand and let a late
 * result still sign in; the owner wants the late result picked up with no action.
 *
 * What this does, around the SDK's own promise:
 *  - RE-CHECKS the SDK's connection state on `focus`, `pageshow`,
 *    `visibilitychange` and a short poll, and completes the sign-in the moment a
 *    connection THIS attempt made is live (a CONNECTED event with
 *    `reconnected: false` - a session rehydrated from storage is never adopted
 *    here; #182's rule stands);
 *  - BOUNDS the spinner: after `SIGN_IN_STALL_AFTER_WATCHED_MS` of the person
 *    actually looking at this page with no result (time in the pop-up or in
 *    another tab does not count), `onStall` fires so the UI can replace the
 *    spinner with a message and a way out, and the wait goes on listening for a
 *    grace period: a result that lands then still signs the person in;
 *  - ENDS: a grace period after the stall, or a hard ceiling in any case, the
 *    wait reports `timed-out`. Never an endless spinner.
 *
 * Pure: the page, the clock and the SDK events come in through `deps`, so the
 * whole thing runs under node:test with a scripted page.
 */
import { isWeb3AuthSessionLive, type Web3AuthSessionInstance } from "./web3auth-survivor.js";

/** How often the SDK's state is re-read while the wait is open. */
export const SIGN_IN_POLL_MS = 1_000;
/** Time the person has spent LOOKING at this page with no result before the spinner gives way. */
export const SIGN_IN_STALL_AFTER_WATCHED_MS = 30_000;
/** After the stall, how long a late result is still picked up automatically. */
export const SIGN_IN_GRACE_MS = 5 * 60_000;
/** The wait ends here whatever the page reported about being watched. */
export const SIGN_IN_HARD_LIMIT_MS = 15 * 60_000;

export type SignInWaitDeps = {
  /** Subscribe `fn` to the page events after which the SDK's state is re-read
   *  (`focus`, `pageshow`, `visibilitychange`); returns the unsubscribe. */
  listen(fn: () => void): () => void;
  /** The person is looking at this page right now (visible AND focused). */
  watching(): boolean;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

export type SignInWaitOutcome<P> =
  | { kind: "signed-in"; provider: P; recovered: boolean }
  | { kind: "cancelled" }
  | { kind: "timed-out" }
  | { kind: "failed"; error: unknown };

export type SignInWait<P> = {
  outcome: Promise<SignInWaitOutcome<P>>;
  /** The person backed out (closed our sheet): settles as `cancelled` at once. */
  abort(): void;
};

type WaitInstance<P> = Web3AuthSessionInstance & { provider: P | null };

const CONNECTED_EVENT = "connected";

export function awaitWeb3AuthSignIn<P>(
  w: WaitInstance<P>,
  connect: Promise<P | null>,
  hooks: {
    /** The spinner's time is up: close what shows it and say so. The wait continues. */
    onStall(): void;
    /** The SDK's two ways of saying the modal or pop-up was closed. */
    isCancel(e: unknown): boolean;
  },
  deps: SignInWaitDeps,
): SignInWait<P> {
  let settled = false;
  let stalled = false;
  let elapsedMs = 0;
  let watchedMs = 0;
  let stalledAtMs = 0;
  /** A CONNECTED event this attempt produced (not a rehydration) has been seen. */
  let freshConnection = false;

  let resolveOutcome!: (o: SignInWaitOutcome<P>) => void;
  const outcome = new Promise<SignInWaitOutcome<P>>((r) => (resolveOutcome = r));

  const onConnected = (...args: unknown[]) => {
    const data = args[0] as { reconnected?: boolean } | undefined;
    if (data?.reconnected === true) return;
    freshConnection = true;
    check();
  };
  const unlisten = deps.listen(() => check());
  const poll = deps.setInterval(() => tick(), SIGN_IN_POLL_MS);
  w.on(CONNECTED_EVENT, onConnected);

  function finish(o: SignInWaitOutcome<P>): void {
    if (settled) return;
    settled = true;
    deps.clearInterval(poll);
    unlisten();
    w.removeListener(CONNECTED_EVENT, onConnected);
    resolveOutcome(o);
  }

  /** The re-check: a live session this attempt made is the sign-in, however it got here. */
  function check(): void {
    if (settled) return;
    if (freshConnection && isWeb3AuthSessionLive(w) && w.provider) {
      finish({ kind: "signed-in", provider: w.provider, recovered: true });
    }
  }

  function tick(): void {
    if (settled) return;
    elapsedMs += SIGN_IN_POLL_MS;
    if (deps.watching()) watchedMs += SIGN_IN_POLL_MS;
    check();
    if (settled) return;
    if (!stalled && watchedMs >= SIGN_IN_STALL_AFTER_WATCHED_MS) {
      stalled = true;
      stalledAtMs = elapsedMs;
      hooks.onStall();
      return;
    }
    if ((stalled && elapsedMs - stalledAtMs >= SIGN_IN_GRACE_MS) || elapsedMs >= SIGN_IN_HARD_LIMIT_MS) {
      finish({ kind: "timed-out" });
    }
  }

  connect.then(
    (provider) => {
      if (settled) return;
      if (provider) finish({ kind: "signed-in", provider, recovered: false });
      else finish({ kind: "cancelled" });
    },
    (e: unknown) => {
      if (settled) return;
      // After the stall WE closed the SDK's modal, which rejects its promise as a
      // cancel while nothing is connected; the connector keeps listening for the
      // pop-up, and so does this wait.
      if (hooks.isCancel(e)) {
        if (!stalled) finish({ kind: "cancelled" });
        return;
      }
      finish({ kind: "failed", error: e });
    },
  );

  return {
    outcome,
    abort: () => finish({ kind: "cancelled" }),
  };
}

/** The page as `awaitWeb3AuthSignIn` needs it. */
export function browserSignInWaitDeps(): SignInWaitDeps {
  return {
    listen(fn) {
      window.addEventListener("focus", fn);
      window.addEventListener("pageshow", fn);
      document.addEventListener("visibilitychange", fn);
      return () => {
        window.removeEventListener("focus", fn);
        window.removeEventListener("pageshow", fn);
        document.removeEventListener("visibilitychange", fn);
      };
    },
    // Focus too: on a laptop the pop-up is a window over a page that stays
    // "visible", and time spent in it must not count against the spinner.
    watching: () => document.visibilityState === "visible" && document.hasFocus(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };
}
