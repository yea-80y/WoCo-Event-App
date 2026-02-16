import type {
  EventFeed,
  EventDirectoryEntry,
  CreateEventRequest,
  CreateEventResponse,
  ClaimTicketResponse,
  SeriesClaimStatus,
  UserCollection,
  ClaimedTicket,
} from "@woco/shared";
import { authPost, authGet, get } from "./client.js";

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
 */
export async function createEventStreaming(
  req: Omit<CreateEventRequest, "session" | "delegation">,
  onProgress?: (p: PublishProgress) => void,
): Promise<CreateEventResponse> {
  // We need the auth headers, so build the request manually
  const { auth } = await import("../auth/auth-store.svelte.js");
  const signed = await auth.signRequest(JSON.stringify(req));
  if (!signed) throw new Error("Not authenticated");

  const resp = await fetch("/api/events", {
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

export async function getEvent(eventId: string): Promise<EventFeed | null> {
  const resp = await get<EventFeed>(`/api/events/${eventId}`);
  return resp.data ?? null;
}

export async function claimTicket(
  eventId: string,
  seriesId: string,
  walletAddress: string,
): Promise<ClaimTicketResponse> {
  // No auth needed — just POST with wallet address
  const resp = await fetch(`/api/events/${eventId}/series/${seriesId}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "wallet", walletAddress }),
  });
  const json = await resp.json();
  return {
    ok: json.ok,
    ticket: json.ticket ?? json.data?.ticket,
    edition: json.edition ?? json.data?.edition,
    error: json.error,
  };
}

export async function getClaimStatus(
  eventId: string,
  seriesId: string,
  userAddress?: string,
): Promise<SeriesClaimStatus | null> {
  const query = userAddress ? `?address=${userAddress}` : "";
  const resp = await get<SeriesClaimStatus>(
    `/api/events/${eventId}/series/${seriesId}/claim-status${query}`,
  );
  return resp.data ?? null;
}

// ---------------------------------------------------------------------------
// Collection (Passport)
// ---------------------------------------------------------------------------

export async function getMyCollection(): Promise<UserCollection> {
  const resp = await authGet<UserCollection>("/api/collection/me");
  return resp.data ?? { v: 1, entries: [], updatedAt: "" };
}

export async function getTicketDetail(ref: string): Promise<ClaimedTicket | null> {
  const resp = await authGet<ClaimedTicket>(`/api/collection/me/ticket/${ref}`);
  return resp.data ?? null;
}
