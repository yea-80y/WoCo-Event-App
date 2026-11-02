/**
 * May this account change its profile name yet?
 *
 * `GET /api/profile/name-status` answers it, and asking BEFORE opening the
 * picker is the point: without it a user mints a brand-new name on-chain
 * (irreversible, gas spent, rate cap consumed) and only then discovers the bind
 * is refused with `name_change_cooldown`. The refusal has to arrive before the
 * mint, not after.
 *
 * Pure: `now` is an argument, and a missing status means OPEN. Fail-open is the
 * deliberate direction — this is a client-side courtesy, and the server refuses
 * the bind for real. A read failure must not lock a user out of their own name.
 */

/** `nameChangeStatus` (`apps/server/src/lib/profile/name-ledger.ts`) as it arrives. */
export interface ProfileNameStatus {
  /** The account's current profile label, or null when it has none / unbound. */
  label: string | null;
  allowed: boolean;
  /** Epoch MS the cooldown ends, or null when a change is allowed now. */
  nextChangeAllowedAt: number | null;
  freeCorrectionUsed: boolean;
}

export type RenameGate =
  | { open: true }
  | { open: false; retryAt: number | null };

export function canOpenRename(
  status: ProfileNameStatus | null | undefined,
  now: number = Date.now(),
): RenameGate {
  if (!status) return { open: true };
  if (status.allowed) return { open: true };
  const at = status.nextChangeAllowedAt;
  // A status read minutes (or a tab-lifetime) ago can outlive the wait it
  // describes. The timestamp is the fact; `allowed` is only its snapshot.
  if (typeof at === "number" && at <= now) return { open: true };
  return { open: false, retryAt: typeof at === "number" ? at : null };
}

/**
 * The same gate asked for one label, right before the claim form mints it.
 * Binding the CURRENT profile label again is never a change (the server's
 * `bindProfileName` lets it through ungated), so it is never refused here.
 */
export function canMintProfileName(
  status: ProfileNameStatus | null | undefined,
  label: string,
  now: number = Date.now(),
): RenameGate {
  if (status?.label && status.label.toLowerCase() === label.toLowerCase().trim()) return { open: true };
  return canOpenRename(status, now);
}
