/**
 * What the scanner does with a door pass that the server would not set up, and
 * with a stored pass that is past its date. Kept apart from the store (runes +
 * IndexedDB) so each rule is testable in node: `apps/web/test/scanner-pass-gate.test.ts`.
 *
 * A pass that fails to set up must never send the phone back to whichever event
 * it held before: the door staff would be scanning against the wrong event (or an
 * expired one) with nothing on screen saying so.
 */

import { parseDoorPassFragment, SCANNER_OUTDATED_REASON } from "@woco/shared";

export type PackFailure =
  /** Revoked, expired, for another event, or bound to another phone: only a new pass helps. */
  | { kind: "dead"; message: string; expired: boolean }
  /** The server needs newer scanner code: update, then try the same pass again. */
  | { kind: "outdated"; message: string }
  | { kind: "error"; message: string };

export const NO_CONNECTION_MESSAGE = "Couldn't reach WoCo - check this phone's connection and try again.";
/** Shown only when the scanner could not update itself after the server asked it to. */
export const OUTDATED_MESSAGE =
  "This scanner is out of date and couldn't update itself. Close this tab, then scan the door pass again.";

/** Turn a refused pack request into what the door staff are told, and whether retrying can help. */
export function describePackFailure(status: number, body: { error?: unknown; reason?: unknown } | null): PackFailure {
  if (status === 400 && body?.reason === SCANNER_OUTDATED_REASON) return { kind: "outdated", message: OUTDATED_MESSAGE };
  const message = typeof body?.error === "string" && body.error ? body.error : `WoCo couldn't set up this scanner (${status}) - try again.`;
  if (status === 401 || status === 403 || status === 409) return { kind: "dead", message, expired: isExpiredRefusal(status, body) };
  return { kind: "error", message };
}

/**
 * The server refused the pass as past its `exp`. The phone's clock may disagree (set
 * wrong), so this alone ends the pass on the phone, as its own clock would.
 */
export function isExpiredRefusal(status: number, body: { reason?: unknown } | null): boolean {
  return status === 401 && body?.reason === "expired";
}

export const PASS_EXPIRED_MESSAGE =
  "The door pass on this phone has expired. Scan the new one from the organiser's dashboard.";

/**
 * A stored pass past its `exp` (unix seconds) opens nothing: every request on it
 * is refused, so opening its event would only show stale data for an event that
 * is over - or, on a phone reused for a new event, the wrong one.
 */
export function isPassExpired(exp: number, nowMs: number): boolean {
  return !Number.isFinite(exp) || exp * 1000 <= nowMs;
}

export interface DoorPass {
  token: string;
  keyB64url: string;
}

export interface FragmentBoot {
  location: { hash: string; pathname: string; search: string; href: string };
  history: Pick<History, "replaceState">;
  /** Runs only when a pass is in the URL, before it is used: the phone leaves whatever it showed and holds this pass. */
  arriving?: (pass: DoorPass) => void;
  /** True when a newer scanner has taken over this page, so the pass goes to that version instead. */
  newerVersion?: () => Promise<boolean>;
  /** Reload into the newer version. The ONE path that may put the pass back in the URL, for exactly that reload. */
  reload?: (pass: DoorPass) => void;
  provision: (token: string, keyB64url: string) => Promise<boolean>;
}

/**
 * Read the door pass from the URL and take it out of the address bar and history
 * at once. The fragment carries the pass token AND the roster key, so it goes
 * the moment it is read - before storage is opened or the pack requested,
 * whatever their outcome. The pass is then held in memory only.
 */
export function takePassFromUrl(location: FragmentBoot["location"], history: FragmentBoot["history"]): DoorPass | null {
  const pass = parseDoorPassFragment(location.hash);
  if (pass) history.replaceState(null, "", new URL(location.pathname + location.search, location.href).href);
  return pass;
}

/**
 * Set up a pass that has arrived. A newer scanner waiting to take over is asked
 * for first, so a stale phone sets the pass up with current code rather than
 * having the server refuse it.
 */
export async function setUpArrivedPass(
  pass: DoorPass,
  s: Pick<FragmentBoot, "newerVersion" | "reload" | "provision">,
): Promise<"reloading" | "provisioned" | "failed"> {
  if (s.reload && s.newerVersion && (await s.newerVersion())) {
    s.reload(pass);
    return "reloading";
  }
  return (await s.provision(pass.token, pass.keyB64url)) ? "provisioned" : "failed";
}

/** A pass link, at boot or arriving in an open tab: take it, hold it, set it up. */
export async function bootFromFragment(b: FragmentBoot): Promise<"none" | "reloading" | "provisioned" | "failed"> {
  const pass = takePassFromUrl(b.location, b.history);
  if (!pass) return "none";
  b.arriving?.(pass);
  return setUpArrivedPass(pass, b);
}

/**
 * A pass link opened while the scanner is already open. Some phone browsers
 * (Samsung Internet, 2026-10-14) reuse the open tab and change only the
 * fragment, so the page never reloads and boot never sees the new pass.
 * `replaceState` fires no hashchange, so scrubbing cannot re-trigger this.
 */
export function onPassLink(target: Pick<EventTarget, "addEventListener">, take: () => void): void {
  target.addEventListener("hashchange", () => take());
}
