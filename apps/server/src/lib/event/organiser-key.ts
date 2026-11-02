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
 *
 * `gen` is a freshness tag, not a proof: the server cannot tell that the key derives from
 * S_gen, and any session of the account can bind any key it holds at the current gen.
 * That is the threat it is for - an honest device behind - since the session already IS
 * the account. Never lean on it as evidence of which secret signed.
 */

import { verifyOrganiserKeyBinding } from "@woco/shared";
import { currentRing as realCurrentRing, type CurrentRing } from "../keyring/current-ring.js";

export type OrganiserKeyCheck =
  | { ok: true; key: string }
  | { ok: false; reason: "missing" | "invalid" | "stale" | "unavailable" };

export interface OrganiserKeyDeps {
  currentRing(account: string, opts: { fresh: true; strict: true }): Promise<CurrentRing>;
}

const realDeps: OrganiserKeyDeps = { currentRing: (a, opts) => realCurrentRing(a, opts) };

/** The organiser key `binding` proves for `parent` (the VERIFIED session parent), or why not. */
export async function checkOrganiserKeyBinding(
  binding: unknown,
  parent: string,
  deps: OrganiserKeyDeps = realDeps,
): Promise<OrganiserKeyCheck> {
  if (binding === undefined || binding === null) return { ok: false, reason: "missing" };
  const proven = verifyOrganiserKeyBinding(binding, parent.toLowerCase());
  if (!proven) return { ok: false, reason: "invalid" };

  // Fresh from the chain, never the 30 s cache, and never the last ring seen when the
  // chain cannot be read: a device removed seconds ago must not register under the key it
  // still holds (audit 1157 H-1). This path writes onchain anyway; one read is cheap.
  const ring = await deps.currentRing(parent, { fresh: true, strict: true });
  if (ring.status === "unavailable") return { ok: false, reason: "unavailable" };
  const gen = ring.status === "ring" ? ring.ring.gen : 0;
  if (proven.gen !== gen) return { ok: false, reason: "stale" };
  return { ok: true, key: proven.key };
}
