/**
 * Event create no longer asks for — or keeps — a creator holder key (#518).
 *
 * `creatorObjectKey` was a REQUIRED field: a missing one was a 400, and the value
 * was stamped onto the stored `EventFeed` where nothing ever read it back. It
 * was the ed25519 holder public key, which signs nothing on any issuance path
 * (manifests are signed by the secp256k1 issuing key), so it bought exactly one
 * thing — a create that fails for a client that stopped sending it.
 *
 * Two halves, because they fail differently:
 *
 *  1. BEHAVIOURAL, over real HTTP with a real session delegation: a create
 *     carrying no holder key must get PAST the missing-field gate. Proved by
 *     landing on the NEXT validation's own, distinct 400 — no Swarm, no chain,
 *     no upload. MUTATION: put `!creatorObjectKey ||` back in the route's image
 *     guard and this goes red on the error string.
 *
 *  2. STRUCTURAL, over the two files that assemble and persist the feed: neither
 *     may name the field, and the route may not spread the request body into
 *     the create call (which is how an unnamed field would get stored anyway).
 *     A source scan is the honest instrument here — running the writer means
 *     uploading an image and a manifest set to Swarm, and the property is about
 *     what the writer NAMES. MUTATION: re-add the field to either file's create
 *     path and this goes red.
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
} from "@woco/shared";

const HOST = "test.woco.local";
process.env.ALLOWED_HOSTS = HOST;
process.env.EMAIL_HASH_SECRET = "test-secret-event-create-holder-key";

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

/**
 * A create body that is well-formed up to `tags`, which is deliberately wrong.
 * `tags` is validated immediately AFTER the image gate and BEFORE anything that
 * touches the network, so its error is the marker for "got past the required
 * fields" — and it is a different string from every gate before it.
 */
function bodyStoppingAtTags(extra: Record<string, unknown> = {}) {
  return {
    event: {
      title: "Test Night",
      startDate: "2099-01-01T00:00:00.000Z",
      endDate: "2099-01-02T00:00:00.000Z",
      description: "",
      location: "The Venue",
      tags: "not-an-array",
    },
    series: [{ seriesId: "sr-000000000001", name: "General", description: "", totalSupply: 10 }],
    image: "data:image/png;base64,AAAA",
    ...extra,
  };
}

test("a create with NO holder key gets past the required-field gate", async () => {
  const { status, error } = await post(bodyStoppingAtTags());
  assert.equal(status, 400, "the tags gate is the intended stop");
  assert.match(error ?? "", /tags must be an array/);
  assert.doesNotMatch(error ?? "", /creatorObjectKey/i, "the field must not be required any more");
});

test("the missing-image refusal no longer names a holder key", async () => {
  // The old message was "Missing creatorObjectKey or image", so a client debugging a
  // genuinely missing image was pointed at a field that no longer exists.
  const b = bodyStoppingAtTags();
  delete (b as { image?: string }).image;
  const { status, error } = await post(b);
  assert.equal(status, 400);
  assert.equal(error, "Missing image");
});

test("a legacy client still sending one is not refused for it", async () => {
  // Behaviour must be IDENTICAL with the field present — an old cached bundle
  // keeps sending it and must not start failing.
  const { status, error } = await post(bodyStoppingAtTags({ creatorObjectKey: "0x" + "aa".repeat(32) }));
  assert.equal(status, 400);
  assert.match(error ?? "", /tags must be an array/);
});

// ---------------------------------------------------------------------------
// The stored feed cannot carry one
// ---------------------------------------------------------------------------

const ROUTE_SRC = readFileSync(new URL("../src/routes/events.ts", import.meta.url), "utf-8");
const SERVICE_SRC = readFileSync(new URL("../src/lib/event/service.ts", import.meta.url), "utf-8");

test("neither the create route nor the feed writer names a holder key", () => {
  assert.doesNotMatch(ROUTE_SRC, /creatorObjectKey/, "the route must not read one off the body");
  assert.doesNotMatch(SERVICE_SRC, /creatorObjectKey/, "the writer must not stamp one into the feed");
});

test("the route builds the create call from NAMED fields, never a body spread", () => {
  // The structural half of the guard: a spread would carry any extra property a
  // client invented straight into the stored feed, so "the field is not named"
  // would stop meaning "the field is not stored".
  assert.doesNotMatch(
    ROUTE_SRC,
    /createEventV2\(\s*\{\s*\.\.\.\s*(body|ev)\b/,
    "createEventV2 must be called with explicit fields",
  );
});
