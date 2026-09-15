/**
 * The account's PROFILE name, for links that stand for the person (the invite
 * code, the follow code), or null, in which case the caller uses the address.
 *
 * Only the profile name, never another name the account owns. A site or event
 * name in an invite reads as that page inviting (owner's phone test,
 * 2026-09-15: the Invite code carried an event's name because it sorted first).
 *
 * Worked out in the app: the label comes from the account's own signed profile
 * and counts only once the chain says this account holds it (`verifyName`,
 * which fails closed). The server's name ledger is not asked; it stays for
 * enforcement. Both reads are public, so this needs no session and never
 * prompts.
 */

export interface ProfileNameDeps {
  readProfile(address: string): Promise<{ subEnsLabel?: string } | null>;
  /** True only when the chain says `owner` holds `label`. */
  verify(label: string, owner: string): Promise<boolean>;
}

// Lazy, so a node test can import this module without the API client.
const liveDeps: ProfileNameDeps = {
  readProfile: async (address) => (await import("../api/profiles.js")).getProfile(address),
  verify: async (label, owner) => (await import("./verify-name.js")).verifyName(label, owner),
};

export async function verifiedProfileName(
  address: string,
  deps: ProfileNameDeps = liveDeps,
): Promise<string | null> {
  const owner = address.toLowerCase();
  try {
    const label = (await deps.readProfile(owner))?.subEnsLabel;
    if (!label) return null;
    return (await deps.verify(label, owner)) ? label : null;
  } catch {
    // An unread profile or an unanswered check is not a name: the address link stands.
    return null;
  }
}
