/**
 * When a scanner that has a newer version waiting may reload into it. Kept apart
 * from the store (runes) and the service-worker glue (`sw-update.ts`) so the rule
 * is testable in node: `apps/web/test/scanner-update-policy.test.ts`.
 *
 * Never mid-admission: a reload during a claim loses the answer staff are waiting
 * for, and one right after a scan wipes the verdict card off the screen before
 * anyone has read it.
 */

/** Longer than the longest verdict card (5 s), so a reload never removes one being read. */
export const UPDATE_QUIET_MS = 8_000;
/** How often a waiting update looks again for a quiet moment. */
export const UPDATE_RETRY_MS = 2_000;

export interface UpdateMoment {
  phase: "loading" | "unprovisioned" | "provisioning" | "ready" | "failed";
  claimInFlight: boolean;
  /** A scan, or a lookup for a ticket newer than the pack, is running. */
  busy: boolean;
  sinceLastScanMs: number;
}

export function canApplyUpdate(m: UpdateMoment): boolean {
  if (m.phase === "provisioning") return false;
  return !m.claimInFlight && !m.busy && m.sinceLastScanMs >= UPDATE_QUIET_MS;
}
