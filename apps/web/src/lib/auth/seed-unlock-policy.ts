/**
 * When a passkey account's keys unlock on this device (#746 fix 1). ONE constant, so
 * the trade-off between convenience and a lost device can be changed in one line.
 *
 * Whatever the mode, the seed is also kept locked under the passkey on the device,
 * so switching mode never needs a re-fetch.
 *
 *  - per-app-open (default): the seed exists only in memory. The sign-in that opens
 *    the account unlocks it; after a reload, the first action that signs asks the
 *    passkey once, and nothing after that until the tab closes. Hidden longer than
 *    `relockAfterHiddenMs` (a phone in a pocket) locks it again. Protects a lost
 *    locked phone fully, and a lost unlocked one once the relock has passed.
 *  - device-window: as above, plus a copy under the browser's device key for `ms`
 *    after each unlock, which opens silently. A convenience window: anyone with the
 *    browser profile reads the seed until the app deletes the copy - the expiry is
 *    the app's promise, not cryptography.
 *  - always: the behaviour before fix 1 - a device-key copy that opens silently on
 *    every load, with no expiry.
 *
 * "Attendee data only" is deliberately not a mode: the attendee-data key is derived
 * from the same seed that signs posts, so it cannot be locked on its own.
 */

export type SeedUnlockPolicy =
  | { mode: "per-app-open"; relockAfterHiddenMs?: number }
  | { mode: "device-window"; ms: number }
  | { mode: "always" };

export const SEED_UNLOCK_POLICY: SeedUnlockPolicy = {
  mode: "per-app-open",
  relockAfterHiddenMs: 15 * 60_000,
};

/** Does this policy keep a copy that opens without the passkey? */
export function keepsSilentCopy(policy: SeedUnlockPolicy): boolean {
  return policy.mode !== "per-app-open";
}

/** When a silent copy written now stops opening; null = never expires. */
export function silentCopyExpiry(policy: SeedUnlockPolicy, now = Date.now()): number | null {
  return policy.mode === "device-window" ? now + policy.ms : null;
}

/** Should a page hidden for `hiddenMs` come back locked? */
export function shouldRelock(policy: SeedUnlockPolicy, hiddenMs: number): boolean {
  return (
    policy.mode === "per-app-open" &&
    policy.relockAfterHiddenMs !== undefined &&
    hiddenMs >= policy.relockAfterHiddenMs
  );
}
