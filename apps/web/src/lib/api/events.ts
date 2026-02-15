import type {
  EventFeed,
  EventDirectoryEntry,
  CreateEventRequest,
  CreateEventResponse,
  SignedTicket,
} from "@woco/shared";
import { authPost, get } from "./client.js";

export async function createEvent(
  req: Omit<CreateEventRequest, "session" | "delegation">,
): Promise<CreateEventResponse> {
  const resp = await authPost<{ eventId: string }>("/api/events", req as Record<string, unknown>);
  return { ok: resp.ok, eventId: resp.data?.eventId, error: resp.error };
}

export async function listEvents(): Promise<EventDirectoryEntry[]> {
  const resp = await get<EventDirectoryEntry[]>("/api/events");
  return resp.data ?? [];
}

export async function getEvent(eventId: string): Promise<EventFeed | null> {
  const resp = await get<EventFeed>(`/api/events/${eventId}`);
  return resp.data ?? null;
}
