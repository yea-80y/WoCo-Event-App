/**
 * The server's verdict on an added passkey (#746 step 3): one signed whoami from
 * in-memory material, mapped to what the sign-in does next. The request is exactly
 * what `middleware/auth.ts` verifies - checked here by rebuilding it the server's way.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Wallet, verifyMessage } from "ethers";
import { AuthErrorCode, type SessionDelegation } from "@woco/shared";

const { deviceVerdict } = await import("../src/lib/auth/device-verdict.ts");

const session = Wallet.createRandom();
const delegation = { message: { parent: "0x" + "aa".repeat(20) }, parentSig: "0x" + "11".repeat(65) } as unknown as SessionDelegation;

function stub(status: number, body: unknown) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { seen, fetchFn };
}

async function verdictFor(status: number, body: unknown) {
  const s = stub(status, body);
  return deviceVerdict({ delegation, sessionPrivateKey: session.privateKey, base: "https://api.test", fetchFn: s.fetchFn });
}

test("the server's answers map to what the sign-in does next", async () => {
  assert.equal(await verdictFor(200, { ok: true, data: { sessionRank: "device" } }), "device");
  assert.equal(await verdictFor(200, { ok: true, data: { sessionRank: "owner" } }), "owner");
  assert.equal(await verdictFor(403, { ok: false, code: AuthErrorCode.DEVICE_REMOVED }), "removed");
  assert.equal(await verdictFor(403, { ok: false, code: AuthErrorCode.SESSION_INVALID }), "invalid");
  assert.equal(await verdictFor(401, { ok: false }), "invalid");
});

test("no verdict is never a refusal: network, server errors, a wrong clock, an odd answer", async () => {
  assert.equal(await verdictFor(401, { ok: false, code: AuthErrorCode.SESSION_CLOCK_SKEW }), "unreachable");
  assert.equal(await verdictFor(500, { ok: false }), "unreachable");
  assert.equal(await verdictFor(200, { ok: true, data: {} }), "unreachable");
  const thrown = await deviceVerdict({
    delegation,
    sessionPrivateKey: session.privateKey,
    base: "",
    fetchFn: (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch,
  });
  assert.equal(thrown, "unreachable");
});

test("the request is the canonical signed whoami the server verifies", async () => {
  const s = stub(200, { ok: true, data: { sessionRank: "device" } });
  await deviceVerdict({ delegation, sessionPrivateKey: session.privateKey, base: "https://api.test", fetchFn: s.fetchFn });
  const { url, init } = s.seen[0]!;
  assert.equal(url, "https://api.test/api/auth/whoami");
  assert.equal(init.method, "POST");
  const h = init.headers as Record<string, string>;
  assert.equal(h["X-Session-Address"], session.address);
  assert.deepEqual(JSON.parse(Buffer.from(h["X-Session-Delegation"]!, "base64").toString("utf8")), delegation);
  const bodyHash = createHash("sha256").update(String(init.body), "utf8").digest("hex");
  const challenge = ["woco-session-v1", "POST", "/api/auth/whoami", h["X-Session-Timestamp"], h["X-Session-Nonce"], bodyHash].join("\n");
  assert.equal(verifyMessage(challenge, h["X-Session-Sig"]!), session.address);
});
