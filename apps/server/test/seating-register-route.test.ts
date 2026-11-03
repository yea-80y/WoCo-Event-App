/**
 * `register-on-chain` for a seated series (docs/SEATING.md), through the real route:
 * a series whose feed carries seat prices is checked against its MANIFEST (re-read and
 * held to the digest the feed names) and that manifest's plan, before any chain call.
 * Every case here stops before the sponsor wallet: the refusals are the point.
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
import type { EventFeed, ManifestV2Body } from "@woco/shared";
import { bytesToHex0x, manifestV2Digest } from "@woco/shared";
import {
  LAYOUT_TEMPLATES, encodeSeatPlan, freezeSeatPlan, seatPlanDigest, seatPlanEditionTemplate,
} from "@woco/shared/seating/index";
import { enableFeature } from "./helpers/features.js";

enableFeature("walletLoginAllowed");

const DEAD = "http://127.0.0.1:9";
const HOST = "test.woco.local";
process.env.BEE_URL = DEAD;
process.env.PROXY_URL = DEAD;
process.env.ALLOWED_HOSTS = HOST;
process.env.EMAIL_HASH_SECRET ??= "test-secret-seating-register";
process.env.WOCO_EVENT_CHAIN_ID ??= "421614";

const OWNER = Wallet.createRandom();
const EVENT_ID = randomUUID();

const plan = freezeSeatPlan(LAYOUT_TEMPLATES.find((t) => t.id === "comedy")!.make());
const planBytes = encodeSeatPlan(plan);
const PLAN_REF = "c1".repeat(32);
const SEATS = plan.seats.length;
const body: ManifestV2Body = {
  format: "woco.manifest.v2",
  totalSupply: SEATS,
  issuer: `0x${"11".repeat(20)}`,
  metadataRoot: `0x${"22".repeat(32)}`,
  encoding: "cbor-v1",
  treeScheme: "oz-simple-v1",
  editionTemplate: seatPlanEditionTemplate({ ref: PLAN_REF, digest: seatPlanDigest(planBytes), seats: SEATS }),
};
const MANIFEST_REF = "d1".repeat(32);
const manifestDigest = bytesToHex0x(manifestV2Digest(body));
const blob = { v: 2, signedManifest: { body, signature: `0x${"33".repeat(65)}` }, objectRefs: [], manifestDigestHex: manifestDigest };

const payment = { price: "15.00", currency: "GBP", stripeEnabled: true, cryptoEnabled: false, recipientAddress: OWNER.address, acceptedChains: [], escrow: false };
const prices = { bands: [{ id: plan.bands[0].id, price: "25.00" }, { id: plan.bands[1].id, price: "15.00" }] };
const seated = (seriesId: string, over: Record<string, unknown> = {}) => ({
  seriesId, name: "Seats", description: "", totalSupply: SEATS, price: 15,
  swarmManifestRef: MANIFEST_REF, manifestRef: manifestDigest, payment, seating: prices, ...over,
});

const originalCwd = process.cwd();
let dir: string;
let app: Hono;
let shared: typeof import("@woco/shared");

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "woco-seating-register-"));
  process.chdir(dir);
  mkdirSync(join(dir, ".data"));
  shared = await import("@woco/shared");

  const { __setBeeForTests } = await import("../src/config/swarm.js");
  __setBeeForTests({
    downloadData: async (ref: string) => {
      if (ref === MANIFEST_REF) return new TextEncoder().encode(JSON.stringify(blob));
      if (ref === PLAN_REF) return planBytes;
      throw new Error(`unexpected download ${ref}`);
    },
  } as unknown as Bee);

  const routes = await import("../src/routes/events.js");
  const { primeEventCache } = await import("../src/lib/event/service.js");
  primeEventCache(EVENT_ID, {
    v: 1,
    eventId: EVENT_ID,
    title: "Seated",
    description: "",
    imageHash: "00".repeat(32),
    startDate: "2099-01-01T00:00:00.000Z",
    endDate: "2099-01-02T00:00:00.000Z",
    location: "Somewhere",
    creatorAddress: OWNER.address.toLowerCase(),
    createdAt: "2026-01-01T00:00:00.000Z",
    series: [
      seated("s-seated"),
      seated("s-wrong-digest", { manifestRef: `0x${"44".repeat(32)}` }),
      seated("s-unpriced-band", { seating: { bands: [prices.bands[1]] } }),
    ],
  } as unknown as EventFeed);

  app = new Hono();
  app.route("/api/events", routes.events);
});

after(async () => {
  const { __setBeeForTests } = await import("../src/config/swarm.js");
  __setBeeForTests(null);
  enableFeature("seatedEventsAllowed", false);
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf-8").digest("hex");

async function register(seriesId: string) {
  const path = `/api/events/${EVENT_ID}/register-on-chain`;
  const session = Wallet.createRandom();
  const nonce = randomUUID();
  const message = {
    host: HOST,
    parent: OWNER.address,
    session: session.address,
    purpose: shared.SESSION_PURPOSE,
    nonce,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + shared.SESSION_EXPIRY_MS).toISOString(),
    sessionProof: await session.signMessage(`${HOST}:${nonce}`),
    clientCodeHash: "0x" + "00".repeat(32),
    statement: `Authorize ${session.address} as session key for ${HOST}`,
  };
  const parentSig = await OWNER.signTypedData(
    shared.SESSION_DOMAIN,
    shared.SESSION_TYPES as unknown as Parameters<typeof TypedDataEncoder.hash>[1],
    message,
  );
  const reqBody = JSON.stringify({ seriesId });
  const ts = String(Date.now());
  const reqNonce = randomUUID();
  const challenge = ["woco-session-v1", "POST", path, ts, reqNonce, sha256Hex(reqBody)].join("\n");
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
    body: reqBody,
  });
  return { status: resp.status, json: (await resp.json()) as Record<string, unknown> };
}

test("seating switched off: a seated series does not register", async () => {
  enableFeature("seatedEventsAllowed", false);
  const r = await register("s-seated");
  assert.equal(r.status, 400);
  assert.equal(r.json.error, "Allocated seating is not available yet");
});

test("a manifest that does not hash to the digest the feed names is refused", async () => {
  enableFeature("seatedEventsAllowed", true);
  const r = await register("s-wrong-digest");
  assert.equal(r.status, 400);
});

test("a band without a price is refused, from the plan the manifest names", async () => {
  enableFeature("seatedEventsAllowed", true);
  const r = await register("s-unpriced-band");
  assert.equal(r.status, 400);
  assert.match(String(r.json.error), /^Seat prices: /);
});

test("a consistent seated series still needs the seated contract", async () => {
  enableFeature("seatedEventsAllowed", true);
  const r = await register("s-seated");
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "Seated events are not available on this network yet");
});
