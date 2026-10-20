import { shortRef } from "../../campaign/referral-capture.js";

/**
 * What the new device shows as the account it joined: the short address only. The
 * address is the account the opened answer named and the sign-in went to; a display
 * name is free text that account chose (lookalike characters, text-direction marks),
 * so it is not shown on this screen at all (#936, commit security review).
 */
export function joinedAccountLabel(parent: string): string {
  return shortRef(parent.toLowerCase());
}
