/**
 * Client-side sub-ENS label cache, keyed by ACCOUNT ADDRESS.
 *
 * Every profile read hands us both an account address and, when one is claimed,
 * its sub-ENS label. Remembering the pair means any name the user has already
 * encountered - their own profile, an organiser they viewed, a directory card -
 * can be displayed later without a server-side reverse map.
 *
 * KEYED ON THE ADDRESS, not a namehash. This used to key on
 * `profileSubject(label)`, the namehash of `{label}.woco.eth`, because the
 * retired EAS like-subject WAS that namehash. Subjects are account addresses now
 * (owner decision 2026-09-03): a namehash keyed an audience to something
 * governance or custody could move, and an entry went stale the moment a name was
 * released or renamed. An address cannot move, so an entry cannot go stale - it
 * can only go out of date, which the next profile read corrects.
 *
 * WRITE-ONLY ON PURPOSE, for now. The reader went with the Following/Trending
 * surfaces when the EAS rail was deleted (#475), and the Swarm-native follow list
 * that replaces them is not built yet. The cache keeps filling so that list has
 * names on the day it ships rather than a screen of hex - do not delete this as
 * dead code without checking #475 first.
 *
 * Best-effort display cache, never truth: an unknown address simply has no name.
 * The authoritative path stays on-chain (`L2Registry.ownerOf(node)`) and can back
 * this later without changing callers (feedback_client_first_architecture).
 */

/** v1 was keyed by namehash; a bump is cheaper than migrating a display cache. */
const KEY = "woco:subens-labels:v2";

type LabelMap = Record<string, string>; // lowercased account address → label

function read(): LabelMap {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as LabelMap) : {};
  } catch {
    return {};
  }
}

function write(map: LabelMap): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* quota / private mode — display cache is non-essential */
  }
}

/**
 * Remember an account's sub-ENS label. Call wherever a profile has just been
 * read, so the label lands beside the address it belongs to.
 */
export function rememberLabel(
  address: string | undefined | null,
  label: string | undefined | null,
): void {
  if (!address || !label) return;
  const key = address.toLowerCase().trim();
  const clean = label.toLowerCase().trim();
  if (!key || !clean) return;
  const map = read();
  if (map[key] === clean) return; // no-op, avoid a write
  map[key] = clean;
  write(map);
}
