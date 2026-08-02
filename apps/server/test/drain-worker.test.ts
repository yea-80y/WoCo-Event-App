/**
 * The retry queue that replaced the second ESP.
 *
 * `docs/SES_MIGRATION_HANDOVER.md` §3a: a Resend failover is not an
 * availability strategy — Resend runs on SES in another region, and its free
 * tier delivers the first 100 messages and ledgers the rest, which is worse
 * than a clean failure. A worker that retries with backoff keeps all reputation
 * on one domain and covers the outage shape that actually happens.
 *
 * The property that costs the most if wrong is the LEDGER ONE: a retry must
 * update the existing entry, never write another. Five backoff rounds over a
 * thirty-message outage would otherwise be 150 records, each transactional one
 * carrying its own plaintext copy of a buyer's address and each exempt from the
 * size cap.
 */

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EmailSendError, type OutboundEmail } from "../src/lib/email/types.js";

process.env.EMAIL_HASH_SECRET = "test-secret-drain-worker";

let send: typeof import("../src/lib/email/send.js");
let ledger: typeof import("../src/lib/email/failure-ledger.js");
let queue: typeof import("../src/lib/email/retry-queue.js");

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-drain-worker-test-")));
  send = await import("../src/lib/email/send.js");
  ledger = await import("../src/lib/email/failure-ledger.js");
  queue = await import("../src/lib/email/retry-queue.js");
});

beforeEach(() => {
  ledger._resetForTest();
  queue._resetRetryQueueForTest();
});

const MSG: OutboundEmail = {
  from: '"Acme" <events@woco-net.com>',
  to: ["buyer@example.com"],
  subject: "Your ticket",
  html: "<p>ticket</p>",
};

const retryable = () => new EmailSendError("throttled", { retryable: true, code: "TooManyRequestsException" });
const permanent = () => new EmailSendError("rejected", { retryable: false, code: "MessageRejected" });
const noSleep = async () => {};

function alwaysFails(err: () => EmailSendError) {
  return { name: "ses", async send() { throw err(); } };
}

describe("what gets queued for retry", () => {
  test("an abandoned transient send is queued with its message", async () => {
    await assert.rejects(
      send.sendVia({ primary: alwaysFails(retryable), secondary: null, sleep: noSleep }, MSG, {
        maxAttempts: 1,
      }),
    );
    assert.equal(queue.retryQueueStats().pending, 1);
  });

  test("a PERMANENT failure is not queued — it would fail identically forever", async () => {
    await assert.rejects(
      send.sendVia({ primary: alwaysFails(permanent), secondary: null, sleep: noSleep }, MSG, {
        maxAttempts: 1,
      }),
    );
    assert.equal(ledger.listFailures().length, 1, "still recorded for a human");
    assert.equal(queue.retryQueueStats().pending, 0, "but not retried");
  });

  test("the worker's own re-send does not queue itself back in", async () => {
    // `noLedger` is what the drain worker passes. Without it every retry would
    // both write a fresh entry AND enqueue itself, growing without bound.
    await assert.rejects(
      send.sendVia({ primary: alwaysFails(retryable), secondary: null, sleep: noSleep }, MSG, {
        maxAttempts: 1,
        noLedger: true,
      }),
    );
    assert.equal(ledger.listFailures().length, 0);
    assert.equal(queue.retryQueueStats().pending, 0);
  });

  test("the queue is bounded by bytes, because attachments dominate", () => {
    // "1,000 messages" is meaningless as a bound: a ticket email carries a
    // ~100KB composite PNG, a plain one carries nothing.
    const heavy: OutboundEmail = {
      ...MSG,
      attachments: [
        {
          filename: "ticket.png",
          content: Buffer.alloc(6 * 1024 * 1024),
          contentType: "image/png",
        },
      ],
    };
    let accepted = 0;
    for (let i = 0; i < 10; i++) {
      if (queue.enqueueRetry(`entry-${i}`, heavy, "transactional")) accepted++;
    }
    assert.ok(accepted >= 3 && accepted <= 4, `expected ~25MB worth, queued ${accepted}`);
    assert.ok(queue.retryQueueStats().bytes <= 25 * 1024 * 1024);
  });
});

describe("backoff", () => {
  test("nothing is due immediately — the point is to wait out the outage", () => {
    queue.enqueueRetry("e1", MSG, "transactional", 0);
    assert.equal(queue.takeDue(0).length, 0);
    assert.equal(queue.takeDue(60_000).length, 1);
  });

  test("each failure pushes the next attempt further out", () => {
    queue.enqueueRetry("e1", MSG, "transactional", 0);
    const [item] = queue.takeDue(queue.RETRY_SCHEDULE_MS[0]!);
    assert.ok(item);

    assert.equal(queue.requeue(item!, 0), true);
    assert.equal(queue.takeDue(queue.RETRY_SCHEDULE_MS[0]!).length, 0, "step 2 is not due yet");
    assert.equal(queue.takeDue(queue.RETRY_SCHEDULE_MS[1]!).length, 1);
  });

  test("the schedule ends rather than retrying forever", () => {
    queue.enqueueRetry("e1", MSG, "transactional", 0);
    const [item] = queue.takeDue(Number.MAX_SAFE_INTEGER);
    assert.ok(item);
    for (let i = 1; i < queue.RETRY_SCHEDULE_MS.length; i++) {
      assert.equal(queue.requeue(item!, 0), true, `step ${i} should be scheduled`);
      queue.takeDue(Number.MAX_SAFE_INTEGER);
    }
    assert.equal(
      queue.requeue(item!, 0),
      false,
      "a message still undeliverable after two hours needs a human, not a sixth attempt",
    );
  });

  test("resolving by hand drops the pending retry", () => {
    // Otherwise a backoff timer fires after the operator has already resent by
    // hand, and the buyer gets the same ticket twice.
    queue.enqueueRetry("e1", MSG, "transactional", 0);
    queue.enqueueRetry("e2", MSG, "transactional", 0);
    queue.forgetRetries("e1");
    assert.equal(queue.retryQueueStats().pending, 1);
    assert.equal(queue.takeDue(Number.MAX_SAFE_INTEGER)[0]?.entryId, "e2");
  });
});

describe("the ledger under retry", () => {
  test("a failed retry updates the ONE entry rather than adding another", async () => {
    await assert.rejects(
      send.sendVia({ primary: alwaysFails(retryable), secondary: null, sleep: noSleep }, MSG, {
        maxAttempts: 1,
      }),
    );
    const [entry] = ledger.listFailures();
    assert.equal(entry?.attempts, 1);

    ledger.bumpRetry(entry!.id, "throttled again");
    ledger.bumpRetry(entry!.id, "and again");

    const after = ledger.listFailures();
    assert.equal(after.length, 1, "one incident stays one row");
    assert.equal(after[0]?.retries, 2);
    assert.equal(after[0]?.attempts, 3, "each retry is a real provider call");
    assert.equal(after[0]?.error, "and again", "the latest error, not the first");
    assert.ok(after[0]?.lastRetryAt);
  });

  test("a resolved entry cannot be bumped", () => {
    const entry = ledger.recordFailure({
      kind: "transactional",
      recipients: ["b@example.com"],
      recipientHashes: ["h1"],
      subject: "Your ticket",
      provider: "ses",
      error: "boom",
      attempts: 1,
      retryable: true,
    });
    ledger.resolveFailure(entry.id, "ops");
    assert.equal(ledger.bumpRetry(entry.id, "late retry"), false);
  });

  test("a delivered retry resolves the entry and clears the alarm", async () => {
    await assert.rejects(
      send.sendVia({ primary: alwaysFails(retryable), secondary: null, sleep: noSleep }, MSG, {
        maxAttempts: 1,
      }),
    );
    const [entry] = ledger.listFailures();
    assert.equal(ledger.failureHealth().ok, false);

    // What the worker does on a successful re-send.
    ledger.resolveFailure(entry!.id, "drain-worker");
    queue.forgetRetries(entry!.id);

    assert.equal(ledger.failureHealth().ok, true);
    assert.equal(
      ledger.listFailures({ includeResolved: true })[0]?.resolvedBy,
      "drain-worker",
      "and the record says who delivered it",
    );
  });
});

describe("what does NOT go in the retry queue", () => {
  test("a failed broadcast recipient is left to the job's own resume", async () => {
    // The double-send this prevents: an SES throttle fails 30 recipients
    // mid-chunk, the retry queue delivers them 60s later, their hashes never
    // reach the job's sentHashes — so the UI offers "send to the 30 who missed
    // it" and the organiser mails them a second time. A broadcast already has a
    // retry mechanism and it is the resume.
    await assert.rejects(
      send.sendVia({ primary: alwaysFails(retryable), secondary: null, sleep: noSleep }, MSG, {
        maxAttempts: 1,
        priority: "marketing",
      }),
    );
    assert.equal(ledger.listFailures().length, 1, "still recorded");
    assert.equal(
      queue.retryQueueStats().pending,
      0,
      "but never redelivered outside the job that owns it",
    );
  });

  test("a transactional failure still is queued — that is the case this exists for", async () => {
    await assert.rejects(
      send.sendVia({ primary: alwaysFails(retryable), secondary: null, sleep: noSleep }, MSG, {
        maxAttempts: 1,
        priority: "transactional",
      }),
    );
    assert.equal(queue.retryQueueStats().pending, 1);
  });
});
