import type {
  EventFeed,
  EventDirectoryEntry,
  CreateEventV2Request,
  CreateEventResponse,
  ClaimTicketResponse,
  SeriesClaimStatus,
  UserCollection,
  ClaimedTicket,
  SealedBox,
  OrderEntry,
} from "@woco/shared";
export type { OrderEntry };
import { authPost, authGet, get, apiBase, buildAuthHeaders } from "./client.js";
import { eventContentTopic } from "@woco/shared";
import { writeContentFeed, type ContentFeedSigner } from "../swarm/content-feed.js";

export interface PublishProgress {
  type: "progress";
  phase: string;
  current: number;
  total: number;
  message: string;
}

/**
 * Create event with streaming progress (v2 — manifest-based).
 * Reads NDJSON from the server and calls onProgress for each update.
 *
 * @param baseUrlOverride  Target a different API server (e.g. organiser's self-hosted backend).
 * @param feedSigner  Phase B: when provided, the event becomes a CLIENT-OWNED feed —
 *   the server stamps `feedSigner.address` into the directory (discovery carrier) and
 *   skips the platform write, returning the assembled feed for the client to sign as a
 *   SOC here. Only valid against the default server (the SOC upload targets apiBase's
 *   postage batch), so callers MUST pass null when baseUrlOverride is set.
 */
export async function createEventStreaming(
  req: CreateEventV2Request,
  onProgress?: (p: PublishProgress) => void,
  baseUrlOverride?: string,
  feedSigner?: ContentFeedSigner | null,
): Promise<CreateEventResponse> {
  const base = baseUrlOverride ?? apiBase;
  // Stamp the signer address into the request so the server carries it into the
  // directory entry and returns the feed for SOC signing instead of platform-writing.
  if (feedSigner) {
    req = { ...req, creatorFeedSigner: feedSigner.address as `0x${string}` };
  }
  const bodyText = JSON.stringify(req);
  const path = "/api/events";
  const authHeaders = await buildAuthHeaders("POST", path, bodyText);

  const resp = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: bodyText,
  });

  if (!resp.ok) {
    try {
      const json = await resp.json();
      return { ok: false, error: json.error || "Request failed" };
    } catch {
      return { ok: false, error: `Request failed (${resp.status})` };
    }
  }

  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: CreateEventResponse = { ok: false, error: "No response" };
  // Phase B: the client-signed event feed the server hands back in `done`.
  let pendingFeed: EventFeed | null = null;

  const handleEvent = (ev: any) => {
    if (ev.type === "progress") onProgress?.(ev as PublishProgress);
    else if (ev.type === "done") {
      result = { ok: true, eventId: ev.data?.eventId };
      if (ev.data?.eventFeed) pendingFeed = ev.data.eventFeed as EventFeed;
    } else if (ev.type === "error") result = { ok: false, error: ev.error };
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) continue;
      try { handleEvent(JSON.parse(line)); } catch { /* skip unparseable lines */ }
    }
  }
  if (buffer.trim()) {
    try { handleEvent(JSON.parse(buffer)); } catch { /* ignore */ }
  }

  // Phase B: sign + upload the event detail feed as a client-owned SOC. The server
  // only stamped the directory carrier; the feed itself is unreadable until this
  // lands, so a failure here fails the publish (the organiser retries).
  if (result.ok && feedSigner && pendingFeed) {
    try {
      onProgress?.({ type: "progress", phase: "finalize", current: 0, total: 1, message: "Signing event feed..." });
      await writeContentFeed({
        signerPrivKey: feedSigner.privKey,
        topic: eventContentTopic((pendingFeed as EventFeed).eventId),
        data: pendingFeed,
      });
      onProgress?.({ type: "progress", phase: "finalize", current: 1, total: 1, message: "Event feed signed" });
    } catch (e) {
      return { ok: false, error: `Failed to sign event feed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  return result;
}

/** Fetch the organiser's current nonce on the active chain (used to predict on-chain eventId). */
export async function getOrganiserNonce(address: string): Promise<{
  nonce: bigint;
  chainId: number;
  contractAddress: string;
}> {
  const resp = await get<{ address: string; nonce: string; chainId: number; contractAddress: string }>(
    `/api/events/organiser-nonce/${address.toLowerCase()}`,
  );
  if (!resp.data) throw new Error("Failed to fetch organiser nonce");
  return {
    nonce: BigInt(resp.data.nonce),
    chainId: resp.data.chainId,
    contractAddress: resp.data.contractAddress,
  };
}

/**
 * Register a series on-chain via the server's sponsor wallet.
 * No EOA or wallet connection needed — works for passkey/Para/email organisers.
 */
export async function registerSeriesOnChain(
  eventId: string,
  seriesId: string,
): Promise<{ onChainEventId: string; txHash?: string }> {
  // The route returns onChainEventId/txHash at the TOP level (not under .data),
  // so read the raw envelope rather than ApiResponse<T>'s data field.
  const resp = (await authPost<unknown>(
    `/api/events/${eventId}/register-on-chain`,
    { seriesId },
  )) as { ok: boolean; error?: string; onChainEventId?: string; txHash?: string };
  if (!resp.ok || !resp.onChainEventId) {
    throw new Error(resp.error || "register-on-chain failed");
  }
  return { onChainEventId: resp.onChainEventId, txHash: resp.txHash };
}

/** Confirm on-chain registration for a series after the organiser's registerEvent tx. */
export async function confirmChainRegistration(
  eventId: string,
  seriesId: string,
  onChainEventId: string,
  chainId: number,
): Promise<{ ok: boolean; error?: string }> {
  return authPost(`/api/events/${eventId}/confirm-chain`, { seriesId, onChainEventId, chainId });
}

export async function listEvents(): Promise<EventDirectoryEntry[]> {
  const resp = await get<EventDirectoryEntry[]>("/api/events");
  return resp.data ?? [];
}

export async function getEvent(eventId: string, apiUrl?: string): Promise<EventFeed | null> {
  const resp = await get<EventFeed>(`/api/events/${eventId}`, apiUrl);
  return resp.data ?? null;
}

export async function claimTicket(
  eventId: string,
  seriesId: string,
  walletAddress: string,
  encryptedOrder?: SealedBox,
  apiUrl?: string,
  paymentProof?: import("@woco/shared").PaymentProof,
): Promise<ClaimTicketResponse> {
  // Wallet claims require session delegation (proves address ownership)
  const json = await authPost<ClaimTicketResponse>(
    `/api/events/${eventId}/series/${seriesId}/claim`,
    { mode: "wallet", walletAddress, encryptedOrder, ...(paymentProof ? { paymentProof } : {}) },
    apiUrl,
  );
  return {
    ok: json.ok,
    ticket: (json as any).ticket ?? json.data?.ticket,
    edition: (json as any).edition ?? json.data?.edition,
    approvalPending: (json as any).approvalPending,
    pendingId: (json as any).pendingId,
    error: json.error,
  };
}

export async function claimTicketByEmail(
  eventId: string,
  seriesId: string,
  email: string,
  encryptedOrder?: SealedBox,
  apiUrl?: string,
  paymentProof?: import("@woco/shared").PaymentProof,
): Promise<ClaimTicketResponse> {
  const resp = await fetch(`${apiUrl ?? apiBase}/api/events/${eventId}/series/${seriesId}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "email", email, encryptedOrder, ...(paymentProof ? { paymentProof } : {}) }),
  });
  const json = await resp.json();
  return {
    ok: json.ok,
    ticket: json.ticket ?? json.data?.ticket,
    edition: json.edition ?? json.data?.edition,
    approvalPending: json.approvalPending,
    pendingId: json.pendingId,
    error: json.error,
  };
}

export async function getClaimStatus(
  eventId: string,
  seriesId: string,
  userAddress?: string,
  userEmailHash?: string,
  apiUrl?: string,
): Promise<SeriesClaimStatus | null> {
  const params = new URLSearchParams();
  if (userAddress) params.set("address", userAddress);
  if (userEmailHash) params.set("emailHash", userEmailHash);
  const query = params.toString() ? `?${params}` : "";
  const resp = await get<SeriesClaimStatus>(
    `/api/events/${eventId}/series/${seriesId}/claim-status${query}`,
    apiUrl,
  );
  return resp.data ?? null;
}

// ---------------------------------------------------------------------------
// Collection (Passport)
// ---------------------------------------------------------------------------

export async function getMyCollection(): Promise<UserCollection> {
  const resp = await authGet<UserCollection>("/api/collection/me");
  if (!resp.ok) throw new Error(resp.error || "Failed to load collection");
  return resp.data ?? { v: 1, entries: [], updatedAt: "" };
}

export async function getTicketDetail(ref: string): Promise<ClaimedTicket | null> {
  const resp = await authGet<ClaimedTicket>(`/api/collection/me/ticket/${ref}`);
  return resp.data ?? null;
}

// ---------------------------------------------------------------------------
// Organizer Dashboard
// ---------------------------------------------------------------------------

export interface EventOrdersResponse {
  eventId: string;
  eventTitle: string;
  orders: OrderEntry[];
}

export async function getEventOrders(eventId: string): Promise<EventOrdersResponse> {
  const resp = await authGet<EventOrdersResponse>(`/api/events/${eventId}/orders`);
  if (!resp.data) throw new Error(resp.error || "Failed to load orders");
  return resp.data;
}

export interface WebhookRelayResponse {
  status: number;
  body: string;
}

export async function webhookRelay(
  eventId: string,
  webhookUrl: string,
  webhookHeaders: Record<string, string>,
  payload: Record<string, unknown>,
): Promise<WebhookRelayResponse> {
  const resp = await authPost<WebhookRelayResponse>(
    `/api/events/${eventId}/webhook-relay`,
    { webhookUrl, webhookHeaders, payload },
  );
  if (!resp.data) throw new Error(resp.error || "Webhook relay failed");
  return resp.data;
}

// ---------------------------------------------------------------------------
// Email broadcast
// ---------------------------------------------------------------------------

export interface BroadcastResponse {
  sentCount: number;
  failedCount: number;
  totalRecipients: number;
  errors?: string[];
}

export async function sendBroadcast(
  eventId: string,
  subject: string,
  htmlBody: string,
  recipients: Array<{ email: string; name?: string }>,
): Promise<BroadcastResponse> {
  const resp = await authPost<BroadcastResponse>(
    `/api/events/${eventId}/broadcast`,
    { subject, htmlBody, recipients },
  );
  if (!resp.data) throw new Error(resp.error || "Broadcast failed");
  return resp.data;
}

// ---------------------------------------------------------------------------
// Organizer approval flow
// ---------------------------------------------------------------------------

export interface PendingClaimEntry {
  pendingId: string;
  seriesId: string;
  seriesName: string;
  claimerKey: string;
  requestedAt: string;
  encryptedOrder?: SealedBox;
}

export async function getPendingClaims(eventId: string): Promise<PendingClaimEntry[]> {
  const resp = await authGet<{ eventId: string; pendingClaims: PendingClaimEntry[] }>(
    `/api/events/${eventId}/pending-claims`,
  );
  return resp.data?.pendingClaims ?? [];
}

export async function approvePendingClaim(
  eventId: string,
  seriesId: string,
  pendingId: string,
): Promise<{ ok: boolean; error?: string }> {
  return authPost(
    `/api/events/${eventId}/series/${seriesId}/pending-claims/${pendingId}/approve`,
    {},
  );
}

export async function rejectPendingClaim(
  eventId: string,
  seriesId: string,
  pendingId: string,
  reason?: string,
): Promise<{ ok: boolean; error?: string }> {
  return authPost(
    `/api/events/${eventId}/series/${seriesId}/pending-claims/${pendingId}/reject`,
    { reason },
  );
}
