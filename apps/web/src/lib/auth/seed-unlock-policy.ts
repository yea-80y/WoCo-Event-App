/**
 * How long a passkey account's seed stays unlocked (#746). ONE constant, so the
 * trade-off between convenience and a lost device changes in one line.
 *
 * The seed opens the attendee-data key and signs as the organiser, so it is what
 * organiser actions ask the passkey for. Everyday posts (likes, follows, profile)
 * never need it: they sign with the cached content-feed signer, an HKDF child of
 * the seed that opens nothing else. Whatever the mode, the seed is also kept locked
 * under the passkey on the device, so changing mode never needs a re-fetch.
 *
 *  - device-window (default): after each unlock - a sign-in, or the confirm before
 *    an organiser action - the seed stays open for `ms`, across reloads, through a
 *    copy under the browser's device key. Then it locks, in memory and on disk, and
 *    the next organiser action asks again. A reload inside the window never extends
 *    it. The expiry is the app's promise, not cryptography: anyone with the browser
 *    profile inside the window reads the seed. GitHub's "sudo mode" is the model.
 *  - per-app-open: memory only - every reload asks again, and an open tab stays
 *    unlocked until it closes.
 */

export type SeedUnlockPolicy = { mode: "device-window"; ms: number } | { mode: "per-app-open" };

export const SEED_UNLOCK_POLICY: SeedUnlockPolicy = { mode: "device-window", ms: 2 * 60 * 60_000 };

/** When an unlock made now closes; null = when the tab closes. */
export function unlockExpiry(policy: SeedUnlockPolicy, now = Date.now()): number | null {
  return policy.mode === "device-window" ? now + policy.ms : null;
}

const HOURS = ["", "an hour", "two hours", "three hours", "four hours", "five hours", "six hours"];

/** What the screens promise about the next ask, from the policy itself, so changing
 *  the window can never leave the copy saying something else. */
export function unlockPromise(policy: SeedUnlockPolicy): string {
  if (policy.mode === "per-app-open") return "WoCo asks once each time you open it.";
  const minutes = Math.round(policy.ms / 60_000);
  const span =
    minutes < 60
      ? `${minutes} minutes`
      : (HOURS[Math.round(minutes / 60)] ?? `${Math.round(minutes / 60)} hours`);
  return `WoCo won't ask again for about ${span}.`;
}
