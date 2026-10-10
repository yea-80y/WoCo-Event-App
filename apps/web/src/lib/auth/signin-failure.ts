/**
 * A sign-in that failed for a reason with no words of its own, said with a short
 * code the person can screenshot (an iPhone in Safari, 2026-10-10: "Sign-in failed"
 * and nothing else, the real error only in a console nobody can open there).
 *
 * The code says WHERE it failed and WHAT KIND of error it was - never what the
 * error said. An SDK's message can carry its cause's text, a server reply or the
 * login hint, and a viem error's message carries the RPC URL, so only these go in:
 * the step, an error's `name` when it is a plain identifier, a numeric `code` or
 * `status`, the same for its `cause`, the seconds since the attempt began and a
 * few page flags. A rejection that is not an Error (Web3Auth's auth iframe rejects
 * with whatever string its remote code sent, `AuthProvider` LOGIN_FAILED) is never
 * copied: a string the SDK is known to send maps to a fixed word, and any other
 * becomes its length plus which of a fixed list of topic words it mentions. The
 * same rule reads the "extra" text of Web3Auth's own error classes, where the
 * pop-up path leaves the iframe's reason (`web3AuthExtra`).
 *
 * Dependency-free and matched by name, never `instanceof`: the button reads it
 * without loading the sign-in chunk (as web3auth-signin-error.ts).
 */

export const SIGN_IN_FAILED_ERROR_NAME = "SignInFailedError";

export const SIGN_IN_FAILED_MESSAGE = "Sign-in failed - please try again.";

/** Where an email sign-in failed. The first three are inside the Web3Auth chunk;
 *  the rest are the auth store's steps after the key came back. */
export type SignInStep =
  | "sdk" // loading or starting the Web3Auth SDK
  | "connect" // the SDK's sign-in (modal, emailed code, auth iframe, pop-up)
  | "key" // reading the key from the signed-in SDK
  | "tombstone" // this key was upgraded to a passkey on this device
  | "lookup" // a recovered account's preserved address
  | "owner" // the preserved account's on-chain owner
  | "kernel" // building the account (chunk download + RPC)
  | "signer" // is this key still on the account's list
  | "switch" // clearing another account's state
  | "store" // writing the sign-in to this device
  | "restore" // reloading this account's saved session
  | "feed"; // the account's content-feed signer

export class SignInFailedError extends Error {
  /** Short, copyable, safe to screenshot: see the header. */
  readonly code: string;
  /** The raw error, for the console only. NEVER render or report it: an SDK's
   *  message can carry the login hint, a viem error's the RPC URL. */
  readonly cause?: unknown;
  constructor(code: string, cause?: unknown) {
    super(SIGN_IN_FAILED_MESSAGE);
    this.name = SIGN_IN_FAILED_ERROR_NAME;
    this.code = code;
    this.cause = cause;
  }
}

export function isSignInFailedError(e: unknown): e is SignInFailedError {
  return e instanceof Error && e.name === SIGN_IN_FAILED_ERROR_NAME && typeof (e as { code?: unknown }).code === "string";
}

type StepMark = { step: SignInStep; notes: readonly string[] };
const marks = new WeakMap<object, StepMark>();

/**
 * Remember which step `e` came from (the first mark wins) and hand back something
 * throwable. A rejection that is not an object cannot carry a mark, so it is
 * wrapped - its value kept as the cause, which is what `describeSignInError` reads.
 * `notes` are SDK facts at the time (its status, `st.ready`);
 * each passes the same token filter as everything else.
 */
export function markSignInStep(e: unknown, step: SignInStep, notes: readonly string[] = []): unknown {
  const err: object =
    typeof e === "object" && e !== null
      ? e
      : Object.assign(new Error("Email sign-in failed - please try again."), { name: "Rejected", cause: e });
  if (!marks.has(err)) marks.set(err, { step, notes });
  return err;
}

export function signInStepOf(e: unknown): StepMark | null {
  return typeof e === "object" && e !== null ? (marks.get(e) ?? null) : null;
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** Strings the Web3Auth SDK itself is known to reject with, as fixed words. */
const KNOWN_REJECTIONS: Readonly<Record<string, string>> = {
  "login failed, reason: unknown": "login-failed-unknown", // AuthProvider LOGIN_FAILED, no reason given
  "failed to login with social": "social-login-failed",
  "failed to login with auth": "auth-login-failed",
  "popup window is blocked": "popup-blocked",
  "user closed popup": "popup-closed",
  "iframe not initialized": "iframe-not-initialized",
  aborted: "aborted",
};

/** Topic words an unknown rejection may mention: a fixed list, so nothing of the string itself leaves. */
const TOPICS = [
  "cookie",
  "storage",
  "session",
  "popup",
  "iframe",
  "network",
  "fetch",
  "timeout",
  "nonce",
  "token",
  "jwt",
  "verifier",
  "share",
  "origin",
  "blocked",
  "denied",
  "expired",
  "invalid",
  "mfa",
] as const;

/** A string as something fit to show: a known rejection's fixed word, else
 *  `str<length>` and the topic words it contains (`str37:cookie+session`). */
export function describeRejectionString(s: string): string {
  const known = KNOWN_REJECTIONS[s.trim().toLowerCase()];
  if (known) return known;
  const lower = s.toLowerCase();
  const topics = TOPICS.filter((t) => lower.includes(t));
  return topics.length ? `str${s.length}:${topics.join("+")}` : `str${s.length}`;
}

/** A note about the SDK's state (`st.ready`, `no-client-id`): an identifier-like word or nothing. */
const NOTE = /^[a-z][a-z0-9._-]{0,31}$/;

function numberField(e: object, key: "code" | "status"): string | null {
  const v = (e as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isInteger(v) && Math.abs(v) < 1e6 ? String(v) : null;
}

/**
 * Web3Auth's own error classes. Their message is the SDK's fixed text for the code,
 * then ". " (", " for LoginError), then an "extra" part - and on the pop-up path
 * that extra part is the ONLY place the auth iframe's reason survives:
 * `authConnector.connectWithSocialLogin` rejects with
 * `connectionError(error.message ?? error)` and no cause (an iPhone, 2026-10-10:
 * `WalletLoginError.5111` and nothing else). So for these alone the part after
 * the fixed text is described - through `describeRejectionString`, which never
 * copies it.
 */
const WEB3AUTH_ERROR_NAMES = new Set([
  "WalletLoginError",
  "WalletInitializationError",
  "WalletOperationsError",
  "LoginError",
  "InitializationError",
]);

function web3AuthExtra(name: string, e: object): string | null {
  if (!WEB3AUTH_ERROR_NAMES.has(name)) return null;
  const message = (e as { message?: unknown }).message;
  if (typeof message !== "string") return null;
  const cut = message.search(/[.,] /);
  if (cut < 0) return null;
  const extra = message.slice(cut + 2).trim();
  return extra ? describeRejectionString(extra) : null;
}

/** One error, as `Name.code[(extra)]` - or, for a non-Error value, a fixed word or its length and topics. */
function describeOne(e: unknown): string {
  if (typeof e === "string") return describeRejectionString(e);
  if (typeof e !== "object" || e === null) return typeof e;
  const name = (e as { name?: unknown }).name;
  const head = typeof name === "string" && IDENTIFIER.test(name) ? name : "obj";
  const code = numberField(e, "code") ?? numberField(e, "status");
  const extra = web3AuthExtra(head, e);
  return `${head}${code ? `.${code}` : ""}${extra ? `(${extra})` : ""}`;
}

/** The error and up to two causes beneath it, `~`-separated. Never a message copied (see `web3AuthExtra`). */
export function describeSignInError(e: unknown): string {
  const parts: string[] = [];
  let at: unknown = e;
  for (let depth = 0; depth < 3; depth++) {
    parts.push(describeOne(at));
    if (typeof at !== "object" || at === null || !("cause" in at)) break;
    at = (at as { cause?: unknown }).cause;
    if (at === undefined) break;
  }
  return parts.join("~");
}

export type SignInFailureContext = {
  /** The step the store had reached; a mark from inside the Web3Auth chunk wins. */
  step: SignInStep;
  elapsedMs: number;
  /** The returning-device path (no account build). */
  fast?: boolean;
  hidden?: boolean;
  offline?: boolean;
};

/**
 * `W3A-<step>-<error>-t<seconds>[-<flags>]`, e.g.
 * `W3A-connect-WalletLoginError.5111~login-failed-unknown-t41-st.ready`.
 */
export function signInFailureCode(e: unknown, ctx: SignInFailureContext): string {
  const mark = signInStepOf(e);
  const notes = (mark?.notes ?? []).filter((n) => NOTE.test(n));
  const flags = [
    ...(ctx.fast ? ["fast"] : []),
    ...(ctx.hidden ? ["hidden"] : []),
    ...(ctx.offline ? ["offline"] : []),
    ...notes,
  ];
  const seconds = Math.max(0, Math.round(ctx.elapsedMs / 1000));
  return ["W3A", mark?.step ?? ctx.step, describeSignInError(e), `t${seconds}`, ...flags].join("-");
}
