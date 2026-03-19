import { authPost, get } from "./client.js";

export interface DomainEntry {
  hostname: string;
  eventId: string;
  feedManifestHash: string;
  contentHash: string;
  ownerAddress: string;
  verified: boolean;
  createdAt: string;
  verifiedAt?: string;
  cnameTarget?: string;
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

export async function getMyDomains(): Promise<DomainEntry[]> {
  const resp = await authPost<DomainEntry[]>("/api/domains/mine", {});
  return resp.data ?? [];
}

export async function getEventDomains(eventId: string): Promise<DomainEntry[]> {
  const resp = await get<DomainEntry[]>(`/api/domains/event/${eventId}`);
  return resp.data ?? [];
}

export async function removeDomain(hostname: string): Promise<void> {
  const resp = await authPost<void>("/api/domains/remove", { hostname });
  if (!resp.ok) throw new Error(resp.error || "Failed to remove domain");
}
