/**
 * Whether the signed-in account organises, as a value WoCo's Organiser entry can
 * follow. Backed by the device flag in `organiser-flag.ts`, so marking shows the
 * Organiser link at once rather than on the next visit.
 *
 * `mark` bumps the version only when the flag actually changes: organiser screens
 * re-mark on every load, and a bump that changed nothing would still make every
 * reader re-check.
 */

import { auth } from "./auth-store.svelte.js";
import { hasOrganiser, markOrganiser } from "./organiser-flag.js";

let version = $state(0);

export const organiserRole = {
  get isOrganiser(): boolean {
    void version;
    return hasOrganiser(auth.parent);
  },

  mark(parent: string | null | undefined): void {
    if (!parent || hasOrganiser(parent)) return;
    markOrganiser(parent);
    version++;
  },
};
