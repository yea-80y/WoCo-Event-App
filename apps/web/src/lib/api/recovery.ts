import type { ApiResponse, RecoveryEnvelope, RecoveryGuardianIndex, RecoveryStatus } from "@woco/shared";
import { authPost, apiBase } from "./client.js";

/**
 * Recovery-escrow API (PASSKEY_RECOVERY_PLAN §11.6 / §13).
 *
 * §13: the sealed envelope now lives in a GUARDIAN-owned SOC (see
 * `swarm/recovery-feed.ts`), NOT on a platform-signed feed. This module therefore
 * only handles the untrusted PLATFORM HINTS (presence + guardian auto-find) and
 * the LEGACY envelope read used as a recovery fallback for pre-§13 accounts.
 */

/**
 * Register the platform-signed presence hint after a protect ceremony. Writes the
 * kernel→guardian status doc AND the guardian→kernel reverse-lookup (both untrusted
 * convenience hints; the guardian-owned SOC is the source of truth). Authenticated
 * as the Kernel — the server stamps `kernelAddress` from the verified parent.
 */
export async function registerRecoveryHint(opts: {
  guardianAddress: string;
  label?: string;
}): Promise<ApiResponse<{ kernelAddress: string }>> {
  return authPost<{ kernelAddress: string }>("/api/recovery/escrow", {
    guardianAddress: opts.guardianAddress,
    label: opts.label,
  });
}

/**
 * Presence hint for a Kernel address (§13) — drives the setup screen's "backup on
 * record" state and the portal's existence check. Public, untrusted: a missing/
 * forged value only mis-renders the UI; real recoverability is proven only by
 * decrypting the guardian SOC. Covers legacy accounts too (the server falls back
 * to the old platform envelope feed when no status doc exists).
 */
export async function fetchRecoveryStatus(kernelAddress: string): Promise<RecoveryStatus | null> {
  const resp = await fetch(`${apiBase}/api/recovery/status/${kernelAddress.toLowerCase()}`);
  const json = (await resp.json()) as ApiResponse<RecoveryStatus | null>;
  if (!json.ok) throw new Error(json.error || "Failed to load recovery status");
  return json.data ?? null;
}

/** Auto-find the account a guardian protects. Public — no auth headers. */
export async function fetchRecoveryByGuardian(
  guardianAddress: string,
): Promise<RecoveryGuardianIndex | null> {
  const resp = await fetch(`${apiBase}/api/recovery/by-guardian/${guardianAddress.toLowerCase()}`);
  const json = (await resp.json()) as ApiResponse<RecoveryGuardianIndex | null>;
  if (!json.ok) throw new Error(json.error || "Failed to load recovery index");
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
