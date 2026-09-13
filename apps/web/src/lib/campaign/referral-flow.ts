/**
 * Settling a captured referral — the decision half, and nothing else.
 *
 * THE RULE THIS FILE EXISTS TO HOLD: a referral statement is written at a
 * moment the user did not ask for. They followed an invite, they signed in, and
 * the app writes a claim on their behalf. A signing ceremony there is
 * unexplained, and an unexplained ceremony is one people decline — so the only
 * signer this may reach for is one that is ALREADY on the device.
 *
 * That is enforced structurally rather than by comment: `getSigner` is the sole
 * way in, the caller wires it to `auth.getContentFeedSignerIfPresent` (which
 * never prompts), and `null` from it ends the attempt with the capture intact.
 * The seed arrives with whatever the user does next — a like, a publish, a
 * ticket — and `auth.hasIdentitySeed` flipping re-runs this.
 *
 * WHAT SURVIVES A FAILURE is the other half of the design. The capture is
 * cleared ONLY when the statement is CONFIRMED on the feed or the referral was
 * never valid; every other outcome keeps it, because a dropped capture is a
 * credit nobody can recover — the link is not followed twice. That includes
 * `unconfirmed`: the write was accepted but not read back, and while that is
 * usually propagation it is also exactly the shape a dead postage batch takes.
 * Keeping the capture costs one idempotent head read per later sign-in
 * (`writeReferralStatement` checks before it writes); clearing it would cost
 * the referral in the one case that matters.
 *
 * Pure, and its only imports are TYPES — erased at build, so the rules below
 * are testable without a browser, a wallet or a network, for the same reason
 * `referral-capture.ts` is.
 */

import type { Hex0x } from "@woco/shared";
import type { VerifiedWriteResult } from "../swarm/verified-write.js";

/**
 * What the attempt did. Six outcomes rather than a boolean because the caller's
 * correct response differs: three keep the capture for a later run and three
 * are final.
 */
export type SettleOutcome =
  /** Nothing was captured — the ordinary case for almost every sign-in. */
  | "none"
  /** The capture named the signed-in account. Dropped: a self-referral is not a referral. */
  | "self"
  /** No seed on this device yet. The capture waits; nothing was prompted. */
  | "no-signer"
  /** The statement is on the referee's feed. */
  | "written"
  /** Not confirmed on the feed: another writer took our version (LOST, not
   *  late) or the read-back could not answer. Retried later, idempotently. */
  | "deferred"
  /** The write threw. Kept, because a network failure is not a decision. */
  | "failed";

export interface SettleReferralDeps {
  /** The signed-in account, for the self-referral check. */
  parent: string | null;
  capturedRef: () => Hex0x | null;
  /** MUST be the prompt-free getter — see this module's header. */
  getSigner: () => Promise<{ privKey: string; address: string } | null>;
  write: (
    signer: { privKey: string; address: string },
    referrer: Hex0x,
  ) => Promise<VerifiedWriteResult>;
  clear: () => void;
}

export async function settleCapturedReferral(deps: SettleReferralDeps): Promise<SettleOutcome> {
  const referrer = deps.capturedRef();
  if (!referrer) return "none";

  // Dropped here as well as refused by the server, because a self-referral is
  // never going to become valid — keeping it would retry it on every sign-in
  // forever, and leave the confirm banner's subject pointing at the user.
  if (deps.parent && referrer === deps.parent.toLowerCase()) {
    deps.clear();
    return "self";
  }

  try {
    const signer = await deps.getSigner();
    // The ONE signer source. Null is a wait, not a failure: this device has no
    // seed yet and asking for one is exactly what this path may not do.
    if (!signer) return "no-signer";

    const written = await deps.write(signer, referrer);
    // Only a VERIFIED write clears. `unconfirmed` means accepted but not read
    // back, and a write that is not on the feed is a referral the server will
    // never countersign — so the capture stays and the next run re-checks,
    // which is cheap because the write is idempotent (see records.ts).
    if (written.status !== "verified") return "deferred";
    deps.clear();
    return "written";
  } catch {
    // Kept on purpose: a failed network call says nothing about whether the
    // referral is valid, and this is the only record that it happened.
    return "failed";
  }
}
