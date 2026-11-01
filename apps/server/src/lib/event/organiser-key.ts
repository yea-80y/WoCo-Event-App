/**
 * The organiser key a ledger2 registration names (`registerEvent(organiser, organiserKey, …)`).
 *
 * The key is derived and held in the organiser's browser (`@woco/shared/crypto/organiser-key`);
 * the server only ever sees its address and a binding signed by it. This check exists because
 * the platform's sponsor wallet is what submits the registration: before it names a key on
 * chain for an account, the key must have signed for THAT account, at the account's CURRENT
 * key-ring generation, so a device behind never registers under a key the account has moved
 * off (#186). Nothing is stored: from registration on, the ledger is the only record of the
 * key (`getOrganiserKey`). An organiser registering its own event needs none of this.
 */

import { verifyOrganiserKeyBinding } from "@woco/shared";
import { currentRing as realCurrentRing, type CurrentRing } from "../keyring/current-ring.js";

export type OrganiserKeyCheck =
  | { ok: true; key: string }
  | { ok: false; reason: "missing" | "invalid" | "stale" | "unavailable" };

export interface OrganiserKeyDeps {
  currentRing(account: string): Promise<CurrentRing>;
}

const realDeps: OrganiserKeyDeps = { currentRing: (a) => realCurrentRing(a) };

/** The organiser key `binding` proves for `parent` (the VERIFIED session parent), or why not. */
export async function checkOrganiserKeyBinding(
  binding: unknown,
  parent: string,
  deps: OrganiserKeyDeps = realDeps,
): Promise<OrganiserKeyCheck> {
  if (binding === undefined || binding === null) return { ok: false, reason: "missing" };
  const proven = verifyOrganiserKeyBinding(binding, parent.toLowerCase());
  if (!proven) return { ok: false, reason: "invalid" };

  const ring = await deps.currentRing(parent);
  if (ring.status === "unavailable") return { ok: false, reason: "unavailable" };
  const gen = ring.status === "ring" ? ring.ring.gen : 0;
  if (proven.gen !== gen) return { ok: false, reason: "stale" };
  return { ok: true, key: proven.key };
}
