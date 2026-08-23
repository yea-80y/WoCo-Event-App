import type { ApiResponse, RecoveryEnvelope, RecoveryStatus } from "@woco/shared";
import { authPost, apiBase } from "./client.js";

/**
 * Recovery-escrow API (PASSKEY_RECOVERY_PLAN §11.6 / §13).
 *
 * §13: the sealed envelope lives in a GUARDIAN-owned SOC (`swarm/recovery-feed.ts`),
 * and since #157 so does the guardian→account auto-find index
 * (`swarm/guardian-index-feed.ts`) — the server writes and serves neither. This
 * module therefore only handles the untrusted PLATFORM PRESENCE HINT and the
 * LEGACY envelope read used as a recovery fallback for pre-§13 accounts.
 */

/**
 * Register the platform-signed presence hint after a protect ceremony. The server
 * stamps the verified parent as the Kernel; nothing else crosses the wire — the
 * guardian address and label that used to be sent here were a linkage leak (#157).
 * Untrusted convenience: the guardian-owned SOCs are the source of truth.
 */
export async function registerRecoveryHint(): Promise<ApiResponse<{ kernelAddress: string }>> {
  return authPost<{ kernelAddress: string }>("/api/recovery/escrow", {});
}

/**
 * Clear the platform presence hint after an on-chain "Remove all backups" (#165)
 * — flips it to not-configured. With `keepStatus` (ONE guardian revoked on-chain,
 * the account still has working backups, #164) the hint is left standing and the
 * call is a no-op kept for uniform bookkeeping.
 *
 * NON-FATAL by design: it is an untrusted hint, and the revoke that matters
 * already happened on-chain. Never gate the removal's success on this.
 */
export async function clearRecoveryHint(opts: {
  /** ONE guardian was revoked and the account still has working backups: leave the hint. */
  keepStatus?: boolean;
} = {}): Promise<ApiResponse<{ kernelAddress: string; statusFlipped: boolean }>> {
  return authPost<{ kernelAddress: string; statusFlipped: boolean }>(
    "/api/recovery/escrow/clear",
    opts.keepStatus ? { keepStatus: true } : {},
  );
}

/**
 * Presence hint for a Kernel address (§13) — drives the setup screen's "backup on
 * record" state. Public, untrusted: a missing/forged value only mis-renders the
 * UI; real recoverability is proven only by decrypting the guardian SOC. Covers
 * legacy accounts too (the server falls back to the old platform envelope feed
 * when no status doc exists). Says nothing about who the guardian is.
 */
export async function fetchRecoveryStatus(kernelAddress: string): Promise<RecoveryStatus | null> {
  const resp = await fetch(`${apiBase}/api/recovery/status/${kernelAddress.toLowerCase()}`);
  const json = (await resp.json()) as ApiResponse<RecoveryStatus | null>;
  if (!json.ok) throw new Error(json.error || "Failed to load recovery status");
  return json.data ?? null;
}

/**
 * LEGACY: fetch the platform-signed sealed envelope for a Kernel address. §13
 * moved new escrows to a guardian-owned SOC, so this is the RECOVERY READ FALLBACK
 * for accounts protected before the migration only. Public — no auth headers.
 */
export async function fetchRecoveryEnvelope(
  kernelAddress: string,
): Promise<RecoveryEnvelope | null> {
  const resp = await fetch(`${apiBase}/api/recovery/escrow/${kernelAddress.toLowerCase()}`);
  const json = (await resp.json()) as ApiResponse<RecoveryEnvelope | null>;
  if (!json.ok) throw new Error(json.error || "Failed to load recovery envelope");
  return json.data ?? null;
}
