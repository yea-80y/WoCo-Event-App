/**
 * Door check-in API.
 *
 * Organiser-authed (session delegation, mounted under /api/events):
 *   POST /:id/door-pass       issue/rotate the event's door pass
 *   POST /:id/checkin-roster  store AES-GCM roster ciphertext (key never sent)
 *   GET  /:id/checkin-status  live counts for the dashboard
 *
 * Door-pass-authed via X-Door-Pass header (mounted under /api/checkin):
 *   GET  /:eventId/pack       offline verification pack for scanner devices
 *   POST /:eventId/sync       merge a device's check-ins, return full set
 *
 * The pack contains only public/derivable data (on-chain slot owners, claim
 * ledger hashes) plus the roster ciphertext — a leaked pass token exposes no
 * attendee plaintext without the roster key from the pass URL fragment.
 */

import { Hono, type Context } from "hono";
import type {
  CheckinPack,
  CheckinSeries,
  CheckinSyncRequest,
  EncryptedRoster,
} from "@woco/shared";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { getEvent, getEventForOwner, getEventBySigner } from "../lib/event/service.js";
import { getOnChainEvent, getSlotData, getActiveChainId } from "../lib/chain/event-contract.js";
import {
  issueDoorPass,
  verifyDoorPass,
  storeRoster,
  readRoster,
  readCheckins,
  mergeCheckins,
} from "../lib/checkin/store.js";
import { mapWithConcurrency, SLOT_READ_CONCURRENCY } from "../lib/util/concurrency.js";

const MAX_ROSTER_CIPHERTEXT = 4 * 1024 * 1024;
const MAX_SYNC_RECORDS = 5000;

// ---------------------------------------------------------------------------
// Organiser endpoints (session auth) — mounted under /api/events
// ---------------------------------------------------------------------------

const checkinOrganiser = new Hono<AppEnv>();

async function loadOwnedEvent(c: Context<AppEnv>, eventId: string) {
  const parentAddress = c.get("parentAddress");
  const event = await getEventForOwner(eventId, parentAddress).catch(() => null);
  if (!event) return { error: c.json({ ok: false, error: "Event not found" }, 404 as const) };
  if (event.creatorAddress.toLowerCase() !== parentAddress.toLowerCase()) {
    return { error: c.json({ ok: false, error: "Only the event organiser can manage check-in" }, 403 as const) };
  }
  return { event };
}

checkinOrganiser.post("/:id/door-pass", requireAuth, async (c) => {
  const { event, error } = await loadOwnedEvent(c, c.req.param("id"));
  if (error) return error;

  // Pass outlives the event end by 24h; fall back to a week for open-ended events.
  const endMs = Date.parse(event.endDate ?? "");
  const exp = Math.floor(
    (Number.isFinite(endMs) ? Math.max(endMs, Date.now()) + 24 * 3600_000 : Date.now() + 7 * 24 * 3600_000) / 1000,
  );

  try {
    // Stamp the content-feed signer into the pass record — the organiser is
    // authenticated here, so this is the last point where an unlisted event's
    // signer can be resolved from trusted state. /pack has no parent address.
    const token = issueDoorPass(event.eventId, exp, event.creatorFeedSigner);
    return c.json({ ok: true, data: { token, exp } });
  } catch (err) {
    console.error("[checkin] door-pass issue failed:", err);
    return c.json({ ok: false, error: "Door pass signing is not configured on this server" }, 500);
  }
});

checkinOrganiser.post("/:id/checkin-roster", requireAuth, async (c) => {
  const { event, error } = await loadOwnedEvent(c, c.req.param("id"));
  if (error) return error;

  const body = c.get("body") as Partial<EncryptedRoster> | undefined;
  if (!body || typeof body.iv !== "string" || typeof body.ciphertext !== "string") {
    return c.json({ ok: false, error: "Expected { iv, ciphertext }" }, 400);
  }
  if (body.ciphertext.length > MAX_ROSTER_CIPHERTEXT || body.iv.length > 64) {
    return c.json({ ok: false, error: "Roster too large" }, 413);
  }

  storeRoster(event.eventId, {
    iv: body.iv,
    ciphertext: body.ciphertext,
    updatedAt: new Date().toISOString(),
  });
  return c.json({ ok: true });
});

checkinOrganiser.get("/:id/checkin-status", requireAuth, async (c) => {
  const { event, error } = await loadOwnedEvent(c, c.req.param("id"));
  if (error) return error;

  const checkins = readCheckins(event.eventId);
  const uniqueTickets = new Set(checkins.map((r) => `${r.seriesId} ${r.edition}`));
  const bySeries: Record<string, number> = {};
  for (const key of uniqueTickets) {
    const seriesId = key.slice(0, key.lastIndexOf(" "));
    bySeries[seriesId] = (bySeries[seriesId] ?? 0) + 1;
  }
  return c.json({
    ok: true,
    data: { checkedIn: uniqueTickets.size, bySeries, lastCheckinAt: checkins.at(-1)?.at ?? null },
  });
});

// ---------------------------------------------------------------------------
// Scanner endpoints (door-pass auth) — mounted under /api/checkin
// ---------------------------------------------------------------------------

const checkin = new Hono<AppEnv>();

/** Verify X-Door-Pass and confirm it was issued for the URL's event. */
function authorisePass(c: Context<AppEnv>): { ok: true; signer?: string } | { ok: false; resp: Response } {
  const token = c.req.header("X-Door-Pass");
  if (!token) {
    return { ok: false, resp: c.json({ ok: false, error: "Missing door pass" }, 401) };
  }
  const verdict = verifyDoorPass(token);
  if (!verdict.ok) {
    const message =
      verdict.reason === "revoked" ? "Door pass revoked — ask the organiser for a new one"
      : verdict.reason === "expired" ? "Door pass expired"
      : "Invalid door pass";
    return { ok: false, resp: c.json({ ok: false, error: message, reason: verdict.reason }, 401) };
  }
  if (verdict.eventId !== c.req.param("eventId")) {
    return { ok: false, resp: c.json({ ok: false, error: "Door pass is for a different event" }, 403) };
  }
  return { ok: true, ...(verdict.signer ? { signer: verdict.signer } : {}) };
}

checkin.get("/:eventId/pack", async (c) => {
  const auth = authorisePass(c);
  if (!auth.ok) return auth.resp;

  const eventId = c.req.param("eventId");
  try {
    // An unlisted (skipAutoList) client-signed event is in no global directory, so
    // getEvent() cannot resolve it and the scanner would 404 at the door. The pass
    // carries the signer we stamped at issue time — trusted, HMAC-authenticated,
    // and not client input. Passes issued before this fall through to getEvent().
    const event = (auth.signer ? await getEventBySigner(eventId, auth.signer) : null)
      ?? await getEvent(eventId);
    if (!event) return c.json({ ok: false, error: "Event not found" }, 404);

    const chainId = getActiveChainId();
    const series: CheckinSeries[] = [];

    for (const s of event.series) {
      const entry: CheckinSeries = {
        seriesId: s.seriesId,
        name: s.name,
        totalSupply: s.totalSupply,
      };

      // Slot owners come from the contract, which is the only ticket ledger. A
      // series that never finished registering has no slots, so it contributes an
      // empty entry rather than falling back to a Swarm feed no longer written.
      if (s.swarmManifestRef && s.onChainEventId) {
        entry.onChainEventId = s.onChainEventId as CheckinSeries["onChainEventId"];
        const onChain = await getOnChainEvent(s.onChainEventId, chainId).catch(() => null);
        const slotCount = onChain ? Number(onChain.nextSlot) : 0;
        const owners = await mapWithConcurrency(
          Array.from({ length: slotCount }, (_, slot) => slot),
          SLOT_READ_CONCURRENCY,
          async (slot) => {
            const data = await getSlotData(s.onChainEventId!, slot, chainId).catch(() => null);
            return data?.owner?.toLowerCase() ?? "";
          },
        );
        entry.slotOwners = owners;
      }
      series.push(entry);
    }

    const pack: CheckinPack = {
      v: 1,
      eventId,
      eventTitle: event.title,
      eventDate: event.startDate,
      series,
      roster: readRoster(eventId) ?? undefined,
      checkins: readCheckins(eventId),
      generatedAt: new Date().toISOString(),
    };
    return c.json({ ok: true, data: pack });
  } catch (err) {
    console.error("[checkin] pack build failed:", err);
    return c.json({ ok: false, error: "Failed to build check-in pack" }, 500);
  }
});

checkin.post("/:eventId/sync", async (c) => {
  const auth = authorisePass(c);
  if (!auth.ok) return auth.resp;

  const body = (await c.req.json().catch(() => null)) as CheckinSyncRequest | null;
  if (!body || !Array.isArray(body.checkins)) {
    return c.json({ ok: false, error: "Expected { deviceId, checkins }" }, 400);
  }
  if (body.checkins.length > MAX_SYNC_RECORDS) {
    return c.json({ ok: false, error: "Too many records in one sync" }, 413);
  }

  const result = mergeCheckins(c.req.param("eventId"), body.checkins);
  return c.json({ ok: true, data: result });
});

export { checkin, checkinOrganiser };
