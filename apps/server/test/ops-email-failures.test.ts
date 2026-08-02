/**
 * The operator surface over the undelivered-email ledger.
 *
 * What these assert is mostly about what the endpoint REFUSES. It is the only
 * route in the codebase that can hand out buyer plaintext addresses, and it
 * authenticates with a shared secret rather than the wallet session delegation
 * everything else uses — so the failure modes worth pinning are "open when
 * unconfigured", "accepts a wrong token", and "leaks plaintext by default".
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EMAIL_HASH_SECRET = "test-secret-ops-failures";

let ops: typeof import("../src/routes/ops.js");
let ledger: typeof import("../src/lib/email/failure-ledger.js");

const TOKEN = "test-operator-token-0123456789";
const originalToken = process.env.OPS_TOKEN;

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-ops-test-")));
  ops = await import("../src/routes/ops.js");
  ledger = await import("../src/lib/email/failure-ledger.js");
});

after(() => {
  if (originalToken === undefined) delete process.env.OPS_TOKEN;
  else process.env.OPS_TOKEN = originalToken;
});

beforeEach(() => {
  ledger._resetForTest();
  process.env.OPS_TOKEN = TOKEN;
});

/** One abandoned paid ticket — the case the whole ledger exists for. */
function seedTransactionalFailure() {
  return ledger.recordFailure({
    kind: "transactional",
    recipients: ["buyer@example.com"],
    recipientHashes: ["hash-of-buyer"],
    subject: "Your ticket — Acme Night",
    provider: "ses",
    error: "MessageRejected",
    attempts: 3,
    retryable: false,
    context: { stripeSessionId: "cs_test_1", eventId: "evt_1" },
  });
}

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return ops.ops.request(path, init);
}

const authed = (path: string, init: RequestInit = {}) =>
  call(path, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${TOKEN}` } });

describe("ops ledger surface — auth", () => {
  test("refuses when OPS_TOKEN is unset, rather than serving openly", async () => {
    delete process.env.OPS_TOKEN;
    seedTransactionalFailure();
    const res = await authed("/email-failures");
    assert.equal(res.status, 503);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "OPS_DISABLED");
  });

  test("rejects a missing token", async () => {
    assert.equal((await call("/email-failures")).status, 401);
  });

  test("rejects a wrong token of the same length", async () => {
    // Same length so the comparison is the thing under test, not the guard.
    const wrong = "x".repeat(TOKEN.length);
    const res = await call("/email-failures", { headers: { Authorization: `Bearer ${wrong}` } });
    assert.equal(res.status, 401);
  });

  test("rejects a token that is merely a prefix of the real one", async () => {
    const res = await call("/email-failures", {
      headers: { Authorization: `Bearer ${TOKEN.slice(0, 8)}` },
    });
    assert.equal(res.status, 401);
  });
});

describe("ops ledger surface — reading", () => {
  test("withholds plaintext addresses unless reveal is asked for explicitly", async () => {
    seedTransactionalFailure();
    const res = await authed("/email-failures");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      data: { entries: Array<{ recipients: Array<{ hash: string; address?: string }> }> };
    };
    const [entry] = body.data.entries;
    assert.equal(entry?.recipients[0]?.hash, "hash-of-buyer", "triage still needs the hash");
    assert.equal(entry?.recipients[0]?.address, undefined, "a bare GET must not dump addresses");
  });

  test("reveal=1 returns the address, because chasing the buyer needs it", async () => {
    seedTransactionalFailure();
    const res = await authed("/email-failures?reveal=1");
    const body = (await res.json()) as {
      data: { entries: Array<{ recipients: Array<{ address?: string }> }> };
    };
    assert.equal(body.data.entries[0]?.recipients[0]?.address, "buyer@example.com");
  });

  test("unresolved only by default; includeResolved brings back the rest", async () => {
    const entry = seedTransactionalFailure();
    ledger.resolveFailure(entry.id, "ops@woco");

    const plain = (await (await authed("/email-failures")).json()) as { data: { count: number } };
    assert.equal(plain.data.count, 0);

    const all = (await (await authed("/email-failures?includeResolved=1")).json()) as {
      data: { count: number };
    };
    assert.equal(all.data.count, 1);
  });

  test("the response carries the same health verdict /api/health shows", async () => {
    seedTransactionalFailure();
    const body = (await (await authed("/email-failures")).json()) as {
      data: { health: { ok: boolean; unresolvedTransactional: number } };
    };
    assert.equal(body.data.health.ok, false);
    assert.equal(body.data.health.unresolvedTransactional, 1);
  });
});

describe("ops ledger surface — resolving", () => {
  test("resolving clears the health alarm", async () => {
    const entry = seedTransactionalFailure();
    assert.equal(ledger.failureHealth().ok, false);

    const res = await authed(`/email-failures/${entry.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ by: "nabil" }),
    });
    assert.equal(res.status, 200);
    assert.equal(ledger.failureHealth().ok, true);
    assert.equal(
      ledger.listFailures({ includeResolved: true })[0]?.resolvedBy,
      "nabil",
      "an alarm cleared by nobody in particular is an alarm nobody owns",
    );
  });

  test("`by` is required", async () => {
    const entry = seedTransactionalFailure();
    const res = await authed(`/email-failures/${entry.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.equal(ledger.failureHealth().ok, false, "the alarm must survive a malformed request");
  });

  test("an unknown id 404s rather than reporting success", async () => {
    const res = await authed("/email-failures/nope/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ by: "nabil" }),
    });
    assert.equal(res.status, 404);
  });

  test("resolving twice is not reported as two resolutions", async () => {
    const entry = seedTransactionalFailure();
    const post = () =>
      authed(`/email-failures/${entry.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ by: "nabil" }),
      });
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 404);
  });
});
