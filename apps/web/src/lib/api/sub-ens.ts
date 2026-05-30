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
