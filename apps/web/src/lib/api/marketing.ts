/**
 * Marketing audience API — the sealed contact list + broadcasts + sending
 * domain. Plaintext contact data exists only in the organiser's browser; the
 * `emails` arrays sent here are hashed-and-discarded server-side.
 */

import { authPost, authGet, authDelete } from "./client.js";
import { apiError } from "./errors.js";
import type {
  SealedBox,
  MarketingListMeta,
  MarketingListResponse,
  MarketingCheckResult,
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

/**
 * Below the server's MARKETING_MAX_LIST_EMAILS ceiling — a single oversized
 * request is rejected wholesale, which surfaced to importers as a bare
 * "Validation failed" on any list past 20k.
 */
const CHECK_BATCH_SIZE = 5_000;

export async function checkMarketingEmails(emails: string[]): Promise<MarketingCheckResult> {
  const suppressed: string[] = [];
  const alreadyInList: string[] = [];
  const consented: string[] = [];

  for (let i = 0; i < emails.length; i += CHECK_BATCH_SIZE) {
    const batch = emails.slice(i, i + CHECK_BATCH_SIZE);
    const resp = await authPost<MarketingCheckResult>("/api/marketing/check", { emails: batch });
    if (!resp.data) throw new Error(resp.error || "Check failed");
    suppressed.push(...resp.data.suppressed);
    alreadyInList.push(...resp.data.alreadyInList);
    consented.push(...(resp.data.consented ?? []));
  }

  return { suppressed, alreadyInList, consented };
}

export async function suppressContacts(emails: string[]): Promise<void> {
  const resp = await authPost<{ suppressed: number }>("/api/marketing/suppress", { emails });
  if (!resp.ok) throw new Error(resp.error || "Suppress failed");
}

// Broadcasts moved to the background queue — see `broadcasts.ts`. The inline
// endpoint this file used to call now returns 410: a send that takes half an
// hour cannot live inside an HTTP request, whatever the send rate.

/** Send the draft to one inbox (usually the organiser's own) before the real
 *  broadcast. The server prefixes the subject with "[Test]". */
export async function sendMarketingTest(
  fromName: string,
  subject: string,
  htmlBody: string,
  email: string,
): Promise<{ sent: number; suppressed: number; failed: number; errors?: string[] }> {
  const resp = await authPost<{ sent: number; suppressed: number; failed: number; errors?: string[] }>(
    "/api/marketing/broadcast/test",
    { fromName, subject, htmlBody, email },
  );
  if (!resp.data) throw apiError(resp, "Test send failed");
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
