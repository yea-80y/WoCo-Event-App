/**
 * The delivery guarantees around a send, not the send itself.
 *
 * These cover the production failure this work exists to fix: `stripe.ts` fired
 * ticket email with `.catch(console.error)`, so a buyer could pay, the send
 * could fail, and the only record was a log line nobody read. Three properties
 * have to hold together for that to be fixed:
 *
 *   1. a transient failure is RETRIED rather than counted as failed;
 *   2. a permanent failure is NOT retried (and not failed over), because it
 *      would fail identically and just delay the record;
 *   3. whatever we finally abandon lands in the durable ledger.
 *
 * The rate limiter is tested with an injected clock and scheduler so the
 * assertions are deterministic rather than timing-dependent.
 */

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RateLimiter,
  QueueOverflowError,
  effectiveSendRate,
  DEFAULT_SEND_RATE,
} from "../src/lib/email/rate-limiter.js";
import { EmailSendError, type EmailProvider, type OutboundEmail } from "../src/lib/email/types.js";

process.env.EMAIL_HASH_SECRET = "test-secret-email-delivery";

// The failure ledger writes .data/ relative to cwd — chdir before importing it.
let send: typeof import("../src/lib/email/send.js");
let ledger: typeof import("../src/lib/email/failure-ledger.js");

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-email-delivery-test-")));
  send = await import("../src/lib/email/send.js");
  ledger = await import("../src/lib/email/failure-ledger.js");
});

beforeEach(() => {
  ledger._resetForTest();
});

const MSG: OutboundEmail = {
  from: '"Acme" <events@woco-net.com>',
  to: ["buyer@example.com"],
  subject: "Your ticket",
  html: "<p>ticket</p>",
};

/** A provider that fails a set number of times, then succeeds. */
function flakyProvider(name: string, failures: number, err: () => EmailSendError) {
  const calls: number[] = [];
  const provider: EmailProvider = {
    name,
    async send() {
      calls.push(Date.now());
      if (calls.length <= failures) throw err();
      return;
    },
  };
  return { provider, get callCount() { return calls.length; } };
}

const retryable = () => new EmailSendError("throttled", { retryable: true, code: "TooManyRequestsException" });
const permanent = () => new EmailSendError("rejected", { retryable: false, code: "MessageRejected" });

/** No real waiting — backoff timing is not what these assert. */
const noSleep = async () => {};

describe("retry", () => {
  test("a transient failure is retried and the message goes out", async () => {
    const primary = flakyProvider("ses", 2, retryable);
    await send.sendVia({ primary: primary.provider, secondary: null, sleep: noSleep }, MSG, {
      maxAttempts: 3,
    });
    assert.equal(primary.callCount, 3);
    assert.equal(ledger.listFailures().length, 0, "a delivered message must not be ledgered");
  });

  test("a permanent failure is NOT retried", async () => {
    const primary = flakyProvider("ses", 99, permanent);
    await assert.rejects(
      send.sendVia({ primary: primary.provider, secondary: null, sleep: noSleep }, MSG, { maxAttempts: 3 }),
      /rejected/,
    );
    assert.equal(primary.callCount, 1, "retrying a rejected address wastes the retry budget");
  });

  test("exhausting retries rejects — the caller still learns it failed", async () => {
    const primary = flakyProvider("ses", 99, retryable);
    await assert.rejects(
      send.sendVia({ primary: primary.provider, secondary: null, sleep: noSleep }, MSG, { maxAttempts: 3 }),
      /throttled/,
    );
    assert.equal(primary.callCount, 3);
  });

  test("an empty recipient list is rejected without calling the provider", async () => {
    const primary = flakyProvider("ses", 0, retryable);
    await assert.rejects(
      send.sendVia({ primary: primary.provider, secondary: null, sleep: noSleep }, { ...MSG, to: [] }),
      /no recipients/,
    );
    assert.equal(primary.callCount, 0);
  });
});

describe("failover", () => {
  test("transactional mail fails over to the secondary when the primary is down", async () => {
    const primary = flakyProvider("ses", 99, retryable);
    const secondary = flakyProvider("resend", 0, retryable);
    await send.sendVia(
      { primary: primary.provider, secondary: secondary.provider, sleep: noSleep },
      MSG,
      { maxAttempts: 2, priority: "transactional" },
    );
    assert.equal(primary.callCount, 2);
    assert.equal(secondary.callCount, 1);
    assert.equal(ledger.listFailures().length, 0);
  });

  test("MARKETING never fails over — it would exhaust the free tier and burn a cold domain", async () => {
    const primary = flakyProvider("ses", 99, retryable);
    const secondary = flakyProvider("resend", 0, retryable);
    await assert.rejects(
      send.sendVia({ primary: primary.provider, secondary: secondary.provider, sleep: noSleep }, MSG, {
        maxAttempts: 2,
        priority: "marketing",
      }),
    );
    assert.equal(secondary.callCount, 0, "a broadcast must never touch the failover provider");
  });

  test("a PERMANENT primary failure does not fail over", async () => {
    // The secondary would reject the same message for the same reason.
    const primary = flakyProvider("ses", 99, permanent);
    const secondary = flakyProvider("resend", 0, retryable);
    await assert.rejects(
      send.sendVia({ primary: primary.provider, secondary: secondary.provider, sleep: noSleep }, MSG, {
        maxAttempts: 3,
      }),
    );
    assert.equal(secondary.callCount, 0);
  });

  test("when both providers fail the ledger names both", async () => {
    const primary = flakyProvider("ses", 99, retryable);
    const secondary = flakyProvider("resend", 99, retryable);
    await assert.rejects(
      send.sendVia({ primary: primary.provider, secondary: secondary.provider, sleep: noSleep }, MSG, {
        maxAttempts: 1,
      }),
    );
    const [entry] = ledger.listFailures();
    assert.ok(entry);
    assert.equal(entry.provider, "ses→resend", "an operator must know which dashboard to open");
  });
});

describe("failure ledger", () => {
  test("an abandoned transactional send is recorded with the recipient", async () => {
    const primary = flakyProvider("ses", 99, retryable);
    await assert.rejects(
      send.sendVia({ primary: primary.provider, secondary: null, sleep: noSleep }, MSG, {
        maxAttempts: 1,
        context: { stripeSessionId: "cs_test_123", eventId: "evt_1" },
      }),
      // The thrown error is MARKED as ledgered: paid-ticket fulfilment (#314)
      // reads this to know it must not write a second row — and to know that
      // an error WITHOUT the mark never reached the mailer and needs one.
      (err: unknown) => err instanceof EmailSendError && err.ledgered === true,
    );
    const [entry] = ledger.listFailures();
    assert.ok(entry);
    assert.equal(entry.kind, "transactional");
    // Plaintext is kept here on purpose: nothing else on disk can recover the
    // buyer's address, so a hash-only record would be unactionable.
    assert.equal(entry.recipients[0]?.address, "buyer@example.com");
    assert.equal(entry.context?.stripeSessionId, "cs_test_123");
    assert.equal(entry.subject, "Your ticket");
  });

  test("a noLedger send (drain worker) throws WITHOUT the ledgered mark", async () => {
    const primary = flakyProvider("ses", 99, retryable);
    await assert.rejects(
      send.sendVia({ primary: primary.provider, secondary: null, sleep: noSleep }, MSG, {
        maxAttempts: 1,
        noLedger: true,
      }),
      (err: unknown) => err instanceof EmailSendError && err.ledgered === false,
    );
    assert.equal(ledger.listFailures().length, 0);
  });

  test("an abandoned MARKETING send keeps the hash only, never the address", async () => {
    const primary = flakyProvider("ses", 99, retryable);
    await assert.rejects(
      send.sendVia({ primary: primary.provider, secondary: null, sleep: noSleep }, MSG, {
        maxAttempts: 1,
        priority: "marketing",
      }),
    );
    const [entry] = ledger.listFailures();
    assert.ok(entry);
    assert.equal(entry.kind, "marketing");
    assert.equal(entry.recipients[0]?.address, undefined, "the marketing path must not store plaintext");
    assert.ok((entry.recipients[0]?.hash ?? "").length > 0);
  });

  test("health goes NOT-ok on an unresolved transactional failure", async () => {
    assert.equal(ledger.failureHealth().ok, true);
    const primary = flakyProvider("ses", 99, retryable);
    await assert.rejects(
      send.sendVia({ primary: primary.provider, secondary: null, sleep: noSleep }, MSG, { maxAttempts: 1 }),
    );
    const health = ledger.failureHealth();
    assert.equal(health.ok, false, "one buyer with no ticket is already an incident");
    assert.equal(health.unresolvedTransactional, 1);
  });

  test("a marketing failure alone does not flip health", async () => {
    const primary = flakyProvider("ses", 99, retryable);
    await assert.rejects(
      send.sendVia({ primary: primary.provider, secondary: null, sleep: noSleep }, MSG, {
        maxAttempts: 1,
        priority: "marketing",
      }),
    );
    assert.equal(ledger.failureHealth().ok, true);
    assert.equal(ledger.failureHealth().unresolved, 1);
  });

  test("resolving an entry clears it from the unresolved view and health", async () => {
    const primary = flakyProvider("ses", 99, retryable);
    await assert.rejects(
      send.sendVia({ primary: primary.provider, secondary: null, sleep: noSleep }, MSG, { maxAttempts: 1 }),
    );
    const [entry] = ledger.listFailures();
    assert.ok(entry);
    assert.equal(ledger.resolveFailure(entry.id, "ops@woco"), true);
    assert.equal(ledger.listFailures().length, 0);
    assert.equal(ledger.failureHealth().ok, true);
    assert.equal(ledger.resolveFailure(entry.id, "ops@woco"), false, "resolving twice is a no-op");
  });

  test("entries survive a reload from disk", async () => {
    const primary = flakyProvider("ses", 99, retryable);
    await assert.rejects(
      send.sendVia({ primary: primary.provider, secondary: null, sleep: noSleep }, MSG, { maxAttempts: 1 }),
    );
    ledger._reloadForTest(); // models a process restart: memory dropped, disk kept
    assert.equal(ledger.listFailures().length, 1, "the ledger is worthless if a restart empties it");
  });
});

/**
 * The ledger is evidence, not telemetry. Two properties follow from that and
 * were wrong on merge (SES_MIGRATION_HANDOVER §4a rows 9 and 10): it must name
 * every addressee, and its attempt count must be what we actually did.
 */
describe("the ledger as an evidence record", () => {
  const MULTI: OutboundEmail = { ...MSG, to: ["one@example.com", "two@example.com"] };

  test("every addressee is recorded, not just the first", async () => {
    const primary = flakyProvider("ses", 99, permanent);
    await assert.rejects(
      send.sendVia({ primary: primary.provider, secondary: null, sleep: noSleep }, MULTI, {
        maxAttempts: 1,
      }),
    );
    const [entry] = ledger.listFailures();
    assert.equal(entry?.recipients.length, 2, "recipient 2..n must not vanish from the record");
    assert.deepEqual(
      entry!.recipients.map((r) => r.address),
      ["one@example.com", "two@example.com"],
    );
  });

  test("erasure removes ONE subject's address and leaves their co-addressee's", async () => {
    const primary = flakyProvider("ses", 99, permanent);
    await assert.rejects(
      send.sendVia({ primary: primary.provider, secondary: null, sleep: noSleep }, MULTI, {
        maxAttempts: 1,
      }),
    );
    const [before] = ledger.listFailures();
    assert.equal(ledger.eraseRecipient(before!.recipients[0]!.hash), 1);

    const after = ledger.listFailures({ includeResolved: true }).find((e) => e.id === before!.id);
    assert.equal(after?.recipients[0]?.address, undefined, "the requester's address must go");
    assert.equal(
      after?.recipients[1]?.address,
      "two@example.com",
      "the other person made no request and is still owed their ticket",
    );
  });

  test("attempts counts real provider calls across primary AND failover", async () => {
    const primary = flakyProvider("ses", 99, retryable);
    const secondary = flakyProvider("resend", 99, retryable);
    await assert.rejects(
      send.sendVia({ primary: primary.provider, secondary: secondary.provider, sleep: noSleep }, MSG, {
        maxAttempts: 3,
      }),
    );
    const [entry] = ledger.listFailures();
    assert.equal(primary.callCount + secondary.callCount, 6);
    assert.equal(entry?.attempts, 6, "the old `retryable ? maxAttempts : 1` under-reported by half");
  });

  test("a permanent failure records one attempt, because one is what we made", async () => {
    const primary = flakyProvider("ses", 99, permanent);
    await assert.rejects(
      send.sendVia({ primary: primary.provider, secondary: null, sleep: noSleep }, MSG, {
        maxAttempts: 5,
      }),
    );
    assert.equal(ledger.listFailures()[0]?.attempts, 1);
  });

  test("a queue overflow records ZERO attempts — the provider was never called", async () => {
    const primary = flakyProvider("ses", 0, retryable);
    await assert.rejects(
      send.sendVia(
        {
          primary: primary.provider,
          secondary: null,
          sleep: noSleep,
          acquire: async () => { throw new QueueOverflowError(10_000); },
        },
        MSG,
        { maxAttempts: 1 },
      ),
    );
    assert.equal(primary.callCount, 0);
    assert.equal(
      ledger.listFailures()[0]?.attempts,
      0,
      "claiming an attempt we never made would send an operator to the SES console for nothing",
    );
  });

  test("an entry written by the single-recipient version still loads", async () => {
    // The file is live in production. A loader that treated the old shape as
    // malformed would drop evidence of an undelivered paid ticket.
    const legacy = [
      {
        id: "legacy-1",
        ts: new Date().toISOString(),
        kind: "transactional",
        recipient: "old@example.com",
        recipientHash: "abc123",
        subject: "Your ticket",
        provider: "resend",
        error: "boom",
        attempts: 3,
        retryable: true,
      },
    ];
    writeFileSync(join(process.cwd(), ".data", "email-failures.json"), JSON.stringify(legacy));
    ledger._reloadForTest();

    const [entry] = ledger.listFailures();
    assert.deepEqual(entry?.recipients, [{ hash: "abc123", address: "old@example.com" }]);
    assert.equal(ledger.eraseRecipient("abc123"), 1, "and erasure must still reach it");
  });
});

describe("regressions found in review", () => {
  test("a rate-limiter queue overflow is LEDGERED, not thrown past recordFailure", async () => {
    // The acquire() call sat outside the try, so a QueueOverflowError skipped
    // the ledger entirely and landed in the Stripe webhook's console.error —
    // re-creating the exact silently-lost ticket this module exists to prevent.
    const overflowing: EmailProvider = {
      name: "ses",
      async send() {
        throw new Error("never reached");
      },
    };
    await assert.rejects(
      send.sendVia(
        {
          primary: overflowing,
          secondary: null,
          sleep: noSleep,
          acquire: async () => { throw new QueueOverflowError(10_000); },
        },
        MSG,
        { maxAttempts: 1 },
      ),
    );
    const [entry] = ledger.listFailures();
    assert.ok(entry, "the overflow must reach the ledger");
    assert.equal(entry.kind, "transactional");
    assert.match(entry.error, /queue is full/i);
  });

  test("a marketing flood cannot evict an unresolved transactional failure", async () => {
    // Newest-1000 pruning meant one failed 1,000-recipient broadcast pushed
    // every transactional entry out and flipped failureHealth() back to ok.
    // Cap shrunk so the flood is 30 writes, not 1,200. Each write fsyncs the
    // whole array, so flooding at the real 1,000 cap is O(n^2) and takes ~100s.
    ledger._setMaxEntriesForTest(20);
    // Always-fails: `flakyProvider(_, 99, _)` would start SUCCEEDING on call 100.
    const failing = flakyProvider("ses", Number.MAX_SAFE_INTEGER, retryable);
    const deps = { primary: failing.provider, secondary: null, sleep: noSleep };

    await assert.rejects(
      send.sendVia(deps, { ...MSG, to: ["paid@example.com"] }, { maxAttempts: 1 }),
    );
    assert.equal(ledger.failureHealth().unresolvedTransactional, 1);

    for (let i = 0; i < 30; i++) {
      await assert.rejects(
        send.sendVia(deps, { ...MSG, to: [`bulk${i}@example.com`] }, {
          maxAttempts: 1,
          priority: "marketing",
        }),
      );
    }

    const health = ledger.failureHealth();
    assert.equal(health.unresolvedTransactional, 1, "the paid ticket must survive the flood");
    assert.equal(health.ok, false, "and the alarm must stay lit");
    const survivor = ledger.listFailures({ limit: 5000 }).find((e) => e.recipients.some((r) => r.address === "paid@example.com"));
    assert.ok(survivor, "with the recipient still recoverable");
  });

  test("erasure redacts the plaintext recipient but keeps the operational record", async () => {
    const failing = flakyProvider("ses", 99, retryable);
    await assert.rejects(
      send.sendVia({ primary: failing.provider, secondary: null, sleep: noSleep }, MSG, { maxAttempts: 1 }),
    );
    const [before] = ledger.listFailures();
    assert.equal(before?.recipients[0]?.address, "buyer@example.com");

    assert.equal(ledger.eraseRecipient(before!.recipients[0]!.hash), 1);

    const all = ledger.listFailures({ includeResolved: true });
    const after = all.find((e) => e.id === before!.id);
    assert.ok(after);
    assert.equal(after.recipients[0]?.address, undefined, "plaintext must be gone");
    assert.equal(after.recipients[0]?.hash, before!.recipients[0]!.hash, "the hash stays so re-erasure matches");
    assert.equal(after.resolvedBy, "erasure");
    assert.equal(ledger.failureHealth().ok, true, "an erased subject cannot be chased, so the alarm clears");
  });

  test("erasing an address we hold no failures for is a no-op", () => {
    assert.equal(ledger.eraseRecipient("0".repeat(64)), 0);
  });

  /**
   * Providers quote the address back inside the error string, so `error` was a
   * second, unerasable copy of the plaintext — one that reached marketing
   * entries (hash-only by policy), the redacted ops list, and docker logs.
   */
  test("a provider diagnostic naming the address is redacted before it is stored", async () => {
    const quoting = flakyProvider(
      "ses",
      99,
      () =>
        new EmailSendError(
          "SES MessageRejected: smtp; 550 5.1.1 <buyer@example.com>: Recipient address rejected",
          { retryable: false, code: "MessageRejected" },
        ),
    );
    await assert.rejects(
      send.sendVia({ primary: quoting.provider, secondary: null, sleep: noSleep }, MSG, {
        maxAttempts: 1,
      }),
    );

    const [entry] = ledger.listFailures();
    assert.ok(entry);
    assert.ok(!entry.error.includes("buyer@example.com"), "no plaintext address in `error`");
    assert.match(entry.error, /\[address-redacted\]/);
    assert.match(entry.error, /550 5\.1\.1/, "the diagnostic itself is still legible");
    assert.equal(
      entry.recipients[0]?.address,
      "buyer@example.com",
      "the recipient field still carries it — that is the field erasure can reach",
    );
  });

  test("erasure leaves nothing behind once the diagnostic is redacted", async () => {
    const quoting = flakyProvider(
      "ses",
      99,
      () => new EmailSendError("SES: recipient buyer@example.com does not exist", { retryable: false }),
    );
    await assert.rejects(
      send.sendVia({ primary: quoting.provider, secondary: null, sleep: noSleep }, MSG, {
        maxAttempts: 1,
      }),
    );
    const [entry] = ledger.listFailures();
    ledger.eraseRecipient(entry!.recipients[0]!.hash);

    const after = ledger.listFailures({ includeResolved: true }).find((e) => e.id === entry!.id);
    const serialised = JSON.stringify(after);
    assert.ok(
      !serialised.includes("buyer@example.com"),
      "an Art. 17 request must not report success while a copy survives in `error`",
    );
  });

  /**
   * On the async path `error` is the receiving MTA's diagnostic, relayed
   * through an SNS envelope that may be 256KB. The first version of this
   * redaction used an unbounded `+` before the `@` and backtracked
   * quadratically — 97 seconds of blocked event loop on 200KB, which stalls
   * every claim and Stripe webhook on this single-threaded server.
   */
  test("a hostile diagnostic cannot stall the server", () => {
    const hostile = "a".repeat(200_000);
    const started = process.hrtime.bigint();
    ledger.recordFailure({
      kind: "marketing",
      recipients: ["x@example.com"],
      recipientHashes: ["h"],
      subject: "s",
      provider: "ses",
      error: hostile,
      attempts: 1,
      retryable: false,
    });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 1000, `redaction took ${Math.round(ms)}ms — the quantifier bound is gone`);
  });

  test("unicode and domain-literal addresses are redacted too", () => {
    const entry = ledger.recordFailure({
      kind: "marketing",
      recipients: ["x@example.com"],
      recipientHashes: ["h"],
      subject: "s",
      provider: "ses",
      error: "failed for naïve.üser@exämple.com and for user@[10.0.0.1]",
      attempts: 1,
      retryable: false,
    });
    assert.ok(!entry.error.includes("exämple.com"));
    assert.ok(!entry.error.includes("10.0.0.1"));
  });

  test("a retry's error string is redacted too", async () => {
    const quoting = flakyProvider("ses", 99, retryable);
    await assert.rejects(
      send.sendVia({ primary: quoting.provider, secondary: null, sleep: noSleep }, MSG, { maxAttempts: 1 }),
    );
    const [entry] = ledger.listFailures();
    ledger.bumpRetry(entry!.id, "still failing for buyer@example.com");

    const after = ledger.listFailures().find((e) => e.id === entry!.id);
    assert.ok(!after!.error.includes("buyer@example.com"));
  });
});

describe("rate limiter", () => {
  /** Controllable clock + scheduler so no test waits on wall-clock time. */
  function harness(ratePerSecond: number, burst?: number) {
    let now = 0;
    const pending: Array<{ fn: () => void; at: number }> = [];
    const limiter = new RateLimiter({
      ratePerSecond,
      ...(burst !== undefined ? { burst } : {}),
      now: () => now,
      schedule: (fn, ms) => pending.push({ fn, at: now + ms }),
    });
    /** Advance time and run every callback that has come due. */
    const advance = async (ms: number) => {
      now += ms;
      const due = pending.filter((p) => p.at <= now);
      pending.length = 0;
      for (const p of due) p.fn();
      await Promise.resolve();
      await Promise.resolve();
    };
    return { limiter, advance };
  }

  test("the initial burst is admitted immediately", async () => {
    const { limiter } = harness(10, 3);
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    assert.equal(limiter.stats().waiting, 0);
  });

  test("a caller past the burst waits for a token", async () => {
    const { limiter, advance } = harness(10, 1);
    await limiter.acquire();

    let admitted = false;
    void limiter.acquire().then(() => { admitted = true; });
    await Promise.resolve();
    assert.equal(admitted, false, "the second caller must not overrun the rate");

    // 10/s means one token per 100ms.
    await advance(100);
    assert.equal(admitted, true);
  });

  test("transactional overtakes marketing regardless of arrival order", async () => {
    const { limiter, advance } = harness(10, 1);
    await limiter.acquire(); // consume the burst

    const order: string[] = [];
    void limiter.acquire("marketing").then(() => order.push("marketing"));
    void limiter.acquire("marketing").then(() => order.push("marketing"));
    void limiter.acquire("transactional").then(() => order.push("transactional"));
    await Promise.resolve();

    await advance(100);
    // The paid ticket goes first even though a broadcast queued ahead of it.
    assert.equal(order[0], "transactional");
  });

  test("stats report queue depth by priority", async () => {
    const { limiter } = harness(10, 1);
    await limiter.acquire();
    void limiter.acquire("marketing");
    void limiter.acquire("transactional");
    await Promise.resolve();
    const stats = limiter.stats();
    assert.equal(stats.marketing, 1);
    assert.equal(stats.transactional, 1);
    assert.equal(stats.waiting, 2);
  });

  test("the queue is bounded rather than growing without limit", async () => {
    let now = 0;
    const limiter = new RateLimiter({
      ratePerSecond: 1,
      burst: 1,
      maxQueueDepth: 2,
      now: () => now,
      schedule: () => {},
    });
    await limiter.acquire();
    void limiter.acquire().catch(() => {});
    void limiter.acquire().catch(() => {});
    await assert.rejects(limiter.acquire(), (err: unknown) => {
      assert.ok(err instanceof QueueOverflowError);
      return true;
    });
  });

  test("a non-positive rate is rejected at construction", () => {
    // Otherwise the bucket never refills and every send hangs forever.
    assert.throws(() => new RateLimiter({ ratePerSecond: 0 }), /must be > 0/);
  });
});
