import { authPost } from "./client.js";

const BASE =
  (typeof window !== "undefined" && (window as unknown as { SITE_CONFIG?: { apiUrl?: string } }).SITE_CONFIG?.apiUrl) ||
  import.meta.env.VITE_API_URL ||
  "";

export interface SubEnsCheckResult {
  available: boolean;
  reason?: string;
}

export interface SubEnsClaimResult {
  label: string;
  ensName: string;
  txHash: string;
}

export async function checkSubEnsLabel(label: string) {
  const resp = await fetch(`${BASE}/api/sub-ens/check/${encodeURIComponent(label)}`);
  const json = await resp.json() as { ok: boolean; data?: SubEnsCheckResult; error?: string };
  return json;
}

export async function claimSubEnsLabel(opts: {
  label: string;
  description?: string;
  avatar?: string;
}) {
  return authPost<SubEnsClaimResult>("/api/sub-ens/claim", opts);
}

interface SubEnsPermitResponse {
  label: string;
  ensName: string;
  sig: string;
  expiry: number;
  chainId: number;
  registrarAddress: string;
}

/**
 * Passkey/Kernel path: fetch an EIP-712 permit from the server, then submit
 * `registerWithPermit` as a gasless userOp signed by the scoped ZeroDev session
 * key — the user pays no gas and the name is owned by their smart account.
 *
 * `kernelAddress` MUST come from `auth.ensureWocoSessionKey()` (it is the
 * permit's `owner` and the session-key owner). Falls back to the sponsor path
 * (`claimSubEnsLabel`) for non-passkey organisers.
 */
export async function claimSubEnsViaPermit(opts: {
  label: string;
  kernelAddress: string;
  description?: string;
  avatar?: string;
  swarmHash?: string;
}): Promise<{ ok: boolean; data?: SubEnsClaimResult; error?: string }> {
  const permit = await authPost<SubEnsPermitResponse>("/api/sub-ens/permit", {
    label: opts.label,
  });
  if (!permit.ok || !permit.data) {
    return { ok: false, error: permit.error ?? "permit request failed" };
  }

  const textKeys: string[] = [];
  const textValues: string[] = [];
  if (opts.description?.trim()) { textKeys.push("description"); textValues.push(opts.description.trim()); }
  if (opts.avatar?.trim())      { textKeys.push("avatar");      textValues.push(opts.avatar.trim()); }

  try {
    const { registerSubEnsViaPermit } = await import("../auth/kernel-account.js");
    const { txHash } = await registerSubEnsViaPermit({
      kernelAddress: opts.kernelAddress,
      registrarAddress: permit.data.registrarAddress,
      label: permit.data.label,
      expiry: permit.data.expiry,
      sig: permit.data.sig,
      swarmHash: opts.swarmHash,
      textKeys,
      textValues,
    });
    return { ok: true, data: { label: permit.data.label, ensName: permit.data.ensName, txHash } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "on-chain registration failed" };
  }
}
