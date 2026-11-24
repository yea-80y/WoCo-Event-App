/**
 * `/api/holdings/*` - collecting a private ticket receipt, and erasing our copy of it
 * (woco-ops/spec-receipt-note-20261123.md 5.1-5.2). Behind
 * `FEATURES.holdingReceiptsAllowed`: off, every route refuses before reading anything.
 *
 *   POST /pickup        { pickupId }                  no session, per-IP limit
 *   POST /pickup/erase  { pickupId, issuedAt, sig }   no session: signed by the order's pickup signer
 *   POST /mine          (session)                     the signed-in account's own sales
 *
 * The pickup id travels only in a POST body: a path or a query string reaches access
 * logs. Collecting and erasing carry no session, so neither links an account to the
 * ticket; knowing the order's secret is the only authority.
 *
 * The server is on the read path only while a box waits here to be stored. Once it is
 * on Swarm the answer is its root alone, and the app reads it there (our gateway lists
 * it, #965).
 *
 * Every refusal the app acts on carries a `code` (`HOLDING_API_CODES`): a bare 404 from
 * a proxy or an older server must never read as "no receipt".
 *
 * NOTHING HERE LOGS who asked: no address, no account, no pickup id
 * (`test/holding-routes-no-logging.test.ts`). The per-IP limits keep counts in memory only.
 */

import { Hono, type Context, type Next } from "hono";
import { FEATURES } from "@woco/shared";
import { HOLDING_API_CODES } from "@woco/shared/holding/api-codes";
import { checkErasePickup } from "@woco/shared/holding/pickup";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { jsonBodyLimit } from "../lib/http/body-limit.js";
import { clientIp } from "../lib/http/client-ip.js";
import { errorClass } from "../lib/http/error-class.js";
import { SlidingWindowLimiter } from "../lib/http/rate-limit.js";
import { eraseOrder, type EraseOutcome } from "../lib/attendee-batch/erase.js";
import {
  holdingByPickupId,
  holdingsForAccount,
  holdingStoreUnreadable,
  isHoldingBoxStoring,
  markHoldingErased,
  type HoldingRecordV1,
} from "../lib/holding/store.js";

export interface HoldingsRouteDeps {
  /** Erase the box on the attendee batch, wherever it is (`eraseOrder`). Resumable. */
  eraseBox(root: string): Promise<EraseOutcome>;
  now(): number;
}

const liveDeps: HoldingsRouteDeps = {
  eraseBox: (root) => eraseOrder(root, { by: "request" }),
  now: () => Date.now(),
};

function tryLater(c: Context<AppEnv>) {
  return c.json({ ok: false, error: "Could not erase it right now - try again later" }, 503);
}

function storingNow(c: Context<AppEnv>) {
  c.header("Retry-After", "60");
  return c.json({ ok: false, error: "Your receipt is being saved right now - try again in a minute", code: HOLDING_API_CODES.STORING }, 409);
}

const PICKUP_ID_RE = /^[0-9a-f]{64}$/;
/** A 65-byte signature as 0x-hex is 132 characters; anything much longer is not one. */
const MAX_SIG_CHARS = 140;

async function gate(c: Context<AppEnv>, next: Next) {
  if (!FEATURES.holdingReceiptsAllowed) {
    return c.json({ ok: false, error: "Private ticket receipts are not available yet", code: HOLDING_API_CODES.OFF }, 403);
  }
  await next();
}

/** No record with that id. While a file is unreadable that answer may be false, so say "later". */
function notFound(c: Context<AppEnv>) {
  if (holdingStoreUnreadable() > 0) {
    return c.json({ ok: false, error: "Receipts cannot be read right now - try again later" }, 503);
  }
  return c.json({ ok: false, error: "No receipt with that id", code: HOLDING_API_CODES.NOT_FOUND }, 404);
}

async function readBody(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  const body = (await c.req.json().catch(() => null)) as unknown;
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/** A paid record not erased: what can be collected. */
function collectable(r: HoldingRecordV1 | null): r is HoldingRecordV1 & { issued: NonNullable<HoldingRecordV1["issued"]> } {
  return !!r?.issued && !r.erasedAt;
}

export function holdingsRoutes(deps: HoldingsRouteDeps = liveDeps) {
  // A guest presses Keep once or twice; a family behind one address a few times more.
  const PICKUP_IP = new SlidingWindowLimiter([
    { limit: 30, windowMs: 10 * 60_000 },
    { limit: 200, windowMs: 24 * 60 * 60_000 },
  ]);
  // An erase can burn chunks on the attendee batch: fewer.
  const ERASE_IP = new SlidingWindowLimiter([
    { limit: 10, windowMs: 10 * 60_000 },
    { limit: 50, windowMs: 24 * 60 * 60_000 },
  ]);
  const MINE_ACCOUNT = new SlidingWindowLimiter([{ limit: 30, windowMs: 10 * 60_000 }]);

  const holdings = new Hono<AppEnv>();
  holdings.use("*", gate);

  holdings.post("/pickup", jsonBodyLimit(512), async (c) => {
    if (!PICKUP_IP.allow(`ip:${clientIp(c)}`)) return c.json({ ok: false, error: "Too many requests - try again later" }, 429);
    const pickupId = (await readBody(c))?.pickupId;
    if (typeof pickupId !== "string" || !PICKUP_ID_RE.test(pickupId)) return c.json({ ok: false, error: "Malformed pickup id" }, 400);
    const r = holdingByPickupId(pickupId);
    if (!collectable(r)) return notFound(c);
    return c.json({ ok: true, data: { boxRoot: r.issued.boxRoot, ...(r.issued.box ? { box: r.issued.box } : {}) } });
  });

  holdings.post("/pickup/erase", jsonBodyLimit(1024), async (c) => {
    if (!ERASE_IP.allow(`ip:${clientIp(c)}`)) return c.json({ ok: false, error: "Too many requests - try again later" }, 429);
    const body = await readBody(c);
    const pickupId = body?.pickupId;
    const issuedAt = body?.issuedAt;
    const sig = body?.sig;
    if (
      typeof pickupId !== "string" ||
      !PICKUP_ID_RE.test(pickupId) ||
      typeof issuedAt !== "number" ||
      !Number.isSafeInteger(issuedAt) ||
      typeof sig !== "string" ||
      sig.length > MAX_SIG_CHARS
    ) {
      return c.json({ ok: false, error: "Malformed erase request" }, 400);
    }
    const r = holdingByPickupId(pickupId);
    if (!r) return notFound(c);
    const nowSecs = Math.floor(deps.now() / 1000);
    if (!checkErasePickup({ pickupId, issuedAt, signature: sig, expectedSigner: r.pickupSigner, nowSecs })) {
      // An id `/pickup` calls unknown (unpaid, erased) reads the same here to anyone without its key.
      if (!collectable(r)) return notFound(c);
      return c.json({ ok: false, error: "Not signed by this receipt's key, or the signature is out of date", code: HOLDING_API_CODES.ERASE_REFUSED }, 403);
    }
    if (!r.issued) return c.json({ ok: false, error: "There is no receipt to erase yet", code: HOLDING_API_CODES.NOT_ISSUED }, 409);
    const root = r.issued.boxRoot;
    if (isHoldingBoxStoring(root)) return storingNow(c);

    // The buyer's erase is recorded BEFORE the burn, as the ledger records an erasure
    // before its first chunk: the minute sweep then leaves the record (its public values
    // stay until the event's end), and a crash or a failed burn leaves the intent on disk
    // for the retry. A box not yet stored goes with this write.
    if (!markHoldingErased(r.sessionId, deps.now())) return tryLater(c);

    // Every time, even for a record already erased: the erase is resumable, so a retry
    // finishes a burn an earlier attempt left part done.
    let out: EraseOutcome;
    try {
      out = await deps.eraseBox(root);
    } catch (err) {
      console.error(`[holdings] erase of ${r.sessionId}'s box failed (${errorClass(err)})`);
      return tryLater(c);
    }
    if (out.kind === "in-flight") return storingNow(c);
    if (out.kind === "hold-not-deleted") return tryLater(c);
    // A box never stored is tombstoned, never "not found" (and the tombstone write refuses
    // an unreadable ledger). So "not-found" means a STORED box the ledger does not know
    // (unreadable, or restored from an older backup): still on Swarm, never "erased".
    if (out.kind === "not-found") {
      console.error(`[holdings] ${r.sessionId}: the attendee ledger has no record of its stored box; not confirming the erase`);
      return tryLater(c);
    }
    return c.json({ ok: true, data: { erased: true } });
  });

  holdings.post("/mine", jsonBodyLimit(256), requireAuth, async (c) => {
    // The VERIFIED account, never a body value: these are the sales it bought signed in.
    const account = (c.get("parentAddress") as string).toLowerCase();
    if (!MINE_ACCOUNT.allow(account)) return c.json({ ok: false, error: "Too many requests - try again later" }, 429);
    const rows = holdingsForAccount(account)
      .filter(collectable)
      .filter((r) => !!r.sealedR)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => ({
        eventId: r.eventId,
        seriesId: r.seriesId,
        pickupId: r.pickupId,
        sealedR: r.sealedR,
        boxRoot: r.issued.boxRoot,
        ...(r.issued.box ? { box: r.issued.box } : {}),
      }));
    // An unreadable file may be one of this account's: say the list may be short.
    return c.json({ ok: true, data: { holdings: rows, complete: holdingStoreUnreadable() === 0 } });
  });

  return holdings;
}
