/**
 * Marketing audience API — the sealed contact list + broadcasts + sending
 * domain. Plaintext contact data exists only in the organiser's browser; the
 * `emails` arrays sent here are hashed-and-discarded server-side.
 */

import { authPost, authGet, authDelete } from "./client.js";
import type {
  SealedBox,
  MarketingListMeta,
  MarketingListResponse,
  MarketingCheckResult,
  MarketingBroadcastResult,
  SendingDomainInfo,
} from "@woco/shared";

export async function uploadMarketingList(
  sealedList: SealedBox,
  emails: string[],
): Promise<MarketingListMeta> {
  const resp = await authPost<MarketingListMeta>("/api/marketing/list", {
    sealedList: sealedList as unknown as Record<string, unknown>,
    emails,
  });
  if (!resp.data) throw new Error(resp.error || "List upload failed");
  return resp.data;
}

export async function getMarketingList(): Promise<MarketingListResponse | null> {
  const resp = await authGet<MarketingListResponse | null>("/api/marketing/list");
  if (!resp.ok) throw new Error(resp.error || "List fetch failed");
  return resp.data ?? null;
}

export async function checkMarketingEmails(emails: string[]): Promise<MarketingCheckResult> {
  const resp = await authPost<MarketingCheckResult>("/api/marketing/check", { emails });
  if (!resp.data) throw new Error(resp.error || "Check failed");
  return resp.data;
}

export async function suppressContacts(emails: string[]): Promise<void> {
  const resp = await authPost<{ suppressed: number }>("/api/marketing/suppress", { emails });
  if (!resp.ok) throw new Error(resp.error || "Suppress failed");
}

export async function sendMarketingBroadcast(
  fromName: string,
  subject: string,
  htmlBody: string,
  recipients: Array<{ email: string; name?: string }>,
): Promise<MarketingBroadcastResult> {
  const resp = await authPost<MarketingBroadcastResult>("/api/marketing/broadcast", {
    fromName,
    subject,
    htmlBody,
    recipients,
  });
  if (!resp.data) throw new Error(resp.error || "Broadcast failed");
  return resp.data;
}

// ── Sending domain ──────────────────────────────────────────────────────────

export async function getSendingDomain(): Promise<SendingDomainInfo | null> {
  const resp = await authGet<SendingDomainInfo | null>("/api/marketing/domain");
  if (!resp.ok) throw new Error(resp.error || "Domain fetch failed");
  return resp.data ?? null;
}

export async function createSendingDomain(
  domain: string,
  fromLocalPart?: string,
): Promise<SendingDomainInfo> {
  const resp = await authPost<SendingDomainInfo>("/api/marketing/domain", {
    domain,
    ...(fromLocalPart ? { fromLocalPart } : {}),
  });
  if (!resp.data) throw new Error(resp.error || "Domain connect failed");
  return resp.data;
}

export async function verifySendingDomain(): Promise<SendingDomainInfo> {
  const resp = await authPost<SendingDomainInfo>("/api/marketing/domain/verify", {});
  if (!resp.data) throw new Error(resp.error || "Domain verify failed");
  return resp.data;
}

export async function removeSendingDomain(): Promise<void> {
  const resp = await authDelete<{ removed: boolean }>("/api/marketing/domain");
  if (!resp.ok) throw new Error(resp.error || "Domain removal failed");
}
