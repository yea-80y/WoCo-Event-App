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
  ops._resetOpsLockoutForTest();
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
    assert.equal(res.status, 404, "unconfigured must never mean unguarded");
  });

  test("rejects a missing token", async () => {
    assert.equal((await call("/email-failures")).status, 404);
  });

  test("rejects a wrong token of the same length", async () => {
    // Same length so the comparison is the thing under test, not the guard.
    const wrong = "x".repeat(TOKEN.length);
    const res = await call("/email-failures", { headers: { Authorization: `Bearer ${wrong}` } });
    assert.equal(res.status, 404);
  });

  test("rejects a token that is merely a prefix of the real one", async () => {
    const res = await call("/email-failures", {
      headers: { Authorization: `Bearer ${TOKEN.slice(0, 8)}` },
    });
    assert.equal(res.status, 404);
  });

  test("a flood of wrong tokens cannot lock the real operator out", async () => {
    // The first version counted failures BEFORE checking the token, so ten bad
    // requests a minute shut the door on everyone — an unauthenticated attacker
    // could disable the remediation surface during exactly the incident it
    // exists for. Guessing is throttled; the operator is never denied.
    const wrong = { headers: { Authorization: `Bearer ${"x".repeat(TOKEN.length)}` } };
    for (let i = 0; i < 12; i++) {
      assert.equal((await call("/email-failures", wrong)).status, 404);
    }
    assert.equal(
      (await authed("/email-failures")).status,
      200,
      "the operator must still get in while somebody is hammering the door",
    );
  });
});

describe("ops ledger surface — reading", () => {
  test("the list NEVER carries plaintext, whatever is asked for", async () => {
    seedTransactionalFailure();
    for (const q of ["", "?reveal=1", "?includeResolved=1"]) {
      const res = await authed(`/email-failures${q}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        data: { entries: Array<{ recipients: Array<{ hash: string; address?: string }> }> };
      };
      const [entry] = body.data.entries;
      assert.equal(entry?.recipients[0]?.hash, "hash-of-buyer", "triage still needs the hash");
      assert.equal(
        entry?.recipients[0]?.address,
        undefined,
        `polling the queue must not disclose addresses (query "${q}")`,
      );
    }
  });

  test("the per-entry route returns the address, because chasing the buyer needs it", async () => {
    const entry = seedTransactionalFailure();
    const res = await authed(`/email-failures/${entry.id}/recipients`);
    const body = (await res.json()) as {
      data: { recipients: Array<{ address?: string }>; context?: Record<string, string> };
    };
    assert.equal(body.data.recipients[0]?.address, "buyer@example.com");
    assert.equal(body.data.context?.stripeSessionId, "cs_test_1", "with the order it belongs to");
  });

  test("an erased entry yields the hash and no address, not an error", async () => {
    const entry = seedTransactionalFailure();
    ledger.eraseRecipient("hash-of-buyer");
    const res = await authed(`/email-failures/${entry.id}/recipients`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { recipients: Array<{ address?: string }> } };
    assert.equal(body.data.recipients[0]?.address, undefined);
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

/**
 * The ledger acquired a second writer with #99: every permanent bounce now
 * writes an entry, and unresolved transactional entries are exempt from the
 * size cap. A bad list — or a burst of unauthenticated email claims to bouncing
 * addresses — leaves an operator with dozens of red rows and, until now, one
 * POST each to clear them, during the incident.
 */
describe("ops ledger surface — bulk resolve", () => {
  const bulk = (body: unknown) =>
    authed("/email-failures/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  test("clears many entries and the alarm with them", async () => {
    const ids = [seedTransactionalFailure(), seedTransactionalFailure(), seedTransactionalFailure()]
      .map((e) => e.id);
    assert.equal(ledger.failureHealth().ok, false);

    const res = await bulk({ ids, by: "nabil" });
    const json = (await res.json()) as { data: { resolved: number; skipped: number } };
    assert.equal(res.status, 200);
    assert.equal(json.data.resolved, 3);
    assert.equal(json.data.skipped, 0);
    assert.equal(ledger.failureHealth().ok, true);
  });

  test("already-resolved and unknown ids are skipped, not failed", async () => {
    const entry = seedTransactionalFailure();
    await bulk({ ids: [entry.id], by: "nabil" });

    const res = await bulk({ ids: [entry.id, "no-such-id"], by: "nabil" });
    const json = (await res.json()) as { data: { resolved: number; skipped: number } };
    assert.equal(json.data.resolved, 0);
    assert.equal(json.data.skipped, 2);
  });

  test("`by` is required — an alarm cleared by nobody is an alarm nobody owns", async () => {
    const entry = seedTransactionalFailure();
    assert.equal((await bulk({ ids: [entry.id] })).status, 400);
    assert.equal(ledger.failureHealth().ok, false, "and nothing was resolved");
  });

  test("an empty or non-array ids list is refused", async () => {
    assert.equal((await bulk({ ids: [], by: "nabil" })).status, 400);
    assert.equal((await bulk({ ids: "all", by: "nabil" })).status, 400);
  });

  /** Explicit ids only: the operator has to have looked at the list. */
  test("the batch is bounded", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    assert.equal((await bulk({ ids, by: "nabil" })).status, 400);
  });

  test("it needs the ops token like everything else here", async () => {
    const entry = seedTransactionalFailure();
    const res = await call("/email-failures/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [entry.id], by: "nabil" }),
    });
    assert.equal(res.status, 404);
    assert.equal(ledger.failureHealth().ok, false);
  });
});
