/**
 * An unsubscribe is only reported done once its mark is on disk (#882). A mark
 * held only in memory is gone after the next restart, so "You're unsubscribed"
 * over a refused or failed write was a promise the platform could not keep.
 * Every surface that records one answers 503 instead, which a one-click
 * (RFC 8058) client also reads as not done.
 */
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { TypedDataEncoder, Wallet } from "ethers";
import { enableFeature } from "./helpers/features.js";

enableFeature("walletLoginAllowed");

const HOST = "test.woco.local";
process.env.ALLOWED_HOSTS = HOST;
process.env.EMAIL_HASH_SECRET = "test-secret-882-routes";

const dir = mkdtempSync(join(tmpdir(), "woco-882-routes-"));
const originalCwd = process.cwd();
process.chdir(dir);
mkdirSync(join(dir, ".data"));
after(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

const SUPPRESSION = join(dir, ".data", "marketing-suppression.json");
// A directory where the atomic write's temp file goes: the write fails as a full disk would.
const WRITE_BLOCKER = `${SUPPRESSION}.tmp`;

const suppression = await import("../src/lib/marketing/suppression-store.js");
const { unsubscribe } = await import("../src/routes/unsubscribe.js");
const { mintUnsubToken } = await import("../src/lib/marketing/unsub-token.js");
const { marketing } = await import("../src/routes/marketing.js");
const { hashEmail } = await import("../src/lib/event/claim-service.js");
const { SESSION_DOMAIN, SESSION_TYPES, SESSION_PURPOSE, SESSION_EXPIRY_MS } = await import("@woco/shared");

const app = new Hono();
app.route("/api/marketing", marketing);

const ORG = "0xabcd000000000000000000000000000000000011";
const H = "a".repeat(64);
const TRY_AGAIN = /We couldn't record that just now - please try again in a few minutes\./;
const DONE = /unsubscribed/i;

beforeEach(() => {
  rmSync(SUPPRESSION, { recursive: true, force: true });
  rmSync(WRITE_BLOCKER, { recursive: true, force: true });
  suppression.__resetSuppressionStoreForTest();
});

const token = () => mintUnsubToken({ emailHash: H, organiserAddress: ORG });

function post(body?: { type: string; text: string }): Promise<Response> {
  return unsubscribe.request(`/${token()}`, {
    method: "POST",
    ...(body ? { headers: { "Content-Type": body.type }, body: body.text } : {}),
  });
}

const ONE_CLICK = { type: "application/x-www-form-urlencoded", text: "List-Unsubscribe=One-Click" };
const BLOCK_ALL = { type: "application/x-www-form-urlencoded", text: "all=1" };

function markOnDisk(): Record<string, { orgs: Record<string, unknown>; global?: unknown }> {
  return JSON.parse(readFileSync(SUPPRESSION, "utf-8"));
}

// ── /u/:token ─────────────────────────────────────────────────────────────

test("unsubscribe: a recorded mark reads as done, exactly as before", async () => {
  for (const body of [ONE_CLICK, undefined]) {
    const res = await post(body);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /You're unsubscribed/);
  }
  assert.ok(markOnDisk()[H].orgs[ORG]);
  const all = await post(BLOCK_ALL);
  assert.equal(all.status, 200);
  assert.match(await all.text(), /will no longer receive any marketing email sent via WoCo/);
  assert.ok(markOnDisk()[H].global);
});

for (const [label, arrange] of [
  ["an unreadable store refuses the write", () => writeFileSync(SUPPRESSION, "{ truncated")],
  ["the write fails", () => mkdirSync(WRITE_BLOCKER)],
] as const) {
  test(`unsubscribe: when ${label}, every POST shape answers 503 and never "done"`, async () => {
    arrange();
    for (const body of [ONE_CLICK, undefined, BLOCK_ALL]) {
      const res = await post(body);
      assert.equal(res.status, 503, `body ${body?.text ?? "(empty)"}`);
      assert.equal(res.headers.get("Retry-After"), "300");
      const html = await res.text();
      assert.match(html, TRY_AGAIN);
      assert.doesNotMatch(html, DONE);
    }
  });
}

test("unsubscribe: a blocked-all retry keeps the choice", async () => {
  writeFileSync(SUPPRESSION, "{ truncated");
  const html = await (await post(BLOCK_ALL)).text();
  assert.match(html, /<form method="post"><input type="hidden" name="all" value="1" \/><button type="submit">Try again<\/button><\/form>/);
});

test("unsubscribe: only the global mark failing still answers 503", async () => {
  // The organiser mark lands first; the global one then hits the blocker.
  assert.equal((await post()).status, 200);
  mkdirSync(WRITE_BLOCKER);
  const res = await post(BLOCK_ALL);
  assert.equal(res.status, 503);
  assert.doesNotMatch(await res.text(), DONE);
});

test("unsubscribe: a retry after a failed write is not reported done until it reaches disk", async () => {
  mkdirSync(WRITE_BLOCKER);
  assert.equal((await post()).status, 503);
  // The mark from the failed attempt is still in memory; it must not count as kept.
  assert.equal((await post()).status, 503);
  rmSync(WRITE_BLOCKER, { recursive: true });
  const res = await post();
  assert.equal(res.status, 200);
  assert.match(await res.text(), /You're unsubscribed/);
  assert.ok(markOnDisk()[H].orgs[ORG]);
});

test("unsubscribe: the confirm page records nothing, so it is unchanged", async () => {
  writeFileSync(SUPPRESSION, "{ truncated");
  const res = await unsubscribe.request(`/${token()}`);
  assert.equal(res.status, 200);
  assert.equal(readFileSync(SUPPRESSION, "utf-8"), "{ truncated");
});

// ── /api/marketing/suppress ───────────────────────────────────────────────

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf-8").digest("hex");

async function postSuppress(emails: string[]): Promise<{ status: number; json: Record<string, unknown> }> {
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
  const path = "/api/marketing/suppress";
  const text = JSON.stringify({ emails });
  const timestamp = String(Date.now());
  const reqNonce = randomUUID();
  const challenge = ["woco-session-v1", "POST", path, timestamp, reqNonce, sha256Hex(text)].join("\n");
  const resp = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Address": session.address,
      "X-Session-Delegation": Buffer.from(JSON.stringify({ message, parentSig }), "utf-8").toString("base64"),
      "X-Session-Sig": await session.signMessage(challenge),
      "X-Session-Nonce": reqNonce,
      "X-Session-Timestamp": timestamp,
    },
    body: text,
  });
  return { status: resp.status, json: (await resp.json()) as Record<string, unknown> };
}

test("/suppress: a recorded mark reads as done, exactly as before", async () => {
  const { status, json } = await postSuppress(["fan@example.com", "other@example.com"]);
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, data: { suppressed: 2 } });
  assert.ok(markOnDisk()[hashEmail("fan@example.com")]);
});

for (const [label, arrange] of [
  ["an unreadable store refuses the write", () => writeFileSync(SUPPRESSION, "{ truncated")],
  ["the write fails", () => mkdirSync(WRITE_BLOCKER)],
] as const) {
  test(`/suppress: when ${label}, it answers 503 and never "done"`, async () => {
    arrange();
    const { status, json } = await postSuppress(["fan@example.com"]);
    assert.equal(status, 503);
    assert.equal(json.ok, false);
    assert.match(String(json.error), TRY_AGAIN);
    assert.equal(json.data, undefined);
  });
}
