/**
 * Every event says where it is: a place with coordinates, or online (owner,
 * 2026-10-15). The coordinates are what Discover's distance filter matches on,
 * and an event made without them can never be found by it.
 *
 *  1. BEHAVIOURAL, over real HTTP with a real session delegation: create and
 *     update-meta refuse a missing place before any Swarm or chain work. A create
 *     WITH a place is proved to get past the gate by landing on the next
 *     validation's own 400 (a malformed seriesId).
 *  2. STRUCTURAL, where running the path means a Swarm read: the edit merge and
 *     the event-page deploy name the same rule.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { Wallet, TypedDataEncoder } from "ethers";
import { Hono } from "hono";
import {
  SESSION_DOMAIN,
  SESSION_TYPES,
  SESSION_PURPOSE,
  SESSION_EXPIRY_MS,
  EVENT_PLACE_REQUIRED,
} from "@woco/shared";
import { enableFeature } from "./helpers/features.js";

enableFeature("walletLoginAllowed");

const HOST = "test.woco.local";
process.env.ALLOWED_HOSTS = HOST;
process.env.EMAIL_HASH_SECRET = "test-secret-event-place-required";

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

async function post(path: string, body: unknown): Promise<{ status: number; error?: string }> {
  const d = await mintDelegation();
  const text = JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const challenge = ["woco-session-v1", "POST", path, timestamp, nonce, sha256Hex(text)].join("\n");
  const resp = await app.request(path, {
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

const PUB = { country: "GB", city: "Northampton", venue: "The Abington Public House", lat: 52.2457874, lng: -0.8705699 };

/** Valid up to the place gate; the seriesId is malformed, so a create that gets
 *  past the gate stops on that distinct 400 with nothing written. */
function createBody(geo: unknown) {
  return {
    event: {
      title: "Test Night",
      startDate: "2099-01-01T00:00:00.000Z",
      endDate: "2099-01-02T00:00:00.000Z",
      description: "",
      location: "The Venue",
      ...(geo === undefined ? {} : { geo }),
    },
    series: [{ seriesId: "BAD", name: "General", description: "", totalSupply: 10 }],
    image: "data:image/png;base64,AAAA",
  };
}

test("create: no place is refused", async () => {
  const { status, error } = await post("/api/events", createBody(undefined));
  assert.equal(status, 400);
  assert.equal(error, EVENT_PLACE_REQUIRED);
});

test("create: a name, a city or a country without coordinates is not a place", async () => {
  for (const geo of [{}, { venue: "The Abington" }, { country: "GB", city: "Northampton" }, { lat: 52.2 }, { online: "yes" }]) {
    const { status, error } = await post("/api/events", createBody(geo));
    assert.equal(status, 400, JSON.stringify(geo));
    assert.equal(error, EVENT_PLACE_REQUIRED, JSON.stringify(geo));
  }
});

test("create: a picked place gets past the gate", async () => {
  const { status, error } = await post("/api/events", createBody(PUB));
  assert.equal(status, 400);
  assert.match(error ?? "", /Each seriesId must be/);
});

test("create: an online event gets past the gate", async () => {
  const { status, error } = await post("/api/events", createBody({ online: true }));
  assert.equal(status, 400);
  assert.match(error ?? "", /Each seriesId must be/);
});

test("update-meta: a geo that is not a place is refused before the event is read", async () => {
  // The old picker sent {} to clear a place. The event id needs no record: the
  // refusal comes before anything resolves it.
  for (const geo of [{}, { country: "GB" }]) {
    const { status, error } = await post("/api/events/evt-place-test/update-meta", { geo });
    assert.equal(status, 400, JSON.stringify(geo));
    assert.equal(error, EVENT_PLACE_REQUIRED, JSON.stringify(geo));
  }
});

// ---------------------------------------------------------------------------
// The edit merge and the page deploy
// ---------------------------------------------------------------------------

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const SERVICE = code(readFileSync(new URL("../src/lib/event/service.ts", import.meta.url), "utf-8"));
const ROUTE = code(readFileSync(new URL("../src/routes/events.ts", import.meta.url), "utf-8"));
const SITE = code(readFileSync(new URL("../src/routes/site.ts", import.meta.url), "utf-8"));

test("an edit is checked on the MERGED feed, before anything is written", () => {
  const start = SERVICE.indexOf("export async function updateEventMetadata");
  assert.ok(start >= 0, "updateEventMetadata must exist - a rename would make this pass vacuously");
  const body = SERVICE.slice(start, SERVICE.indexOf("\n}\n", start));
  const merged = body.indexOf("const updated: EventFeed = { ...feed };");
  const check = body.indexOf("if (!eventHasPlace(updated.geo)) throw new Error(EVENT_PLACE_REQUIRED);");
  const write = body.indexOf("await writeFeedPage(");
  assert.ok(merged > 0 && check > merged, "after the merge, so an event made before the rule must gain a place");
  assert.ok(write > check, "before the legacy rewrite");
  assert.match(ROUTE, /msg === EVENT_PLACE_REQUIRED \? 400/, "the merge's refusal is the organiser's to fix, not a 500");
});

test("the event-page deploy refuses a feed it read with no place, before building the page", () => {
  const read = SITE.indexOf("const event = await getEvent(eventId, eventSigner).catch(() => null);");
  const check = SITE.indexOf("if (event && !eventHasPlace(event.geo)) return c.json({ ok: false, error: EVENT_PLACE_REQUIRED }, 400);");
  const build = SITE.indexOf("await fs.cp(DIST_SITE_PATH, tmpDir");
  assert.ok(read > 0, "the deploy must read the event - a rename would make this pass vacuously");
  assert.ok(check > read && build > check);
});
