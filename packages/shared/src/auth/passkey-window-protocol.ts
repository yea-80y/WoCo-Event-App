/**
 * The passkey sign-in window's messages (v1). The app opens a top-level window on the
 * passkey host; the window says `ready`, takes ONE request from the page that opened
 * it, runs the ceremony after its own Continue tap, answers once and closes. Every
 * passkey ceremony runs there, so the PRF output never exists outside it: the window
 * answers with the keys derived from it (`passkeyAccountKeys` / `passkeyGuardianKeys`).
 *
 * Pure, and the ONLY place either side decides what a message may be: the window
 * (`apps/web/src/auth-window/`) and the app (`apps/web/src/lib/auth/passkey-window.ts`)
 * both validate through these functions, so a field one side sends and the other does
 * not check cannot appear. Transport-neutral on purpose: nothing here knows it rides
 * `postMessage`, so a redirect transport could carry the same envelope.
 *
 * STICKY: the version and the action names. The window is pinned by the owner's Safe on
 * L1 and the app ships through its feed, so either can be newer than the other; a
 * version either side does not know is refused and said so, never guessed at.
 */

import type { PasskeyAccountKeys, PasskeyGuardianKeys } from "../crypto/passkey-prf.js";

export const PASSKEY_WINDOW_VERSION = 1;

/** A request the window takes only this long after it loads (Fable 10-21). */
export const PASSKEY_WINDOW_REQUEST_MS = 60_000;

export const PASSKEY_WINDOW_ACTIONS = ["signin", "restore", "create", "add", "backup-create", "backup-get"] as const;
export type PasskeyWindowAction = (typeof PASSKEY_WINDOW_ACTIONS)[number];

export interface PasskeyWindowRequest {
  v: typeof PASSKEY_WINDOW_VERSION;
  type: "request";
  nonce: string;
  action: PasskeyWindowAction;
  /** restore: the credential this device signed in with. */
  credentialId?: string;
  /** restore: open the account picker when the pinned passkey is refused. */
  fallback?: boolean;
  /** add: the account's passkeys the password manager must refuse. */
  exclude?: string[];
  /** add: the date in the new passkey's name ("WoCo Account - added {createdOn}"). */
  createdOn?: string;
}

/** A main or added passkey's answer. Everything but `keys` is not secret. */
export interface PasskeyWindowAccountResult {
  credentialId: string;
  attachment: "platform" | "cross-platform" | null;
  /** "added": the credential was made by "Add a passkey" (its user handle says so). */
  handleKind: "added" | null;
  /** Creations only: the authenticator's AAGUID, which names the password manager. */
  aaguid: string | null;
  keys: PasskeyAccountKeys;
}

export interface PasskeyWindowGuardianResult {
  keys: PasskeyGuardianKeys;
}

export type PasskeyWindowResult = PasskeyWindowAccountResult | PasskeyWindowGuardianResult;

/**
 * Why a ceremony gave nothing. Browser refusals pass through by their DOMException name
 * (`quick`: before any sheet could open); the rest are checks only the window can make,
 * because only it saw the credential. The app turns each back into the error it shows.
 */
export const PASSKEY_WINDOW_ERRORS = [
  "NotAllowedError",
  "SecurityError",
  "InvalidStateError",
  "PrfUnsupported",
  "BadPrfLength",
  "CreatedWithoutSecret",
  "IsBackup",
  "FromAnotherDevice",
  "NotOnThisDevice",
  "UnsupportedRequest",
  "Unexpected",
] as const;
export type PasskeyWindowErrorName = (typeof PASSKEY_WINDOW_ERRORS)[number];

export interface PasskeyWindowError {
  name: PasskeyWindowErrorName;
  quick?: boolean;
  /** PrfUnsupported after a creation: the manager that saved the useless passkey. */
  aaguid?: string | null;
  /** PrfUnsupported after a creation: the name the passkey was saved under. */
  label?: string;
  /** Unexpected / BadPrfLength: what happened, for the log and the message. */
  detail?: string;
}

export type PasskeyWindowReply =
  | { v: typeof PASSKEY_WINDOW_VERSION; type: "result"; nonce: string; ok: true; result: PasskeyWindowResult }
  | { v: typeof PASSKEY_WINDOW_VERSION; type: "result"; nonce: string; ok: false; error: PasskeyWindowError };

export interface PasskeyWindowReady {
  v: typeof PASSKEY_WINDOW_VERSION;
  type: "ready";
}

/** What either side receives: the event's origin and source, and its data. */
export interface PasskeyWindowMessage {
  origin: string;
  source: unknown;
  data: unknown;
}

const NONCE_RE = /^[A-Za-z0-9_-]{22,64}$/;
/** A credential ID as base64url; WebAuthn caps the ID at 1023 bytes. */
const CREDENTIAL_ID_RE = /^[A-Za-z0-9_-]{16,1366}$/;
/** What a locale's short date is made of - letters, marks, digits, spaces, punctuation -
 *  and never a control, bidi or markup character: the name lands in a password manager,
 *  next to the main passkey's. Checked against 75 locales' `toLocaleDateString`. */
export const PASSKEY_CREATED_ON_RE = /^[\p{L}\p{M}\p{N}\p{Zs}\p{P}]{1,40}$/u;
const MAX_EXCLUDE = 32;
const KEY_BYTES = 32;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const only = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));

/** A fresh request nonce: 16 random bytes, base64url. */
export function newPasskeyWindowNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The request in `data`, or why it is not one. Strict: every field belongs to its
 * action, so an extra field is a request this version does not understand.
 */
export function parsePasskeyWindowRequest(data: unknown): PasskeyWindowRequest | { refused: string } {
  if (!isObject(data) || data.type !== "request") return { refused: "not a request" };
  if (data.v !== PASSKEY_WINDOW_VERSION) return { refused: `version ${String(data.v)}` };
  if (typeof data.nonce !== "string" || !NONCE_RE.test(data.nonce)) return { refused: "nonce" };
  const action = data.action as PasskeyWindowAction;
  if (!PASSKEY_WINDOW_ACTIONS.includes(action)) return { refused: "action" };
  const base = ["v", "type", "nonce", "action"];
  if (action === "restore") {
    if (!only(data, [...base, "credentialId", "fallback"])) return { refused: "fields" };
    if (typeof data.credentialId !== "string" || !CREDENTIAL_ID_RE.test(data.credentialId)) return { refused: "credentialId" };
    if (typeof data.fallback !== "boolean") return { refused: "fallback" };
    return { v: 1, type: "request", nonce: data.nonce, action, credentialId: data.credentialId, fallback: data.fallback };
  }
  if (action === "add") {
    if (!only(data, [...base, "exclude", "createdOn"])) return { refused: "fields" };
    const ex = data.exclude;
    if (!Array.isArray(ex) || ex.length > MAX_EXCLUDE || !ex.every((id) => typeof id === "string" && CREDENTIAL_ID_RE.test(id))) {
      return { refused: "exclude" };
    }
    if (typeof data.createdOn !== "string" || !PASSKEY_CREATED_ON_RE.test(data.createdOn)) return { refused: "createdOn" };
    return { v: 1, type: "request", nonce: data.nonce, action, exclude: [...(ex as string[])], createdOn: data.createdOn };
  }
  if (!only(data, base)) return { refused: "fields" };
  return { v: 1, type: "request", nonce: data.nonce, action };
}

/**
 * WINDOW SIDE: the one request this window may answer, or null to ignore the message.
 * From the window that opened this one (`source === opener`, captured at load), from an
 * allowed origin exactly, while nothing has been accepted, within the request window.
 * A message that passes those but is malformed is refused readably (`refused`), so an
 * app newer than this page says so instead of hanging.
 */
export function acceptPasskeyWindowRequest(
  msg: PasskeyWindowMessage,
  ctx: { opener: unknown; allowedOrigins: readonly string[]; accepted: boolean; loadedAt: number; now: number },
): PasskeyWindowRequest | { refused: string; nonce: string | null } | null {
  if (ctx.accepted || ctx.opener === null || ctx.opener === undefined) return null;
  if (msg.source !== ctx.opener || !ctx.allowedOrigins.includes(msg.origin)) return null;
  if (ctx.now - ctx.loadedAt > PASSKEY_WINDOW_REQUEST_MS) return null;
  const parsed = parsePasskeyWindowRequest(msg.data);
  if ("refused" in parsed) {
    const nonce = isObject(msg.data) && typeof msg.data.nonce === "string" && NONCE_RE.test(msg.data.nonce) ? msg.data.nonce : null;
    return { refused: parsed.refused, nonce };
  }
  return parsed;
}

const isKey = (v: unknown): v is Uint8Array => v instanceof Uint8Array && v.length === KEY_BYTES;
const ACCOUNT_KEYS = ["ownerKey", "seed", "seedKek", "boxSeed", "portabilitySocKey", "portabilityHpkeSeed"] as const;
const GUARDIAN_KEYS = ["ownerKey", "escrowMaster"] as const;

function keysOf<K extends string>(v: unknown, names: readonly K[]): Record<K, Uint8Array> | null {
  if (!isObject(v) || !only(v, names) || !names.every((n) => isKey(v[n]))) return null;
  return Object.fromEntries(names.map((n) => [n, v[n]])) as Record<K, Uint8Array>;
}

/** Whether `action` answers with a backup passkey's keys rather than an account's. */
export function isGuardianAction(action: PasskeyWindowAction): boolean {
  return action === "backup-create" || action === "backup-get";
}

/** The result of `action` in `v`, shape-checked, or null. */
function parseResult(action: PasskeyWindowAction, v: unknown): PasskeyWindowResult | null {
  if (!isObject(v)) return null;
  if (isGuardianAction(action)) {
    const keys = keysOf(v.keys, GUARDIAN_KEYS);
    return keys && only(v, ["keys"]) ? { keys } : null;
  }
  const keys = keysOf(v.keys, ACCOUNT_KEYS);
  if (!keys || !only(v, ["credentialId", "attachment", "handleKind", "aaguid", "keys"])) return null;
  if (typeof v.credentialId !== "string" || !CREDENTIAL_ID_RE.test(v.credentialId)) return null;
  if (v.attachment !== "platform" && v.attachment !== "cross-platform" && v.attachment !== null) return null;
  if (v.handleKind !== "added" && v.handleKind !== null) return null;
  if (v.aaguid !== null && (typeof v.aaguid !== "string" || !/^[0-9a-f-]{36}$/.test(v.aaguid))) return null;
  return { credentialId: v.credentialId, attachment: v.attachment, handleKind: v.handleKind, aaguid: v.aaguid, keys };
}

function parseError(v: unknown): PasskeyWindowError | null {
  if (!isObject(v) || !PASSKEY_WINDOW_ERRORS.includes(v.name as PasskeyWindowErrorName)) return null;
  if (!only(v, ["name", "quick", "aaguid", "label", "detail"])) return null;
  const e: PasskeyWindowError = { name: v.name as PasskeyWindowErrorName };
  if (typeof v.quick === "boolean") e.quick = v.quick;
  if (typeof v.aaguid === "string" || v.aaguid === null) e.aaguid = v.aaguid;
  if (typeof v.label === "string") e.label = v.label.slice(0, 80);
  if (typeof v.detail === "string") e.detail = v.detail.slice(0, 200);
  return e;
}

/**
 * APP SIDE: what the window said, or null to ignore the message. Only from the window
 * this page opened (`source === win`) at its exact origin; a result only for the nonce
 * this page sent. A message from the window that is not one this version knows is
 * `unknown`, so the app can say the two are out of step rather than wait for ever.
 */
export function acceptPasskeyWindowReply(
  msg: PasskeyWindowMessage,
  ctx: { win: unknown; windowOrigin: string; nonce: string; action: PasskeyWindowAction },
):
  | { kind: "ready" }
  | { kind: "result"; result: PasskeyWindowResult }
  | { kind: "error"; error: PasskeyWindowError }
  | { kind: "unknown" }
  | null {
  if (msg.source !== ctx.win || msg.origin !== ctx.windowOrigin) return null;
  const d = msg.data;
  if (!isObject(d) || d.v !== PASSKEY_WINDOW_VERSION) return { kind: "unknown" };
  if (d.type === "ready") return only(d, ["v", "type"]) ? { kind: "ready" } : { kind: "unknown" };
  if (d.type !== "result" || d.nonce !== ctx.nonce) return d.type === "result" ? null : { kind: "unknown" };
  if (d.ok === true) {
    const result = parseResult(ctx.action, d.result);
    return result ? { kind: "result", result } : { kind: "unknown" };
  }
  if (d.ok === false) {
    const error = parseError(d.error);
    return error ? { kind: "error", error } : { kind: "unknown" };
  }
  return { kind: "unknown" };
}
