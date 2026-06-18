import type { ApiResponse, RecoveryEnvelope } from "@woco/shared";
import { authPost, apiBase } from "./client.js";

/**
 * Recovery-escrow API (PASSKEY_RECOVERY_PLAN §11.6).
 * Store at setup (authenticated as the Kernel); fetch at recovery WITHOUT auth
 * (the locked-out user has lost their signer — the envelope is ciphertext).
 */

/** Persist the sealed envelope under the authenticated caller's Kernel topic. */
export async function putRecoveryEnvelope(
  envelope: RecoveryEnvelope,
): Promise<ApiResponse<{ kernelAddress: string }>> {
  return authPost<{ kernelAddress: string }>("/api/recovery/escrow", { envelope });
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
