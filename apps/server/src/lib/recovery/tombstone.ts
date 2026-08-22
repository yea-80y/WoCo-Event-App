/**
 * Pure decision logic for the guardian reverse-index tombstones (#165).
 *
 * Split out of the route so it can be unit-tested: the route body itself does
 * Swarm I/O, which in this repo goes to the real bee. What is worth pinning is
 * exactly what lives here — WHICH guardians get tombstoned, in what order, and
 * WHOSE entries the caller is allowed to touch.
 */

import { MAX_CLEAR_GUARDIANS, type RecoveryGuardianIndex } from "@woco/shared";

export { MAX_CLEAR_GUARDIANS };

/**
 * Order the guardians to tombstone, de-duplicated and lowercased.
 *
 * The status document's guardian goes FIRST and deliberately so: it is the current
 * auto-find pointer and the only entry the server can name without the client, so
 * it must never be the one an over-long client list evicts. (An earlier cut
 * appended it last and then sliced — a 32-entry client list dropped precisely the
 * guardian that mattered most.)
 */
export function selectTombstoneTargets(args: {
  requested: string[];
  statusGuardian?: string;
}): string[] {
  const ordered = [
    ...(args.statusGuardian ? [args.statusGuardian] : []),
    ...args.requested,
  ].map((g) => g.toLowerCase());
  // +1 so a full client list never costs the server's own entry its slot.
  return [...new Set(ordered)].slice(0, MAX_CLEAR_GUARDIANS + 1);
}

/**
 * What a clear request asks the server to do with the hints — decided in one
 * place so the two shapes cannot be confused (#164):
 *
 *  - REMOVE ALL (`keepStatus` false): flip the presence hint to not-configured and
 *    tombstone the status doc's guardian plus every guardian the client names.
 *  - REVOKE ONE (`keepStatus` true): the account still HAS working backups, so the
 *    presence hint must stay — flipping it would make the portal's chain-unreadable
 *    fallback tell a protected user "no backup found". Tombstone ONLY the guardians
 *    the client names; the status doc's guardian is left alone even if it is stale
 *    (it is a hint the chain overrides, and the client did not ask for it).
 */
export function planHintClear(args: {
  requested: string[];
  statusGuardian?: string;
  keepStatus: boolean;
}): { flipStatus: boolean; targets: string[] } {
  if (args.keepStatus) {
    const targets = [...new Set(args.requested.map((g) => g.toLowerCase()))].slice(0, MAX_CLEAR_GUARDIANS);
    return { flipStatus: false, targets };
  }
  return {
    flipStatus: true,
    targets: selectTombstoneTargets({ requested: args.requested, statusGuardian: args.statusGuardian }),
  };
}

/**
 * May this caller tombstone this index entry?
 *
 * ONLY when the entry already points at the caller's own verified Kernel. Naming
 * someone else's guardian address does nothing — which is what keeps a public,
 * poisonable convenience index from becoming a way to switch off other people's
 * auto-find. An absent or already-revoked entry is a no-op, not an error.
 */
export function mayTombstone(
  index: RecoveryGuardianIndex | null | undefined,
  parentAddress: string,
): boolean {
  if (!index || index.revoked) return false;
  return index.kernelAddress.toLowerCase() === parentAddress.toLowerCase();
}
