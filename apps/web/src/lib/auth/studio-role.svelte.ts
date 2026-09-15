/**
 * Whether the signed-in account organises, as a value WoCo's Studio entry can
 * follow. Backed by the device flag in `studio-flag.ts`, so marking shows the
 * Studio link at once rather than on the next visit.
 *
 * `mark` bumps the version only when the flag actually changes: Studio screens
 * re-mark on every load, and a bump that changed nothing would still make every
 * reader re-check.
 */

import { auth } from "./auth-store.svelte.js";
import { hasStudio, markStudio } from "./studio-flag.js";

let version = $state(0);

export const studioRole = {
  get isOrganiser(): boolean {
    void version;
    return hasStudio(auth.parent);
  },

  mark(parent: string | null | undefined): void {
    if (!parent || hasStudio(parent)) return;
    markStudio(parent);
    version++;
  },
};
