/**
 * /api/keyring (#186): the ring store takes only a well-formed ring for the caller's
 * own account (it is not a general upload - the gateway serves its chunks), and the
 * refresh answers what the chain says.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { Wallet, TypedDataEncoder } from "ethers";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_DOMAIN, SESSION_TYPES, SESSION_PURPOSE, SESSION_EXPIRY_MS } from "@woco/shared";
import { enableFeature } from "./helpers/features.js";

enableFeature("walletLoginAllowed");
const HOST = "test.woco.local";
process.env.ALLOWED_HOSTS = HOST;
process.chdir(mkdtempSync(join(tmpdir(), "woco-keyring-routes-")));

const { keyring } = await import("../src/routes/keyring.js");
const { installRing, noRings } = await import("./helpers/key-ring.js");
const { encodeKeyRing, parseKeyRing } = await import("@woco/shared/keyring/ring");
const { _setCurrentRingDepsForTests, currentRing } = await import("../src/lib/keyring/current-ring.js");

const app = new Hono();
app.route("/api/keyring", keyring);
const sha256Hex = (t: string) => createHash("sha256").update(t, "utf-8").digest("hex");

async function walletSession() {
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
  const parentSig = await parent.signTypedData(SESSION_DOMAIN, SESSION_TYPES as unknown as Parameters<typeof TypedDataEncoder.hash>[1], message);
  return { parent: parent.address.toLowerCase(), session, delegation: { message, parentSig } };
}

async function post(path: string, s: Awaited<ReturnType<typeof walletSession>>, body: unknown) {
  const raw = JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const challenge = ["woco-session-v1", "POST", path, timestamp, nonce, sha256Hex(raw)].join("\n");
  const resp = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Address": s.session.address,
      "X-Session-Delegation": Buffer.from(JSON.stringify(s.delegation), "utf-8").toString("base64"),
      "X-Session-Sig": await s.session.signMessage(challenge),
      "X-Session-Nonce": nonce,
      "X-Session-Timestamp": timestamp,
    },
    body: raw,
  });
  return { status: resp.status, json: (await resp.json()) as Record<string, any> };
}

test("ring store: refuses anything but a ring, and a ring for another account", async () => {
  const s = await walletSession();
  assert.equal((await post("/api/keyring/ring", s, { dataB64: Buffer.from("not a ring").toString("base64") })).status, 400);
  // A real ring, for some other account.
  const other = "0x" + "cd".repeat(20);
  await installRing(other);
  const r = await currentRing(other);
  assert.equal(r.status, "ring");
  const bytes = encodeKeyRing(r.status === "ring" ? r.ring : (null as never));
  const res = await post("/api/keyring/ring", s, { dataB64: Buffer.from(bytes).toString("base64") });
  assert.equal(res.status, 403);
  assert.match(res.json.error, /different account/);
});

test("ring store: only the canonical bytes - nothing smuggled beside the fields", async () => {
  const s = await walletSession();
  await installRing(s.parent);
  const r = await currentRing(s.parent);
  const canonical = Buffer.from(encodeKeyRing(r.status === "ring" ? r.ring : (null as never))).toString("utf8");
  const smuggled = [
    canonical.replace('{"v":1', '{"v":1,"parent":"<script>alert(1)</script>"'), // duplicate key, last wins in JSON.parse
    canonical + "   \n\n",
    " " + canonical,
  ];
  for (const text of smuggled) {
    const res = await post("/api/keyring/ring", s, { dataB64: Buffer.from(text).toString("base64") });
    assert.equal(res.status, 400, text.slice(0, 40));
  }
});

test("ring store: an order key sent with the ring must be the ring's own", async () => {
  const s = await walletSession();
  await installRing(s.parent);
  const r = await currentRing(s.parent);
  const bytes = encodeKeyRing(r.status === "ring" ? r.ring : (null as never));
  const wrong = new Uint8Array(1216).fill(7);
  const res = await post("/api/keyring/ring", s, { dataB64: Buffer.from(bytes).toString("base64"), orderKeyB64: Buffer.from(wrong).toString("base64") });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /not this ring's/);
});

test("ring store: a ring for the caller's account still needs an unlocked account", async () => {
  const s = await walletSession();
  await installRing(s.parent);
  const r = await currentRing(s.parent);
  const bytes = encodeKeyRing(r.status === "ring" ? r.ring : (null as never));
  assert.equal(parseKeyRing(bytes).parent, s.parent);
  const res = await post("/api/keyring/ring", s, { dataB64: Buffer.from(bytes).toString("base64") });
  assert.equal(res.status, 403);
  assert.equal(res.json.error, "ticket_required");
});

test("refresh: answers the chain's ring for the caller, or none", async () => {
  const s = await walletSession();
  noRings();
  assert.deepEqual((await post("/api/keyring/refresh", s, {})).json, { ok: true, data: null });
  const { ref } = await installRing(s.parent, 2);
  assert.deepEqual((await post("/api/keyring/refresh", s, {})).json, { ok: true, data: { ref, gen: 2 } });
  _setCurrentRingDepsForTests({ readAnchor: async () => { throw new Error("down"); } });
  assert.equal((await post("/api/keyring/refresh", s, {})).status, 503);
});
