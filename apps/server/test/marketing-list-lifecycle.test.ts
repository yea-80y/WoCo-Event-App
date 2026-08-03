/**
 * The audience list must be able to reach every state it can leave — including
 * empty (#136).
 *
 * Two properties are asserted here, and they pull in opposite directions on
 * purpose:
 *
 *   1. CONTENT never refuses a write. Every list change re-uploads the WHOLE
 *      list, so an all-or-nothing format check turns one unmailable row into a
 *      permanent freeze on delete, rename and add alike.
 *   2. SHAPE still does. An array of at most the cap — that is the caller's
 *      contract, and relaxing it would let a malformed body through as an empty
 *      list, silently erasing an audience.
 *
 * The `/check` case is the live one: `claims.ts` admits a claim address on
 * `includes("@")` alone, so a buyer with `bob@localhost` used to 400 the whole
 * "Add from your events" scan before it could import anybody.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { TypedDataEncoder, Wallet } from "ethers";

const HOST = "test.woco.local";
process.env.ALLOWED_HOSTS = HOST;
process.env.EMAIL_HASH_SECRET = "test-secret-list-lifecycle";

const MAX = 20_000;

let normalizeEmails: typeof import("../src/lib/marketing/emails.js").normalizeEmails;
let putList: typeof import("../src/lib/marketing/list-store.js").putList;
let hashEmail: typeof import("../src/lib/event/claim-service.js").hashEmail;
let suppressOrg: typeof import("../src/lib/marketing/suppression-store.js").suppressOrg;
let app: Hono;

let SESSION_DOMAIN: typeof import("@woco/shared").SESSION_DOMAIN;
let SESSION_TYPES: typeof import("@woco/shared").SESSION_TYPES;
let SESSION_PURPOSE: typeof import("@woco/shared").SESSION_PURPOSE;
let SESSION_EXPIRY_MS: typeof import("@woco/shared").SESSION_EXPIRY_MS;

before(async () => {
  // The stores write .data/ relative to cwd — never touch the real one.
  process.chdir(mkdtempSync(join(tmpdir(), "woco-list-lifecycle-test-")));
  ({ normalizeEmails } = await import("../src/lib/marketing/emails.js"));
  ({ putList } = await import("../src/lib/marketing/list-store.js"));
  ({ hashEmail } = await import("../src/lib/event/claim-service.js"));
  ({ suppressOrg } = await import("../src/lib/marketing/suppression-store.js"));
  ({ SESSION_DOMAIN, SESSION_TYPES, SESSION_PURPOSE, SESSION_EXPIRY_MS } = await import("@woco/shared"));

  const { marketing } = await import("../src/routes/marketing.js");
  app = new Hono();
  app.route("/api/marketing", marketing);
});

// ── The normaliser ──────────────────────────────────────────────────────────

test("an empty array is a state, not malformed input", () => {
  const out = normalizeEmails([], MAX);
  assert.deepEqual(out, { emails: [], unmailable: [], unmailableCount: 0, droppedCount: 0 });
});

test("shape and size are still refused", () => {
  assert.equal(normalizeEmails(undefined, MAX), null);
  assert.equal(normalizeEmails("a@b.com", MAX), null);
  assert.equal(normalizeEmails({ 0: "a@b.com", length: 1 }, MAX), null);
  assert.equal(normalizeEmails(new Array(MAX + 1).fill("a@b.com"), MAX), null);
  assert.notEqual(normalizeEmails(new Array(MAX).fill("a@b.com"), MAX), null);
});

test("one unmailable row keeps the rest — the freeze this replaces", () => {
  const out = normalizeEmails(["a@b.com", "bob@localhost", "c@d.com"], MAX);
  assert.ok(out);
  assert.deepEqual(out.emails, ["a@b.com", "bob@localhost", "c@d.com"]);
  assert.deepEqual(out.unmailable, ["bob@localhost"]);
  assert.equal(out.unmailableCount, 1);
});

test("addresses are trimmed and lowercased, duplicates preserved", () => {
  const out = normalizeEmails(["  Bob@Example.COM ", "bob@example.com"], MAX);
  assert.ok(out);
  // Deduping belongs to the caller, which hashes into a Set — collapsing here
  // would make the reported count disagree with what was sent.
  assert.deepEqual(out.emails, ["bob@example.com", "bob@example.com"]);
  assert.equal(out.unmailableCount, 0);
});

test("non-string entries are counted, never echoed", () => {
  const out = normalizeEmails(["a@b.com", 42, null, { email: "x@y.com" }], MAX);
  assert.ok(out);
  assert.deepEqual(out.emails, ["a@b.com"]);
  assert.equal(out.droppedCount, 3);
  assert.equal(out.unmailableCount, 0);
  assert.deepEqual(out.unmailable, []);
});

test("the unmailable sample is capped but the count is not", () => {
  const bad = Array.from({ length: 25 }, (_, i) => `bad-${i}`);
  const out = normalizeEmails(bad, MAX);
  assert.ok(out);
  assert.equal(out.unmailable.length, 10);
  assert.equal(out.unmailableCount, 25);
});

// ── The /check endpoint, end to end through requireAuth ─────────────────────

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf-8").digest("hex");

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
  return { parent, session, delegation: { message, parentSig } };
}

async function postAs(
  d: Awaited<ReturnType<typeof mintDelegation>>,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
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
  return { status: resp.status, json: (await resp.json()) as Record<string, unknown> };
}

test("/check answers for the whole batch when one address is unmailable", async () => {
  const d = await mintDelegation();
  const org = d.parent.address.toLowerCase();

  putList(org, {
    swarmRef: "00".repeat(32),
    count: 1,
    updatedAt: new Date().toISOString(),
    emailHashes: [hashEmail("stored@example.com")],
  });
  suppressOrg(hashEmail("gone@example.com"), org, "unsub");

  const { status, json } = await postAs(d, "/api/marketing/check", {
    emails: ["stored@example.com", "bob@localhost", "gone@example.com"],
  });

  assert.equal(status, 200);
  const data = json.data as { suppressed: string[]; alreadyInList: string[] };
  assert.deepEqual(data.alreadyInList, ["stored@example.com"]);
  assert.deepEqual(data.suppressed, ["gone@example.com"]);
});

test("/check still refuses a body that is not an array", async () => {
  const d = await mintDelegation();
  const { status, json } = await postAs(d, "/api/marketing/check", { emails: "a@b.com" });
  assert.equal(status, 400);
  assert.match(String(json.error), /array of at most/);
});

test("/suppress refuses an empty array — there is no 'suppress nobody'", async () => {
  const d = await mintDelegation();
  const { status } = await postAs(d, "/api/marketing/suppress", { emails: [] });
  assert.equal(status, 400);
});

test("/suppress honours an unmailable address rather than refusing the call", async () => {
  const d = await mintDelegation();
  const { status, json } = await postAs(d, "/api/marketing/suppress", {
    emails: ["bob@localhost"],
  });
  assert.equal(status, 200);
  assert.deepEqual(json.data, { suppressed: 1 });
});
