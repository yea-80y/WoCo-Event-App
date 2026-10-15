/**
 * The door pass this browser remembers for an event (`localStorage`, token only - its
 * secret is worked out again from the account's keys). `v: 2` marks a pass made since
 * the pass secret P (live door list): a pass stored before it has a roster sealed
 * under the old key and no door entries key on the server, so a link built for it
 * now would open nothing. Such a pass is shown as stale, like one from an older key
 * generation, and the organiser is asked to make a new one.
 */
import type { DoorMode } from "@woco/shared";

export const DOOR_PASS_FORMAT = 2;

export interface StoredDoorPass {
  /** DOOR_PASS_FORMAT for a pass made with P; absent on one stored before. */
  v?: number;
  /** The pass token only - its roster key is worked out again when needed. */
  token: string;
  exp: number;
  mode: DoorMode;
  /** The account's key generation the pass was made under: a later one revokes it. */
  gen: number;
  rosterPushedAt?: string;
}

export const KEYS_CHANGED = "This door pass stopped working when your account's keys changed - make a new one.";
export const PASS_FROM_OLDER_VERSION = "This door pass was made with an older version of WoCo and no longer works - make a new one.";

/** What is stored, or null when nothing usable is (a pass with its key in clear, from before #186, included). */
export function parseStoredDoorPass(raw: string | null): StoredDoorPass | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<StoredDoorPass> | null;
    if (!p || typeof p.token !== "string" || typeof p.gen !== "number" || typeof p.exp !== "number") return null;
    return {
      ...(typeof p.v === "number" ? { v: p.v } : {}),
      token: p.token,
      exp: p.exp,
      mode: p.mode === "single" ? "single" : "several",
      gen: p.gen,
      ...(typeof p.rosterPushedAt === "string" ? { rosterPushedAt: p.rosterPushedAt } : {}),
    };
  } catch {
    return null;
  }
}

/** Null when the pass can be shown and its roster re-pushed; otherwise why not. */
export function storedPassStale(p: StoredDoorPass, currentGen: number): string | null {
  if (p.v !== DOOR_PASS_FORMAT) return PASS_FROM_OLDER_VERSION;
  if (p.gen !== currentGen) return KEYS_CHANGED;
  return null;
}
