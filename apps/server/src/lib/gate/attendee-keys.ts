/**
 * Turning gate bindings into the certificate rail's holder picker rows (#172).
 *
 * Split from the route for a test seam, and because the two rules below are the
 * whole point of this file and are each one line — exactly the size of change
 * that gets "simplified" back into a silent drop by someone who does not know
 * why they are there.
 */

import type { GateBinding } from "./store.js";

/** ed25519 POD public key, hex, no 0x. */
const POD_PUBKEY_RE = /^[0-9a-f]{64}$/;

export interface AttendeeKeyRow {
  seriesId: string;
  edition: number;
  /** Absent when this attendee has no usable key — see the two rules below. */
  podPubKey?: string;
  /**
   * How the binding was made. Carried so a caller can distinguish a key
   * captured alongside a verified session (`claim`) from one accepted in an
   * unauthenticated redeem body (`email-link`). Neither is a proof of
   * possession — see {@link toAttendeeKeyRows}.
   */
  route: GateBinding["route"];
}

/**
 * Map bindings to picker rows.
 *
 * RULE 1 — EVERY binding is returned, including those with no key. A picker
 * handed only the certifiable ones cannot tell "nobody qualifies" from "the
 * list came back short", and this rail's whole hazard profile is failures that
 * look like empty successes. The surface is required to SHOW un-certifiable
 * attendees rather than drop them, and it can only do that if they arrive.
 *
 * RULE 2 — a malformed key is reported as ABSENT, never passed through. It can
 * only have come from the redeem path, which historically stored whatever
 * string it was sent, and a certificate signed over garbage is permanent and
 * unrevocable in v1.
 *
 * WHAT THESE ROWS DO NOT ESTABLISH: `podPubKey` is self-declared by the
 * claiming client and was never checked against the account's actual POD
 * identity (#345). A binding proves the platform saw a verified possession
 * proof for an edition; it does not prove whose badge key this is. Callers
 * writing permanent artifacts must carry that caveat to whoever decides.
 */
export function toAttendeeKeyRows(bindings: readonly GateBinding[]): AttendeeKeyRow[] {
  return bindings.map((b) => {
    const key = typeof b.podPubKey === "string" ? b.podPubKey.toLowerCase() : undefined;
    return {
      seriesId: b.seriesId,
      edition: b.edition,
      ...(key && POD_PUBKEY_RE.test(key) ? { podPubKey: key } : {}),
      route: b.route,
    };
  });
}
