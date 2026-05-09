import { Hono } from "hono";
import type { ClaimersFeed, OrderEntry, SealedBox } from "@woco/shared";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { getEvent } from "../lib/event/service.js";
import { readFeedPage, decodeJsonFeed } from "../lib/swarm/feeds.js";
import { downloadFromBytes } from "../lib/swarm/bytes.js";
import { topicClaimers } from "../lib/swarm/topics.js";
import { getOnChainEvent, getSlotData, getActiveChainId } from "../lib/chain/event-contract.js";

/** Maximum concurrent Swarm downloads when fetching v2 order blobs */
const V2_DOWNLOAD_CONCURRENCY = 8;

/**
 * Validate and convert a bytes32 on-chain orderRef to a Swarm Hex64 ref.
 * The contract stores "0x" + 64 hex chars. Returns null for zero refs or
 * anything that doesn't match the expected format.
 */
function orderRefToSwarmHex(bytes32: string): string | null {
  if (!bytes32 || typeof bytes32 !== "string") return null;
  // Strip 0x prefix
  const hex = bytes32.startsWith("0x") ? bytes32.slice(2) : bytes32;
  // Must be exactly 64 hex chars
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  // Reject zero ref (bytes32(0)) — slot has no order data
  if (/^0+$/.test(hex)) return null;
  return hex.toLowerCase();
}

const orders = new Hono<AppEnv>();

// GET /api/events/:id/orders — authenticated, organizer-only
orders.get("/:id/orders", requireAuth, async (c) => {
  const eventId = c.req.param("id");
  const parentAddress = c.get("parentAddress");

  try {
    // 1. Load event and verify ownership
    const event = await getEvent(eventId);
    if (!event) {
      return c.json({ ok: false, error: "Event not found" }, 404);
    }

    if (event.creatorAddress.toLowerCase() !== parentAddress.toLowerCase()) {
      return c.json({ ok: false, error: "Only the event organizer can view orders" }, 403);
    }

    // 2. Collect encrypted orders — v2 series read from chain, v1 from Swarm claimers feed
    const orderEntries: OrderEntry[] = [];
    const chainId = getActiveChainId();

    for (const series of event.series) {
      if (series.swarmManifestRef && series.onChainEventId) {
        // ── v2: source of truth is the on-chain slot registry ──────────────
        const onChainData = await getOnChainEvent(series.onChainEventId, chainId);
        if (!onChainData || onChainData.nextSlot === 0n) continue;

        const slotCount = Number(onChainData.nextSlot);

        // Read all slot data in parallel — these are public view calls
        const slotResults = await Promise.all(
          Array.from({ length: slotCount }, (_, slot) =>
            getSlotData(series.onChainEventId!, slot, chainId).catch((err) => {
              console.warn(`[orders/v2] getSlotData failed for slot ${slot}:`, err);
              return null;
            }),
          ),
        );

        // Download encrypted order blobs from Swarm with bounded concurrency.
        // Each blob is a NaCl SealedBox — only the organiser can decrypt it.
        // We fetch the ciphertext server-side and return it; decryption happens
        // exclusively in the client where the X25519 private key lives.
        const downloadSlot = async (slot: number): Promise<OrderEntry | null> => {
          const slotData = slotResults[slot];
          if (!slotData) return null;

          const swarmHex = orderRefToSwarmHex(slotData.orderRef);
          let encryptedOrder: SealedBox | undefined;

          if (swarmHex) {
            try {
              const json = await downloadFromBytes(swarmHex);
              encryptedOrder = JSON.parse(json) as SealedBox;
            } catch (err) {
              console.warn(`[orders/v2] Failed to download orderRef for slot ${slot}:`, err);
            }
          }

          return {
            seriesId: series.seriesId,
            seriesName: series.name,
            edition: slot + 1,
            // Burner address — unique per ticket, proves on-chain slot ownership.
            // The actual claimer identity is inside the encrypted order blob.
            claimerAddress: slotData.owner,
            claimedAt: "",   // not stored on-chain in v1; available inside encryptedOrder
            via: "stripe" as const,
            ...(encryptedOrder ? { encryptedOrder } : {}),
          };
        };

        // Batch downloads: V2_DOWNLOAD_CONCURRENCY at a time to avoid flooding the Bee node
        for (let i = 0; i < slotCount; i += V2_DOWNLOAD_CONCURRENCY) {
          const batch = Array.from(
            { length: Math.min(V2_DOWNLOAD_CONCURRENCY, slotCount - i) },
            (_, j) => downloadSlot(i + j),
          );
          const results = await Promise.all(batch);
          for (const entry of results) {
            if (entry) orderEntries.push(entry);
          }
        }
      } else {
        // ── v1: Swarm claimers feed ──────────────────────────────────────────
        const page = await readFeedPage(topicClaimers(series.seriesId));
        if (!page) continue;

        const feed = decodeJsonFeed<ClaimersFeed>(page);
        if (!feed?.claimers) continue;

        for (const claimer of feed.claimers) {
          let encryptedOrder: SealedBox | undefined;

          if (claimer.orderRef) {
            try {
              const json = await downloadFromBytes(claimer.orderRef);
              encryptedOrder = JSON.parse(json) as SealedBox;
            } catch (err) {
              console.error(`[orders] Failed to download order ref ${claimer.orderRef}:`, err);
            }
          }

          orderEntries.push({
            seriesId: series.seriesId,
            seriesName: series.name,
            edition: claimer.edition,
            claimerAddress: claimer.claimerAddress,
            claimedAt: claimer.claimedAt,
            ...(encryptedOrder ? { encryptedOrder } : {}),
            ...(claimer.via ? { via: claimer.via } : {}),
          });
        }
      }
    }

    return c.json({
      ok: true,
      data: {
        eventId,
        eventTitle: event.title,
        orders: orderEntries,
      },
    });
  } catch (err) {
    console.error("[api] getOrders error:", err);
    const message = err instanceof Error ? err.message : "Failed to get orders";
    return c.json({ ok: false, error: message }, 500);
  }
});

// ---------------------------------------------------------------------------
// Webhook relay — forwards decrypted order data to organizer's endpoint
// ---------------------------------------------------------------------------

/** In-memory rate limiter: parentAddress → timestamps of recent calls */
const relayRateMap = new Map<string, number[]>();
const RELAY_RATE_LIMIT = 30;   // max requests
const RELAY_RATE_WINDOW = 60_000; // per 60 seconds

/** Returns true if the URL targets a private/loopback IP range */
function isPrivateUrl(url: URL): boolean {
  const host = url.hostname;
  // Loopback
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (host.startsWith("127.")) return true;
  // Private ranges
  if (host.startsWith("10.")) return true;
  if (host.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  // Link-local
  if (host.startsWith("169.254.")) return true;
  if (host === "0.0.0.0") return true;
  return false;
}

orders.post("/:id/webhook-relay", requireAuth, async (c) => {
  const eventId = c.req.param("id");
  const parentAddress = c.get("parentAddress");
  const body = c.get("body") as Record<string, unknown>;

  try {
    // 1. Verify organizer ownership
    const event = await getEvent(eventId);
    if (!event) {
      return c.json({ ok: false, error: "Event not found" }, 404);
    }
    if (event.creatorAddress.toLowerCase() !== parentAddress.toLowerCase()) {
      return c.json({ ok: false, error: "Only the event organizer can relay webhooks" }, 403);
    }

    // 2. Validate webhook URL
    const webhookUrl = body.webhookUrl as string;
    if (!webhookUrl || typeof webhookUrl !== "string") {
      return c.json({ ok: false, error: "Missing webhookUrl" }, 400);
    }

    let parsed: URL;
    try {
      parsed = new URL(webhookUrl);
    } catch {
      return c.json({ ok: false, error: "Invalid webhookUrl" }, 400);
    }

    if (parsed.protocol !== "https:") {
      return c.json({ ok: false, error: "Only HTTPS URLs are allowed" }, 400);
    }

    if (isPrivateUrl(parsed)) {
      return c.json({ ok: false, error: "Private/loopback addresses are not allowed" }, 400);
    }

    // 3. Validate payload size
    const payload = body.payload;
    if (!payload || typeof payload !== "object") {
      return c.json({ ok: false, error: "Missing payload object" }, 400);
    }
    const payloadStr = JSON.stringify(payload);
    if (payloadStr.length > 65536) {
      return c.json({ ok: false, error: "Payload exceeds 64KB limit" }, 400);
    }

    // 4. Rate limiting
    const now = Date.now();
    const timestamps = relayRateMap.get(parentAddress) ?? [];
    const recent = timestamps.filter((t) => now - t < RELAY_RATE_WINDOW);
    if (recent.length >= RELAY_RATE_LIMIT) {
      return c.json({ ok: false, error: "Rate limit exceeded (30 req/min)" }, 429);
    }
    recent.push(now);
    relayRateMap.set(parentAddress, recent);

    // 5. Build outgoing headers
    const webhookHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (body.webhookHeaders && typeof body.webhookHeaders === "object") {
      for (const [k, v] of Object.entries(body.webhookHeaders as Record<string, string>)) {
        if (typeof k === "string" && typeof v === "string") {
          webhookHeaders[k] = v;
        }
      }
    }

    // 6. Forward request
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: webhookHeaders,
      body: payloadStr,
      signal: AbortSignal.timeout(10_000),
    });

    const respBody = await resp.text();
    const truncated = respBody.slice(0, 4096);

    console.log(
      `[webhook-relay] eventId=${eventId} target=${parsed.hostname} status=${resp.status}`,
    );

    return c.json({
      ok: true,
      data: { status: resp.status, body: truncated },
    });
  } catch (err) {
    console.error("[webhook-relay] error:", err);
    const message = err instanceof Error ? err.message : "Webhook relay failed";
    return c.json({ ok: false, error: message }, 502);
  }
});

export { orders };
