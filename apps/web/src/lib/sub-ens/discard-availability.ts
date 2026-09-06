/**
 * The one place that names the two chains the discard gate compares.
 *
 * `releaseRails` is pure and takes them as arguments so it can be tested
 * without the auth graph; this is its single wiring point. #489 moves
 * `KERNEL_CHAIN_ID` into `@woco/shared` and flips it to 42161 — after which
 * this import is the only line that changes and the AA logins get their discard
 * button, with nothing else to remember.
 */

import { SUB_ENS_DEFAULT_CHAIN_ID } from "@woco/shared";
import type { AuthKind } from "@woco/shared";
import { KERNEL_CHAIN_ID } from "../auth/kernel-account.js";
import { releaseRails, type ReleaseRailPlan } from "./release-rails.js";

export function discardPlanFor(kind: AuthKind): ReleaseRailPlan {
  return releaseRails(kind, KERNEL_CHAIN_ID, SUB_ENS_DEFAULT_CHAIN_ID);
}
