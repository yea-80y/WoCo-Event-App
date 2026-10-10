/**
 * The unlock rule as a sentence, in one place, so Home, the gate popup, the
 * profile card and the name-claim errors cannot drift apart (#575). The rule
 * itself is the server's: apps/server/src/lib/gate/check.ts.
 */

/** What unlocks an account, as the clause after "unlocks". */
export const UNLOCK_RULE =
  "once a ticket is in your account, or once you or someone you invited verifies with Stripe";

/**
 * `unlocksWhen("Your name")` → "Your name unlocks once …";
 * `unlocksWhen("Your name, photo and bio", true)` → "… unlock once …".
 */
export function unlocksWhen(subject: string, plural = false): string {
  return `${subject} unlock${plural ? "" : "s"} ${UNLOCK_RULE}.`;
}
