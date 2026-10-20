/**
 * #937 — every sentence `register-on-chain` can show an organiser is plain
 * English, and rewording them moved no code or status.
 *
 * The publish screen prints these after `Couldn't finish setting up "<name>"
 * tickets:`, so a word like "manifest" or "on-chain" reaches the organiser
 * verbatim. The refusals the handler reaches before any chain call are driven
 * through the real route; the in-flight 409 needs a pending chain transaction,
 * so only its sentence is pinned, through the shared table the route reads.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { TypedDataEncoder, Wallet } from "ethers";
import type { Bee } from "@ethersphere/bee-js";
import type { EventFeed } from "@woco/shared";
import { enableFeature } from "./helpers/features.js";

enableFeature("walletLoginAllowed");

const DEAD = "http://127.0.0.1:9";
const HOST = "test.woco.local";
process.env.BEE_URL = DEAD;
process.env.PROXY_URL = DEAD;
process.env.ALLOWED_HOSTS = HOST;
process.env.EMAIL_HASH_SECRET ??= "test-secret-937-register-refusals";

const OWNER = Wallet.createRandom();
const EVENT_ID = randomUUID();
const BAD_BLOB_REF = "aa".repeat(32);
const UNREADABLE_REF = "bb".repeat(32);

const originalCwd = process.cwd();
let dir: string;
let app: Hono;
let shared: typeof import("@woco/shared");
let REGISTER_REFUSALS: typeof import("../src/routes/events.js").REGISTER_REFUSALS;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "woco-937-register-"));
  process.chdir(dir);
  mkdirSync(join(dir, ".data"));
  shared = await import("@woco/shared");

  const { __setBeeForTests } = await import("../src/config/swarm.js");
  __setBeeForTests({
    downloadData: async (ref: string) => {
      // A stored ticket list in a format the live rail refuses.
      if (ref === BAD_BLOB_REF) {
        return new TextEncoder().encode(JSON.stringify({ signedManifest: { format: "woco.manifest.v1" } }));
      }
      // Not JSON at all: the read itself failed to produce a ticket list.
      if (ref === UNREADABLE_REF) return new TextEncoder().encode("not json");
      throw new Error(`unexpected download ${ref}`);
    },
  } as unknown as Bee);

  const routes = await import("../src/routes/events.js");
  REGISTER_REFUSALS = routes.REGISTER_REFUSALS;
  const { primeEventCache } = await import("../src/lib/event/service.js");
  primeEventCache(EVENT_ID, {
    v: 1,
    eventId: EVENT_ID,
    title: "Plain words",
    description: "",
    imageHash: "00".repeat(32),
    startDate: "2099-01-01T00:00:00.000Z",
    endDate: "2099-01-02T00:00:00.000Z",
    location: "Somewhere",
    creatorAddress: OWNER.address.toLowerCase(),
    createdAt: "2026-01-01T00:00:00.000Z",
    series: [
      { seriesId: "s-legacy", name: "Old", description: "", totalSupply: 5 },
      { seriesId: "s-bad-blob", name: "Bad", description: "", totalSupply: 5, swarmManifestRef: BAD_BLOB_REF },
      { seriesId: "s-unreadable", name: "Gone", description: "", totalSupply: 5, swarmManifestRef: UNREADABLE_REF },
    ],
  } as unknown as EventFeed);

  app = new Hono();
  app.route("/api/events", routes.events);
});

after(async () => {
  const { __setBeeForTests } = await import("../src/config/swarm.js");
  __setBeeForTests(null);
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf-8").digest("hex");

async function register(parent: Wallet, payload: Record<string, unknown>) {
  const path = `/api/events/${EVENT_ID}/register-on-chain`;
  const session = Wallet.createRandom();
  const nonce = randomUUID();
  const message = {
    host: HOST,
    parent: parent.address,
    session: session.address,
    purpose: shared.SESSION_PURPOSE,
    nonce,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + shared.SESSION_EXPIRY_MS).toISOString(),
    sessionProof: await session.signMessage(`${HOST}:${nonce}`),
    clientCodeHash: "0x" + "00".repeat(32),
    statement: `Authorize ${session.address} as session key for ${HOST}`,
  };
  const parentSig = await parent.signTypedData(
    shared.SESSION_DOMAIN,
    shared.SESSION_TYPES as unknown as Parameters<typeof TypedDataEncoder.hash>[1],
    message,
  );
  const body = JSON.stringify(payload);
  const ts = String(Date.now());
  const reqNonce = randomUUID();
  const challenge = ["woco-session-v1", "POST", path, ts, reqNonce, sha256Hex(body)].join("\n");
  const resp = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Address": session.address,
      "X-Session-Delegation": Buffer.from(JSON.stringify({ message, parentSig })).toString("base64"),
      "X-Session-Sig": await session.signMessage(challenge),
      "X-Session-Nonce": reqNonce,
      "X-Session-Timestamp": ts,
    },
    body,
  });
  return { status: resp.status, json: (await resp.json()) as Record<string, unknown> };
}

/** Words that mean nothing to an organiser, and the em dash owner copy never uses. */
const JARGON = /on-?chain|manifest|\bv[12]\b|registry|swarm|series|binding|—/i;

test("no sentence the route can show names an internal", () => {
  for (const [name, sentence] of Object.entries(REGISTER_REFUSALS)) {
    assert.ok(!JARGON.test(sentence), `${name}: "${sentence}"`);
  }
});

test("a request with no ticket type: 400, in plain words", async () => {
  const { status, json } = await register(OWNER, {});
  assert.equal(status, 400);
  assert.deepEqual(json, { ok: false, error: REGISTER_REFUSALS.missingSeries });
  assert.equal(json.error, "We couldn't tell which tickets to set up - please reload the page and try again.");
});

test("someone other than the creator: 403, told to sign in with the creating account", async () => {
  const { status, json } = await register(Wallet.createRandom(), { seriesId: "s-legacy" });
  assert.equal(status, 403);
  assert.deepEqual(json, { ok: false, error: REGISTER_REFUSALS.notCreator });
  assert.equal(
    json.error,
    "Only the account that created this event can set up its tickets - sign in with that account and try again.",
  );
});

test("a ticket type the event does not have: 404, in plain words", async () => {
  const { status, json } = await register(OWNER, { seriesId: "s-nope" });
  assert.equal(status, 404);
  assert.deepEqual(json, { ok: false, error: REGISTER_REFUSALS.seriesNotFound });
  assert.equal(json.error, "We couldn't find these tickets on this event - please reload the page and try again.");
});

test("tickets from before the current format: 400, told to create the event again", async () => {
  const { status, json } = await register(OWNER, { seriesId: "s-legacy" });
  assert.equal(status, 400);
  assert.deepEqual(json, { ok: false, error: REGISTER_REFUSALS.olderFormat });
  assert.equal(
    json.error,
    "These tickets were made with an older version of WoCo and can't be set up - please create the event again.",
  );
});

test("a stored ticket list in a format we refuse: 500, told to create the event again", async () => {
  const { status, json } = await register(OWNER, { seriesId: "s-bad-blob" });
  assert.equal(status, 500);
  assert.deepEqual(json, { ok: false, error: REGISTER_REFUSALS.unsupportedFormat });
  assert.equal(json.error, "These tickets were saved in a format we no longer support - please create the event again.");
});

test("a ticket list that does not load: 500, told to try again (unchanged)", async () => {
  const { status, json } = await register(OWNER, { seriesId: "s-unreadable" });
  assert.equal(status, 500);
  assert.deepEqual(json, { ok: false, error: REGISTER_REFUSALS.didNotLoad });
  assert.equal(json.error, "This event's tickets didn't load - please try again");
});

test("a registration still in flight keeps its words plain and its em dash gone", () => {
  assert.equal(REGISTER_REFUSALS.inFlight, "Your tickets are still being set up - please try again in a moment.");
});
