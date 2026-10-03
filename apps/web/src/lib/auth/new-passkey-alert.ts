/**
 * "A new passkey was added to your account" (#746, Fable consult 9 Q5): each device
 * remembers the account's passkey list as it last saw it and, on the next open,
 * names any passkey added since. It is the main defence when someone else adds a
 * device of their own. The CHAIN's list is diffed, so nothing a re-grant does can
 * look new; a list never seen before is remembered silently; this device's own
 * additions are remembered as they land. Per-device memory only (localStorage).
 */

const key = (parent: string) => `woco:passkeys:seen:${parent.toLowerCase()}`;

function readSeen(parent: string): string[] | null {
  try {
    const raw = globalThis.localStorage?.getItem(key(parent));
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null;
  } catch {
    return null;
  }
}

function writeSeen(parent: string, keys: readonly string[]): void {
  try {
    globalThis.localStorage?.setItem(key(parent), JSON.stringify([...new Set(keys.map((k) => k.toLowerCase()))]));
  } catch {
    /* private window or blocked storage: the alert simply stays quiet */
  }
}

/** This device just put `added` on the list itself: never alert for it. */
export function rememberOwnPasskey(parent: string, added: string): void {
  const seen = readSeen(parent);
  if (seen) writeSeen(parent, [...seen, added]);
}

/** The diff, pure: what is on the list now that was not when this device last looked. */
export function newSince(seen: readonly string[], now: readonly string[], self: string): string[] {
  const before = new Set(seen.map((k) => k.toLowerCase()));
  return now.map((k) => k.toLowerCase()).filter((k) => !before.has(k) && k !== self.toLowerCase());
}

/**
 * Passkeys added since this device last looked; [] when none, when this is the first
 * look (remembered silently) or when the list could not be read.
 */
export async function passkeysAddedSinceLastLook(parent: string, self: string): Promise<string[]> {
  const { readCoOwners } = await import("./kernel-account.js");
  const list = await readCoOwners(parent);
  if (list === "error") return [];
  const now = list ?? [self.toLowerCase()];
  const seen = readSeen(parent);
  if (seen === null) {
    writeSeen(parent, now);
    return [];
  }
  const added = newSince(seen, now, self);
  // Removals and nothing-new are remembered at once; additions only once answered.
  if (added.length === 0) writeSeen(parent, now);
  return added;
}

/**
 * "Yes, it was me" (or after removing them): remember exactly the passkeys the alert
 * SHOWED - never a fresh read, which could quietly accept one added after the alert
 * appeared (background commit review: a check-then-act gap).
 */
export function acknowledgePasskeys(parent: string, shown: readonly string[]): void {
  writeSeen(parent, [...(readSeen(parent) ?? []), ...shown]);
}
