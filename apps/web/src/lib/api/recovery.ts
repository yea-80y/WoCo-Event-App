import type { ApiResponse, RecoveryEnvelope, RecoveryGuardianIndex } from "@woco/shared";
import { authPost, apiBase } from "./client.js";

/**
 * Recovery-escrow API (PASSKEY_RECOVERY_PLAN §11.6).
 * Store at setup (authenticated as the Kernel); fetch at recovery WITHOUT auth
 * (the locked-out user has lost their signer — the envelope is ciphertext).
 */

/**
 * Persist the sealed envelope under the authenticated caller's Kernel topic.
 * `guardianAddress` (+ optional sub-ENS `label`) additionally writes the
 * convenience reverse-lookup so the backup wallet can auto-find this account at
 * recovery time. Both are untrusted hints — the escrow is the source of truth.
 */
export async function putRecoveryEnvelope(
  envelope: RecoveryEnvelope,
  opts?: { guardianAddress?: string; label?: string },
): Promise<ApiResponse<{ kernelAddress: string }>> {
  return authPost<{ kernelAddress: string }>("/api/recovery/escrow", {
    envelope,
    guardianAddress: opts?.guardianAddress,
    label: opts?.label,
  });
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

/** Fetch the sealed envelope for a Kernel address. Public — no auth headers. */
export async function fetchRecoveryEnvelope(
  kernelAddress: string,
): Promise<RecoveryEnvelope | null> {
  const resp = await fetch(`${apiBase}/api/recovery/escrow/${kernelAddress.toLowerCase()}`);
  const json = (await resp.json()) as ApiResponse<RecoveryEnvelope | null>;
  if (!json.ok) throw new Error(json.error || "Failed to load recovery envelope");
  return json.data ?? null;
}
