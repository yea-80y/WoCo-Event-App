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
 *   POST /:eventId/claim      admit one ticket - first claim anywhere wins (#641)
 *   POST /:eventId/sync       merge a device's check-ins, return full set
 *
 * Every scanner request also carries X-Scanner-Device. A "single" pass is bound
 * to the first device that loads its pack and refused on any other, because that
 * one device is allowed to admit offline; a "several" pass admits only through
 * /claim.
 *
 * The pack contains only public/derivable data (on-chain slot owners, claim
 * ledger hashes) plus the roster ciphertext — a leaked pass token exposes no
 * attendee plaintext without the roster key from the pass URL fragment.
 */

import { Hono, type Context } from "hono";
import {
  SCANNER_DEVICE_HEADER,
  type CheckinClaimRequest,
  type CheckinClaimResponse,
  type CheckinPack,
  type CheckinRecord,
  type CheckinSeries,
  type CheckinSyncRequest,
  type DoorMode,
  type EncryptedRoster,
} from "@woco/shared";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { getEvent, getEventForOwner, getEventBySigner } from "../lib/event/service.js";
import { getOnChainEventAt, getSlotDataAt } from "../lib/chain/event-contract.js";
import { registrationContractFor } from "../lib/event/onchain-registry.js";
import { contractKey } from "../lib/chain/event-contract.js";
import { voidedSlots } from "../lib/stripe/ticket-sales.js";
import {
  issueDoorPass,
  verifyDoorPass,
  storeRoster,
  readRoster,
  readCheckins,
  mergeCheckins,
  claimCheckin,
  bindSinglePassDevice,
} from "../lib/checkin/store.js";
import { mapWithConcurrency, SLOT_READ_CONCURRENCY } from "../lib/util/concurrency.js";

const MAX_ROSTER_CIPHERTEXT = 4 * 1024 * 1024;
const MAX_SYNC_RECORDS = 5000;

// ---------------------------------------------------------------------------
// Organiser endpoints (session auth) — mounted under /api/events
// ---------------------------------------------------------------------------

const checkinOrganiser = new Hono<AppEnv>();

/**
 * Resolve an event this caller owns, and hand back the TRUSTED id to key stores
 * with (#389).
 *
 * `eventId` here is the route parameter — the value ownership was actually
 * resolved against. `event.eventId` is a field in a feed BODY, and for a Phase B
 * event that body is a client-signed SOC the server never writes; `readEventFeedSoc`
 * (`lib/event/service.ts`) returns it as-is and does not reconcile the id inside
 * it with the topic it was read from. The two can therefore disagree, and an
 * organiser controls both the feed they sign and the `creatorAddress` inside it.
 *
 * So `eventId` is returned explicitly rather than left for each route to pick the
 * right one of two similar-looking values. Three routes here previously keyed
 * their stores on the feed's copy — one of them a WRITE — which let a crafted
 * feed reach another event's records. Same class as #387 and #377.
 *
 * Use the returned `eventId` for anything that identifies the event to a store.
 * Fields like `endDate` and `creatorFeedSigner` come from the feed by necessity
 * and are self-consistent with it.
 */
async function loadOwnedEvent(c: Context<AppEnv>, eventId: string) {
  const parentAddress = c.get("parentAddress");
  const event = await getEventForOwner(eventId, parentAddress).catch(() => null);
  if (!event) return { error: c.json({ ok: false, error: "Event not found" }, 404 as const) };
  if (event.creatorAddress.toLowerCase() !== parentAddress.toLowerCase()) {
    return { error: c.json({ ok: false, error: "Only the event organiser can manage check-in" }, 403 as const) };
  }
  return { event, eventId };
}

checkinOrganiser.post("/:id/door-pass", requireAuth, async (c) => {
  const { event, eventId, error } = await loadOwnedEvent(c, c.req.param("id"));
  if (error) return error;

  // Pass outlives the event end by 24h; fall back to a week for open-ended events.
  const endMs = Date.parse(event.endDate ?? "");
  const exp = Math.floor(
    (Number.isFinite(endMs) ? Math.max(endMs, Date.now()) + 24 * 3600_000 : Date.now() + 7 * 24 * 3600_000) / 1000,
  );

  // Anything but an explicit "single" is "several": the mode that cannot admit
  // a ticket twice is the default, including for clients that send no mode.
  const body = c.get("body") as { mode?: unknown } | undefined;
  const mode: DoorMode = body?.mode === "single" ? "single" : "several";

  try {
    // Stamp the content-feed signer into the pass record — the organiser is
    // authenticated here, so this is the last point where an unlisted event's
    // signer can be resolved from trusted state. /pack has no parent address.
    const token = issueDoorPass(eventId, exp, event.creatorFeedSigner, mode);
    return c.json({ ok: true, data: { token, exp, mode } });
  } catch (err) {
    console.error("[checkin] door-pass issue failed:", err);
    return c.json({ ok: false, error: "Door pass signing is not configured on this server" }, 500);
  }
});

checkinOrganiser.post("/:id/checkin-roster", requireAuth, async (c) => {
  const { eventId, error } = await loadOwnedEvent(c, c.req.param("id"));
  if (error) return error;

  const body = c.get("body") as Partial<EncryptedRoster> | undefined;
  if (!body || typeof body.iv !== "string" || typeof body.ciphertext !== "string") {
    return c.json({ ok: false, error: "Expected { iv, ciphertext }" }, 400);
  }
  if (body.ciphertext.length > MAX_ROSTER_CIPHERTEXT || body.iv.length > 64) {
    return c.json({ ok: false, error: "Roster too large" }, 413);
  }

  storeRoster(eventId, {
    iv: body.iv,
    ciphertext: body.ciphertext,
    updatedAt: new Date().toISOString(),
  });
  return c.json({ ok: true });
});

checkinOrganiser.get("/:id/checkin-status", requireAuth, async (c) => {
  const { eventId, error } = await loadOwnedEvent(c, c.req.param("id"));
  if (error) return error;

  const checkins = readCheckins(eventId);
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

type AuthorisedPass = { ok: true; signer?: string; mode: DoorMode; device?: string };

/** Verify X-Door-Pass and confirm it was issued for the URL's event. */
function authorisePass(c: Context<AppEnv>): AuthorisedPass | { ok: false; resp: Response } {
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
  return {
    ok: true,
    mode: verdict.mode,
    ...(verdict.signer ? { signer: verdict.signer } : {}),
    ...(verdict.device ? { device: verdict.device } : {}),
  };
}

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function deviceFrom(c: Context<AppEnv>, fallback?: unknown): string | null {
  const raw = c.req.header(SCANNER_DEVICE_HEADER) ?? (typeof fallback === "string" ? fallback : undefined);
  return raw && DEVICE_ID_RE.test(raw) ? raw : null;
}

const WRONG_DEVICE =
  "This door pass is for one scanner and is already in use on another phone. " +
  "To use more phones, ask the organiser to regenerate it for several scanners.";

/**
 * For a "single" pass, refuse any device but the bound one. `bind` is true only
 * on /pack, the one request a device must make before it can scan: that is where
 * the first device claims the pass.
 */
function checkDevice(c: Context<AppEnv>, auth: AuthorisedPass, device: string | null, bind: boolean): Response | null {
  if (auth.mode !== "single") return null;
  if (!device) {
    return c.json({ ok: false, error: "This scanner needs updating - reload the page and try again" }, 400);
  }
  const allowed = bind ? bindSinglePassDevice(c.req.param("eventId"), device) : auth.device === device;
  return allowed ? null : c.json({ ok: false, error: WRONG_DEVICE, reason: "wrong-device" }, 409);
}

checkin.get("/:eventId/pack", async (c) => {
  const auth = authorisePass(c);
  if (!auth.ok) return auth.resp;

  const eventId = c.req.param("eventId");
  // Required in EVERY mode, not only "single": a scanner bundle from before #641
  // sends no device id and ignores the door mode, admitting offline on its own
  // set. Refusing it a pack is what keeps it from provisioning onto a shared door.
  const device = deviceFrom(c);
  if (!device) {
    return c.json({ ok: false, error: "This scanner needs updating - reload the page and try again" }, 400);
  }
  let refused: Response | null;
  try {
    refused = checkDevice(c, auth, device, true);
  } catch (err) {
    console.error("[checkin] single-scanner binding could not be saved:", err);
    return c.json({ ok: false, error: "Could not register this scanner - try again" }, 503);
  }
  if (refused) return refused;
  try {
    // An unlisted (skipAutoList) client-signed event is in no global directory, so
    // getEvent() cannot resolve it and the scanner would 404 at the door. The pass
    // carries the signer we stamped at issue time — trusted, HMAC-authenticated,
    // and not client input. Passes issued before this fall through to getEvent().
    const event = (auth.signer ? await getEventBySigner(eventId, auth.signer) : null)
      ?? await getEvent(eventId);
    if (!event) return c.json({ ok: false, error: "Event not found" }, 404);

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
        // Owners are read on the contract the registration lives on (#563), so
        // a ticket on an older contract still verifies at the door after a
        // cutover. None resolvable reads as no slots: the door refuses.
        const contract = registrationContractFor(eventId, s.seriesId);
        const onChainEventId = s.onChainEventId;
        const onChain = contract
          ? await getOnChainEventAt(contract, onChainEventId).catch(() => null)
          : null;
        const slotCount = contract && onChain ? Number(onChain.nextSlot) : 0;
        const owners = await mapWithConcurrency(
          Array.from({ length: slotCount }, (_, slot) => slot),
          SLOT_READ_CONCURRENCY,
          async (slot) => {
            if (!contract) return "";
            const data = await getSlotDataAt(contract, onChainEventId, slot).catch(() => null);
            return data?.owner?.toLowerCase() ?? "";
          },
        );
        entry.slotOwners = owners;
        // Refunded sales (#645): keyed by the same (event, slot) the owners are,
        // on the same contract. The scanner checks these only after the
        // signature verifies, so listing a slot here never makes a forgery pass.
        if (contract) {
          const refunded = voidedSlots(onChainEventId, contractKey(contract));
          if (refunded.length > 0) entry.voidSlots = refunded;
        }
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
      doorMode: auth.mode,
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
  const refused = checkDevice(c, auth, deviceFrom(c, body.deviceId), false);
  if (refused) return refused;

  try {
    const result = mergeCheckins(c.req.param("eventId"), body.checkins);
    return c.json({ ok: true, data: result });
  } catch (err) {
    console.error("[checkin] sync could not be recorded:", err);
    return c.json({ ok: false, error: "Check-ins could not be recorded" }, 503);
  }
});

/**
 * Admit one ticket (#641). The scanner has already verified the signature and
 * refund status offline; this decides only whether the ticket is already in -
 * across every scanner, atomically. The scanner shows green on "admitted" and
 * on nothing else: a timeout, a 503 or no connection is "couldn't confirm".
 */
checkin.post("/:eventId/claim", async (c) => {
  const auth = authorisePass(c);
  if (!auth.ok) return auth.resp;

  const device = deviceFrom(c);
  if (!device) return c.json({ ok: false, error: "This scanner needs updating - reload the page and try again" }, 400);
  const refused = checkDevice(c, auth, device, false);
  if (refused) return refused;

  const body = (await c.req.json().catch(() => null)) as Partial<CheckinClaimRequest> | null;
  const record: CheckinRecord = {
    seriesId: body?.seriesId as string,
    edition: body?.edition as number,
    at: body?.at as string,
    method: body?.method as CheckinRecord["method"],
    claimId: body?.claimId as string,
    deviceId: device,
  };

  let result;
  try {
    result = claimCheckin(c.req.param("eventId"), record);
  } catch (err) {
    if (err instanceof Error && err.message === "invalid check-in claim") {
      return c.json({ ok: false, error: "Malformed check-in claim" }, 400);
    }
    // Not recorded means not admitted: the door must not act on a claim a
    // restart could forget.
    console.error("[checkin] claim could not be recorded:", err);
    return c.json({ ok: false, error: "Check-in could not be recorded" }, 503);
  }
  const data: CheckinClaimResponse = { ...result, serverTime: new Date().toISOString() };
  return c.json({ ok: true, data });
});

export { checkin, checkinOrganiser };
