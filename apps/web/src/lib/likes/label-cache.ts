/**
 * Client-side sub-ENS name resolution for like-subjects.
 *
 * A profile like-subject is the ENS namehash of `{label}.woco.eth` — a one-way
 * hash, so the Following/Trending lists (which only carry the `bytes32` subject)
 * can't display a human name on their own. Rather than add a server reverse-map,
 * we exploit a fact we already have: every time the client derives a subject via
 * `profileSubject(label)` it holds BOTH the label and its namehash. We remember
 * that pair here so any name the user has encountered (their own profile, an
 * organiser they viewed, a directory card) resolves to `{label}.woco.eth`.
 *
 * This is intentionally a best-effort display cache, not truth: an unknown
 * subject simply falls back to the short hex. The authoritative reverse path
 * stays on-chain (`L2Registry.ownerOf(node)` → owner → profile label) and can
 * back this cache later without changing callers (feedback_client_first_architecture).
 */

import { profileSubject } from "@woco/shared";
import type { Hex0x } from "@woco/shared";

const KEY = "woco:subens-labels";

type LabelMap = Record<string, string>; // namehash(lowercased) → label

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
 * Remember a sub-ENS label so its namehash subject resolves to a name later.
 * Call wherever a known label is in hand (profile load, event/creator chip).
 */
export function rememberLabel(label: string | undefined | null): void {
  if (!label) return;
  const clean = label.toLowerCase().trim();
  if (!clean) return;
  const subject = profileSubject(clean).toLowerCase();
  const map = read();
  if (map[subject] === clean) return; // no-op, avoid a write
  map[subject] = clean;
  write(map);
}

/** Resolve a like-subject `bytes32` to its `{label}.woco.eth`, if known. */
export function nameForSubject(id: Hex0x | string): string | null {
  const label = read()[id.toLowerCase()];
  return label ? `${label}.woco.eth` : null;
}
