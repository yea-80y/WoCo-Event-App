import type {
  EventFeed,
  EventDirectoryEntry,
  CreateEventRequest,
  CreateEventResponse,
  ClaimTicketResponse,
  SeriesClaimStatus,
  UserCollection,
  ClaimedTicket,
  SealedBox,
  OrderEntry,
} from "@woco/shared";
export type { OrderEntry };
import { authPost, authGet, get, apiBase } from "./client.js";

export interface PublishProgress {
  type: "progress";
  phase: string;
  current: number;
  total: number;
  message: string;
}

/**
 * Create event with streaming progress.
 * Reads NDJSON from the server and calls onProgress for each update.
 *
 * @param baseUrlOverride  Target a different API server (e.g. organiser's self-hosted backend).
 *                         When omitted, uses the default VITE_API_URL.
 */
export async function createEventStreaming(
  req: Omit<CreateEventRequest, "session" | "delegation">,
  onProgress?: (p: PublishProgress) => void,
  baseUrlOverride?: string,
): Promise<CreateEventResponse> {
  const base = baseUrlOverride ?? apiBase;

  // We need the auth headers, so build the request manually
  const { auth } = await import("../auth/auth-store.svelte.js");
  const signed = await auth.signRequest(JSON.stringify(req));
  if (!signed) throw new Error("Not authenticated");

  const resp = await fetch(`${base}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...req,
      session: signed.sessionAddress,
      delegation: signed.delegation,
    }),
  });

  if (!resp.ok && !resp.body) {
    const json = await resp.json();
    return { ok: false, error: json.error || "Request failed" };
  }

  // Read NDJSON stream
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: CreateEventResponse = { ok: false, error: "No response" };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop()!; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "progress") {
          onProgress?.(event as PublishProgress);
        } else if (event.type === "done") {
          result = { ok: true, eventId: event.data?.eventId };
        } else if (event.type === "error") {
          result = { ok: false, error: event.error };
        }
      } catch {
        // Skip unparseable lines
      }
    }
  }

  // Process any remaining buffer
  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer);
      if (event.type === "done") {
        result = { ok: true, eventId: event.data?.eventId };
      } else if (event.type === "error") {
        result = { ok: false, error: event.error };
      }
    } catch {
      // ignore
    }
  }

  return result;
}

/** @deprecated Use createEventStreaming for progress support */
export async function createEvent(
  req: Omit<CreateEventRequest, "session" | "delegation">,
): Promise<CreateEventResponse> {
  return createEventStreaming(req);
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
): Promise<ClaimTicketResponse> {
  // Wallet claims require session delegation (proves address ownership)
  const json = await authPost<ClaimTicketResponse>(
    `/api/events/${eventId}/series/${seriesId}/claim`,
    { mode: "wallet", walletAddress, encryptedOrder },
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
): Promise<ClaimTicketResponse> {
  const resp = await fetch(`${apiUrl ?? apiBase}/api/events/${eventId}/series/${seriesId}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "email", email, encryptedOrder }),
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
