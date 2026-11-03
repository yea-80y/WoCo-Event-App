/**
 * POST /api/events/:id/ledger2/relay - submit changes the organiser SIGNED with its
 * organiser key to the event's ledger2 registrations, WoCo paying the gas.
 *
 * Body: `Ledger2RelayRequest` (`@woco/shared/ticket/ledger2-terms`): capacity, sales
 * cutoff, seat moves, or - alone - the revokes that are the app's "Cancel" on a change
 * still saving. Cancelling the EVENT goes through `POST /:id/cancel`, which records the
 * cancellation (refunds, sales stop) before it relays the signed cancels.
 *
 * Inert until ledger2 is deployed: with no ledger2 address configured, or no series of
 * the event registered on it, every request is `404 not_available`. The core and what
 * it agrees to pay for: `lib/event/ledger2-relay.ts`.
 */

import { Hono, type Context } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { getEventForOwner } from "../lib/event/service.js";
import { SlidingWindowLimiter } from "../lib/http/rate-limit.js";
import { clientIp } from "../lib/http/client-ip.js";
import { liveLedger2RelayDeps } from "../lib/event/ledger2-relay-live.js";
import {
  prepareLedger2Relay,
  submitLedger2Relay,
  type Ledger2RelayDeps,
  type RelayRefusal,
} from "../lib/event/ledger2-relay.js";
import type { Ledger2Kind } from "@woco/shared/ticket/ledger2-terms";

const CHANGE_KINDS: ReadonlySet<Ledger2Kind> = new Set(["setSupply", "extendSalesEnd", "reseat", "reseatBearer", "revoke"]);

/**
 * Bad-actor barriers only (owner 10-08), never a budget cap. Changes and revokes are
 * budgeted apart, so an organiser who has used its change budget can still press
 * "Cancel". Peek every key before recording any.
 */
export function ledger2RelayLimiters() {
  return {
    account: new SlidingWindowLimiter([
      { limit: 10, windowMs: 60 * 60_000 },
      { limit: 40, windowMs: 24 * 60 * 60_000 },
    ]),
    revokeAccount: new SlidingWindowLimiter([{ limit: 20, windowMs: 60 * 60_000 }]),
    ip: new SlidingWindowLimiter([{ limit: 30, windowMs: 60 * 60_000 }]),
    global: new SlidingWindowLimiter([{ limit: 30, windowMs: 60_000 }]),
  };
}

export function refusalResponse(c: Context<AppEnv>, r: RelayRefusal) {
  return c.json({ ok: false, error: r.error, ...(r.detail ?? {}) }, r.status);
}

export function ledger2RelayRoutes(
  deps: Ledger2RelayDeps = liveLedger2RelayDeps,
  loadEvent: typeof getEventForOwner = getEventForOwner,
  limits = ledger2RelayLimiters(),
) {
  const routes = new Hono<AppEnv>();

  routes.post("/:id/ledger2/relay", requireAuth, async (c) => {
    const eventId = c.req.param("id");
    const parent = (c.get("parentAddress") as string).toLowerCase();
    const body = c.get("body") as { items?: Array<{ kind?: unknown }> } | undefined;

    const feed = await loadEvent(eventId, parent).catch(() => null);
    if (!feed) return c.json({ ok: false, error: "event_not_found" }, 404);
    if (feed.creatorAddress.toLowerCase() !== parent) return c.json({ ok: false, error: "not_organiser" }, 403);
    if (feed.deleted) return c.json({ ok: false, error: "event_deleted" }, 409);

    const revokeOnly = Array.isArray(body?.items) && body.items.length > 0 && body.items.every((i) => i?.kind === "revoke");
    const account = revokeOnly ? limits.revokeAccount : limits.account;
    const ip = clientIp(c);
    if (!account.peek(parent) || !limits.ip.peek(ip) || !limits.global.peek("all")) {
      return c.json({ ok: false, error: "rate_limited" }, 429);
    }
    // Every request reaching the chain reads counts against the IP and the flood
    // guard; the account's own budget is charged only for one that will be sent, so
    // re-signing a change that went stale costs the organiser nothing.
    limits.ip.record(ip);
    limits.global.record("all");

    const prepared = await prepareLedger2Relay(
      {
        eventId,
        parent,
        seriesIds: feed.series.map((s) => s.seriesId),
        request: body,
        allowed: CHANGE_KINDS,
        label: revokeOnly ? "ledger2.revoke" : "ledger2.change",
      },
      deps,
    );
    if (!prepared.ok) return refusalResponse(c, prepared);

    account.record(parent);
    const sent = await submitLedger2Relay(prepared.prepared, deps);
    if (!sent.ok) return refusalResponse(c, sent);
    return c.json({ ok: true, data: sent.result });
  });

  return routes;
}
