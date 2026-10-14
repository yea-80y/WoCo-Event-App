/**
 * A ticket type's sale window names one instant everywhere.
 *
 * The editor used to send `saleEnd` as the bare `datetime-local` value
 * ("2026-10-20T20:30"). This server runs in UTC, so it read that as 20:30Z: a UK
 * organiser's 20:30 close kept selling until 21:30 BST, and an organiser west of
 * UTC had sales cut off hours early. Event start/end were already sent as UTC
 * instants; the sale bounds now are too, and create refuses one without a zone.
 *
 *  1. The validator: `Z` or a `±hh:mm` offset passes; wall-clock and date-only
 *     values do not. MUTATION: drop the offset group from the regex and the
 *     wall-clock cases go red.
 *  2. Over real HTTP with a real session delegation: a bare bound is a 400 that
 *     names the field; a zoned one gets past it to the NEXT gate's own 400
 *     (missing signedManifest) - no Swarm, no chain. MUTATION: remove the call
 *     from the route and the first case goes red.
 *  3. The gate compares instants: the same moment written with two offsets
 *     decides the same way.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Wallet, TypedDataEncoder } from "ethers";
import { Hono } from "hono";
import { SESSION_DOMAIN, SESSION_TYPES, SESSION_PURPOSE, SESSION_EXPIRY_MS } from "@woco/shared";
import { enableFeature } from "./helpers/features.js";
import { checkSeriesSaleWindow, isAbsoluteInstant, saleBoundsRefusal } from "../src/lib/event/series-window.js";

enableFeature("walletLoginAllowed");

const HOST = "test.woco.local";
process.env.ALLOWED_HOSTS = HOST;
process.env.EMAIL_HASH_SECRET = "test-secret-sale-bounds-timezone";

// ---------------------------------------------------------------------------
// 1. The validator
// ---------------------------------------------------------------------------

test("UTC and offset instants are absolute", () => {
  for (const v of [
    "2026-10-20T19:30:00.000Z",
    "2026-10-20T19:30Z",
    "2026-10-20T19:30:00Z",
    "2026-10-20T20:30:00+01:00",
    "2026-10-20T14:30:00-05:00",
  ]) {
    assert.equal(isAbsoluteInstant(v), true, v);
  }
});

test("wall-clock, date-only and junk values are not", () => {
  for (const v of [
    "2026-10-20T20:30",
    "2026-10-20T20:30:00",
    "2026-10-20",
    "2026-10-20 20:30Z",
    "20:30",
    "soonish",
    "2026-13-45T25:99:00Z",
  ]) {
    assert.equal(isAbsoluteInstant(v), false, v);
  }
});

test("absent and empty bounds are no bound; anything else must be absolute", () => {
  assert.equal(saleBoundsRefusal({}), null);
  assert.equal(saleBoundsRefusal({ saleStart: "", saleEnd: "" }), null);
  assert.equal(saleBoundsRefusal({ saleEnd: "2026-10-20T19:30:00.000Z" }), null);
  assert.match(saleBoundsRefusal({ saleEnd: "2026-10-20T20:30" }) ?? "", /^saleEnd must be a date and time with a timezone/);
  assert.match(saleBoundsRefusal({ saleStart: "2026-10-20" }) ?? "", /^saleStart must/);
  assert.match(saleBoundsRefusal({ saleStart: 1_760_000_000_000 }) ?? "", /^saleStart must/);
});

// ---------------------------------------------------------------------------
// 3. The money-path gate compares instants
// ---------------------------------------------------------------------------

test("the same close written in two zones decides the same way", () => {
  const ukClose = "2026-10-20T20:30:00+01:00";
  const utcClose = "2026-10-20T19:30:00.000Z";
  const justBefore = Date.parse("2026-10-20T19:29:00Z");
  const justAfter = Date.parse("2026-10-20T19:30:00Z");
  for (const saleEnd of [ukClose, utcClose]) {
    assert.deepEqual(checkSeriesSaleWindow({ saleEnd }, justBefore), { open: true }, saleEnd);
    assert.deepEqual(checkSeriesSaleWindow({ saleEnd }, justAfter), { open: false, reason: "closed" }, saleEnd);
  }
});

// ---------------------------------------------------------------------------
// 2. The create route
// ---------------------------------------------------------------------------

let app: Hono;

before(async () => {
  const { events } = await import("../src/routes/events.js");
  app = new Hono();
  app.route("/api/events", events as unknown as Hono);
});

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf-8").digest("hex");

/** A delegation minted exactly as the browser mints one (session-delegation.ts). */
async function mintDelegation() {
  const parent = Wallet.createRandom();
  const session = Wallet.createRandom();
  const nonce = randomUUID();
  const message = {
    host: HOST,
    parent: parent.address,
    session: session.address,
    purpose: SESSION_PURPOSE,
    nonce,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_EXPIRY_MS).toISOString(),
    sessionProof: await session.signMessage(`${HOST}:${nonce}`),
    clientCodeHash: "0x" + "00".repeat(32),
    statement: `Authorize ${session.address} as session key for ${HOST}`,
  };
  const parentSig = await parent.signTypedData(
    SESSION_DOMAIN,
    SESSION_TYPES as unknown as Parameters<typeof TypedDataEncoder.hash>[1],
    message,
  );
  return { session, delegation: { message, parentSig } };
}

async function post(body: unknown): Promise<{ status: number; error?: string }> {
  const d = await mintDelegation();
  const text = JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const challenge = ["woco-session-v1", "POST", "/api/events", timestamp, nonce, sha256Hex(text)].join("\n");
  const resp = await app.request("/api/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Address": d.session.address,
      "X-Session-Delegation": Buffer.from(JSON.stringify(d.delegation), "utf-8").toString("base64"),
      "X-Session-Sig": await d.session.signMessage(challenge),
      "X-Session-Nonce": nonce,
      "X-Session-Timestamp": timestamp,
    },
    body: text,
  });
  const json = (await resp.json()) as { ok?: boolean; error?: string };
  return { status: resp.status, error: json.error };
}

/** Well-formed up to the series' signed manifest, which is deliberately absent:
 *  its 400 is the marker for "got past the sale-bound check". */
function createBody(window: { saleStart?: string; saleEnd?: string }) {
  return {
    event: {
      title: "Test Night",
      startDate: "2099-01-01T19:00:00.000Z",
      endDate: "2099-01-01T22:00:00.000Z",
      description: "",
      location: "The Venue",
    },
    series: [{ seriesId: "sr-000000000001", name: "General", description: "", totalSupply: 10, ...window }],
    image: "data:image/png;base64,AAAA",
  };
}

test("create refuses a sale close with no timezone", async () => {
  const { status, error } = await post(createBody({ saleEnd: "2099-01-01T20:30" }));
  assert.equal(status, 400);
  assert.equal(
    error,
    "Series sr-000000000001: saleEnd must be a date and time with a timezone, e.g. 2026-10-20T19:30:00Z",
  );
});

test("create refuses a date-only sale open", async () => {
  const { status, error } = await post(createBody({ saleStart: "2098-12-01" }));
  assert.equal(status, 400);
  assert.match(error ?? "", /saleStart must be a date and time with a timezone/);
});

test("a zoned window gets past the check to the next gate", async () => {
  const { status, error } = await post(
    createBody({ saleStart: "2098-12-01T09:00:00.000Z", saleEnd: "2099-01-01T20:30:00+01:00" }),
  );
  assert.equal(status, 400);
  assert.match(error ?? "", /missing signedManifest/);
});
