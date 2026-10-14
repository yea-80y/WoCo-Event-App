/**
 * What the scanner does with a door pass that the server would not set up, and
 * with a stored pass that is past its date. Kept apart from the store (runes +
 * IndexedDB) so each rule is testable in node: `apps/web/test/scanner-pass-gate.test.ts`.
 *
 * A pass that fails to set up must never send the phone back to whichever event
 * it held before: the door staff would be scanning against the wrong event (or an
 * expired one) with nothing on screen saying so.
 */

export type PackFailure =
  /** Revoked, expired, for another event, or bound to another phone: only a new pass helps. */
  | { kind: "dead"; message: string }
  | { kind: "error"; message: string };

export const NO_CONNECTION_MESSAGE = "Couldn't reach WoCo - check this phone's connection and try again.";

/** Turn a refused pack request into what the door staff are told, and whether retrying can help. */
export function describePackFailure(status: number, body: { error?: unknown } | null): PackFailure {
  const message = typeof body?.error === "string" && body.error ? body.error : `WoCo couldn't set up this scanner (${status}) - try again.`;
  if (status === 401 || status === 403 || status === 409) return { kind: "dead", message };
  return { kind: "error", message };
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
