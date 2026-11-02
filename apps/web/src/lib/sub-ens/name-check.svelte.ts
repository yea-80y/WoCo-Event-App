/**
 * The chain check for a label a feed CLAIMS, as reactive state for a component.
 *
 * Shared by the screens that let an owner manage a stored name (the Profile
 * domain card, the site builder's Domain tab): both must show "is yours" only on
 * "owned", the claim form on "none" / "not-owned", and neither while "checking"
 * or "unknown" - offering the claim form during an outage invites a second mint.
 * The rules themselves are in ./verify-name.ts.
 *
 * Call during component initialisation (it registers an effect). `read` is
 * tracked, so a new label or owner starts a new check; an answer for the old one
 * is dropped.
 */

import { checkName, paintName, type NameCheck } from "./verify-name.js";

export type NameCheckState = "none" | "checking" | NameCheck;

export interface NameCheckHandle {
  readonly state: NameCheckState;
  /** The chain said `owner` holds `label` - the only state that may say "yours". */
  readonly verified: boolean;
  retry(): void;
}

export function createNameCheck(
  read: () => { label: string | null | undefined; owner: string | null | undefined },
): NameCheckHandle {
  let state = $state<NameCheckState>("none");
  let attempt = $state(0);

  $effect(() => {
    const { label, owner } = read();
    void attempt;
    if (!label || !owner) {
      state = "none";
      return;
    }
    let live = true;
    state = paintName(label, owner);
    void checkName(label, owner).then((result) => {
      if (live) state = result;
    });
    return () => {
      live = false;
    };
  });

  return {
    get state() {
      return state;
    },
    get verified() {
      return state === "owned";
    },
    retry() {
      attempt++;
    },
  };
}
