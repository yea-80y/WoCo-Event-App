import { authPost, get } from "./client.js";

export interface DomainEntry {
  hostname: string;
  eventId?: string;
  siteId?: string;
  feedManifestHash: string;
  contentHash: string;
  ownerAddress: string;
  verified: boolean;
  createdAt: string;
  verifiedAt?: string;
  cnameTarget?: string;
  onCloudflare?: boolean;
  provider?: string;
  trialExpiresAt?: string;
  deactivated?: boolean;
}

export async function registerDomain(
  hostname: string,
  eventId: string,
  contentHash: string,
  feedManifestHash?: string,
): Promise<DomainEntry> {
  const resp = await authPost<DomainEntry>("/api/domains", {
    hostname,
    eventId,
    contentHash,
    feedManifestHash: feedManifestHash ?? "",
  });
  if (!resp.data) throw new Error(resp.error || "Failed to register domain");
  return resp.data;
}

export async function registerSiteDomain(
  hostname: string,
  siteId: string,
  contentHash: string,
  feedManifestHash?: string,
): Promise<DomainEntry> {
  const resp = await authPost<DomainEntry>("/api/domains", {
    hostname,
    siteId,
    contentHash,
    feedManifestHash: feedManifestHash ?? "",
  });
  if (!resp.data) throw new Error(resp.error || "Failed to register domain");
  return resp.data;
}

export async function verifyDomainDns(
  hostname: string,
): Promise<{ verified: boolean; error?: string }> {
  const resp = await authPost<{ verified: boolean; error?: string }>(
    "/api/domains/verify",
    { hostname },
  );
  if (!resp.data) throw new Error(resp.error || "Verification failed");
  return resp.data;
}

/**
 * Throws on failure rather than returning `[]`. An empty array is a real
 * answer ("you have no domains") and a failed read is not — collapsing the two
 * meant a rejected session or an offline phone showed as an organiser having
 * no connected domains (#291). Callers that genuinely do not care can catch.
 */
export async function getMyDomains(): Promise<DomainEntry[]> {
  const resp = await authPost<DomainEntry[]>("/api/domains/mine", {});
  if (!resp.ok || !resp.data) throw new Error(resp.error || "Could not load your domains");
  return resp.data;
}

export async function getEventDomains(eventId: string): Promise<DomainEntry[]> {
  const resp = await get<DomainEntry[]>(`/api/domains/event/${eventId}`);
  return resp.data ?? [];
}

export async function getSiteDomains(siteId: string): Promise<DomainEntry[]> {
  const resp = await get<DomainEntry[]>(`/api/domains/site/${siteId}`);
  return resp.data ?? [];
}

export async function removeDomain(hostname: string): Promise<void> {
  const resp = await authPost<void>("/api/domains/remove", { hostname });
  if (!resp.ok) throw new Error(resp.error || "Failed to remove domain");
}
