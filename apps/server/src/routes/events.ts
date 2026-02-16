import { Hono } from "hono";
import { streamText } from "hono/streaming";
import type { Hex0x, CreateEventRequest } from "@woco/shared";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { createEvent, getEvent, listEvents } from "../lib/event/service.js";

const events = new Hono<AppEnv>();

// GET /api/events - public listing
events.get("/", async (c) => {
  try {
    const entries = await listEvents();
    return c.json({ ok: true, data: entries });
  } catch (err) {
    console.error("[api] listEvents error:", err);
    return c.json({ ok: false, error: "Failed to list events" }, 500);
  }
});

// GET /api/events/:id - public detail
events.get("/:id", async (c) => {
  const eventId = c.req.param("id");
  try {
    const event = await getEvent(eventId);
    if (!event) return c.json({ ok: false, error: "Event not found" }, 404);
    return c.json({ ok: true, data: event });
  } catch (err) {
    console.error("[api] getEvent error:", err);
    return c.json({ ok: false, error: "Failed to get event" }, 500);
  }
});

// POST /api/events - authenticated, creates event + tickets on Swarm
// Streams NDJSON progress events, final line is the result
events.post("/", requireAuth, async (c) => {
  const body = c.get("body") as unknown as CreateEventRequest & {
    session: string;
    delegation: unknown;
  };

  const parentAddress = c.get("parentAddress") as string;

  // Validate required fields
  const { event: ev, series, signedTickets, image, creatorPodKey } = body;
  if (!ev?.title || !ev?.startDate || !ev?.endDate) {
    return c.json({ ok: false, error: "Missing event title or dates" }, 400);
  }
  if (!series?.length) {
    return c.json({ ok: false, error: "At least one ticket series required" }, 400);
  }
  if (!signedTickets || !creatorPodKey) {
    return c.json({ ok: false, error: "Missing signed tickets or creator key" }, 400);
  }
  if (!image) {
    return c.json({ ok: false, error: "Missing event image" }, 400);
  }

  // Decode base64 image
  let imageData: Uint8Array;
  try {
    const raw = image.includes(",") ? image.split(",")[1] : image;
    imageData = Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0));
  } catch {
    return c.json({ ok: false, error: "Invalid image data" }, 400);
  }

  // Flatten signedTickets to serialized strings
  const serializedTickets: Record<string, string[]> = {};
  for (const [seriesId, tickets] of Object.entries(signedTickets)) {
    serializedTickets[seriesId] = tickets.map((t) => JSON.stringify(t));
  }

  const eventId = crypto.randomUUID();

  return streamText(c, async (stream) => {
    try {
      const result = await createEvent({
        eventId,
        title: ev.title,
        description: ev.description || "",
        startDate: ev.startDate,
        endDate: ev.endDate,
        location: ev.location || "",
        creatorAddress: parentAddress.toLowerCase() as Hex0x,
        creatorPodKey,
        imageData,
        series: series.map((s) => ({
          seriesId: s.seriesId,
          name: s.name,
          description: s.description || "",
          totalSupply: s.totalSupply,
        })),
        signedTickets: serializedTickets,
        onProgress: (p) => {
          stream.writeln(JSON.stringify(p));
        },
      });

      stream.writeln(JSON.stringify({
        type: "done",
        ok: true,
        data: { eventId: result.eventId },
      }));
    } catch (err) {
      console.error("[api] createEvent error:", err);
      const message = err instanceof Error ? err.message : "Failed to create event";
      stream.writeln(JSON.stringify({ type: "error", ok: false, error: message }));
    }
  });
});

export { events };
