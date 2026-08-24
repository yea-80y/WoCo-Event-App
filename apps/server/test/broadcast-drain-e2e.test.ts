/**
 * A whole broadcast, end to end, through the real worker.
 *
 * The unit tests cover the store and the queue in isolation. This one asserts
 * the acceptance criterion from #100 directly — a 20,000-recipient broadcast
 * completes, with every message going through the real compliance path
 * (`sendMarketingBatch`: suppression, RFC 8058 headers, provenance footer) and
 * no HTTP request held open — plus the three properties that only appear once
 * the pieces run together: fair scheduling, the account-level stop, and
 * resume-without-double-sending.
 *
 * Only the final hop to the ESP is faked. Everything above it is production code.
 */

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OutboundEmail } from "../src/lib/email/types.js";

process.env.EMAIL_HASH_SECRET = "test-secret-broadcast-e2e";
process.env.PUBLIC_API_BASE = "https://events-api.example.com";
process.env.MARKETING_POSTAL_ADDRESS = "WoCo Ltd, 1 Test Street, London";

let jobs: typeof import("../src/lib/email/broadcast-jobs.js");
let worker: typeof import("../src/lib/email/drain-worker.js");
let suppression: typeof import("../src/lib/marketing/suppression-store.js");
let hashEmail: (email: string) => string;

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-broadcast-e2e-")));
  jobs = await import("../src/lib/email/broadcast-jobs.js");
  worker = await import("../src/lib/email/drain-worker.js");
  suppression = await import("../src/lib/marketing/suppression-store.js");
  ({ hashEmail } = await import("../src/lib/event/claim-service.js"));
});

/** Records what the ESP would have been asked to send. */
function recorder(reject?: (to: string) => string | null) {
  const sent: OutboundEmail[] = [];
  return {
    sent,
    deps: {
      async send(msg: OutboundEmail) {
        const why = reject?.(msg.to[0]!);
        if (why) throw new Error(why);
        sent.push(msg);
      },
    },
  };
}

const CHUNKS_DIR = () => join(process.cwd(), ".data", "broadcast-chunks");

function seed(recipients: Array<{ email: string }>, over: Record<string, unknown> = {}) {
  const job = jobs.createJob({
    org: "0xorganiser",
    kind: "marketing",
    subject: "Doors open at 8",
    html: "<p>See you there</p>",
    fromDisplayName: "Acme",
    fromAddress: "news@woco-net.com",
    ...over,
  } as Parameters<typeof jobs.createJob>[0]);

  let chunks = 0;
  for (let i = 0; i < recipients.length; i += jobs.MAX_CHUNK_RECIPIENTS) {
    const r = jobs.appendChunk(
      job.id,
      recipients.slice(i, i + jobs.MAX_CHUNK_RECIPIENTS),
      hashEmail,
    );
    if (r.accepted > 0) chunks++;
  }
  jobs.sealAndQueue(job.id, { chunkCount: chunks, totalRecipients: job.accepted });
  return job;
}

const people = (n: number, prefix = "p") =>
  Array.from({ length: n }, (_, i) => ({ email: `${prefix}${i}@example.com` }));

/** Runs the worker until nothing is left to drain. */
async function drainAll(): Promise<void> {
  for (let i = 0; i < 500 && jobs.runnableJobs().length > 0; i++) {
    await worker._pumpOnceForTest();
  }
}

beforeEach(() => {
  jobs._resetForTest();
});

describe("a broadcast, end to end", () => {
  test("20,000 recipients complete, with no request held open", async () => {
    // The acceptance criterion. Inline this took ~28 minutes against a 125s
    // origin timeout and could not be made to fit at any send rate.
    const rec = recorder();
    worker._resetDrainWorkerForTest(rec.deps);

    const job = seed(people(20_000));
    assert.equal(job.accepted, 20_000);
    assert.equal(job.chunkCount, 40);

    await drainAll();

    const final = jobs.getJob(job.id)!;
    assert.equal(final.state, "completed");
    assert.equal(final.sent, 20_000);
    assert.equal(rec.sent.length, 20_000);
    assert.equal(new Set(rec.sent.map((m) => m.to[0])).size, 20_000, "and nobody twice");
    assert.equal(readdirSync(CHUNKS_DIR()).length, 0, "with no recipients left on disk");
  });

  test("every message still carries the compliance headers", async () => {
    // The queue must not become a way around `sendMarketingBatch`. If a future
    // change sends from the worker directly, this is what catches it.
    const rec = recorder();
    worker._resetDrainWorkerForTest(rec.deps);
    seed(people(3, "compliance"));
    await drainAll();

    for (const msg of rec.sent) {
      assert.match(msg.headers?.["List-Unsubscribe"] ?? "", /^<https:\/\/.+\/u\/.+>$/);
      assert.equal(msg.headers?.["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
      assert.match(msg.html ?? "", /unsubscribe/i);
      assert.match(msg.text ?? "", /WoCo Ltd, 1 Test Street, London/, "CAN-SPAM postal address");
    }
    assert.equal(
      new Set(rec.sent.map((m) => m.headers?.["List-Unsubscribe"])).size,
      3,
      "each recipient gets their own unsubscribe token",
    );
  });

  test("someone who unsubscribes mid-send is spared the later chunks", async () => {
    // Better than the inline path managed: suppression is re-checked per chunk
    // at DRAIN time, so an unsubscribe during a half-hour send is honoured.
    const sent: string[] = [];
    worker._resetDrainWorkerForTest({
      async send(msg) {
        sent.push(msg.to[0]!);
        // They hit unsubscribe while chunk 1 was going out. Suppression is
        // re-read at the top of every chunk, so chunk 2 must honour it.
        if (msg.to[0] === "late100@example.com") {
          suppression.suppressGlobal(hashEmail("late900@example.com"), "unsubscribe");
        }
      },
    });
    const job = seed(people(1_000, "late"));

    await drainAll();

    const final = jobs.getJob(job.id)!;
    assert.ok(final.suppressed >= 1, "the unsubscribe must take effect on the remaining chunks");
    assert.ok(
      !sent.includes("late900@example.com"),
      "and they must not receive it",
    );
    assert.equal(final.sent + final.suppressed + final.failed, final.accepted, "the ledger adds up");
  });
});

describe("fairness", () => {
  test("an attendee broadcast is not parked behind a marketing blast", async () => {
    // Strict FIFO would put a 200-attendee "the doors have moved" behind a
    // stranger's 20,000-contact promotion for half an hour.
    const rec = recorder();
    worker._resetDrainWorkerForTest(rec.deps);

    seed(people(5_000, "bulk"), { org: "0xbulk" });
    const urgent = seed(people(200, "attendee"), {
      org: "0xvenue",
      kind: "event",
      eventId: "evt_1",
    });

    // Two passes of the worker: enough to finish the small event job long before
    // the ten-chunk marketing job is anywhere near done.
    await worker._pumpOnceForTest();

    assert.equal(jobs.getJob(urgent.id)?.state, "completed");
    assert.ok(
      rec.sent.findIndex((m) => m.to[0]?.startsWith("attendee")) <
        rec.sent.findLastIndex((m) => m.to[0]?.startsWith("bulk")),
      "the attendee mail went out before the blast finished",
    );
  });
});

describe("event membership", () => {
  test("an unverifiable series without Stripe verification says the RIGHT no", async () => {
    // The organiser's recipients may well hold tickets — an on-chain series
    // records the claimer only inside the sealed order blob, so the server
    // cannot check. Telling them "these people have not claimed a ticket" sends
    // them to fix the wrong problem. (#82 item 3.)
    const job = jobs.createJob({
      org: "0xvenue",
      kind: "event",
      eventId: "evt_onchain",
      subject: "Doors moved",
      html: "<p>7pm</p>",
      fromDisplayName: "Venue",
      fromAddress: "news@woco-net.com",
      attendees: { hashes: new Set<string>(), hasUnverifiableSeries: true },
    });
    const snapshot = jobs.attendeeSnapshot(job.id);
    assert.equal(snapshot?.hasUnverifiableSeries, true);
    assert.ok(
      !("allowUnproven" in (snapshot as object)),
      "allowUnproven is gone (#387) — it granted permission from a data source #207 deleted",
    );
  });
});

describe("stopping", () => {
  test("an account-level failure stops the job instead of grinding through it", async () => {
    // Sending paused or the daily quota exhausted: 19,000 more attempts would
    // burn the retry budget and delay the only thing that helps, which is an
    // operator noticing.
    const rec = recorder(() => "SES SendingPausedException: account sending is paused");
    worker._resetDrainWorkerForTest(rec.deps);
    const job = seed(people(2_000, "paused"));

    await drainAll();

    const final = jobs.getJob(job.id)!;
    assert.equal(final.state, "died");
    assert.match(final.reason ?? "", /paused|quota/i);
    assert.ok(final.nextChunk < final.chunkCount, "it stopped early rather than running to the end");
    assert.equal(readdirSync(CHUNKS_DIR()).length, 0, "and destroyed the recipients it never used");
  });

  /**
   * Reachable because the marketing from-address is now mandatory (#96): that
   * guard checks a value is PRESENT, and presence is not verification. A typo,
   * or setting it before DNS propagates, rejects every single message — and
   * before this it was not an account-level stop, so a 20,000-recipient job
   * would have ground through all 20,000 rejections one at a time.
   */
  for (const [label, message] of [
    ["an unverified sending domain", "SES MailFromDomainNotVerifiedException: domain is not verified"],
    [
      "an unverified from-address",
      "SES MessageRejected: Email address is not verified. The following identities failed the check in region EU-WEST-1: news@news.woco-net.com",
    ],
    // Resend words it differently. It is the rollback lever and is scheduled
    // for deletion, but a stop that quietly stops working the moment you pull
    // the lever is worse than no stop.
    [
      "an unverified domain on the Resend rollback path",
      "Resend validation_error: The news.woco-net.com domain is not verified. Please, add and verify your domain on https://resend.com/domains",
    ],
  ] as const) {
    test(`${label} stops the job rather than rejecting every recipient`, async () => {
      const rec = recorder(() => message);
      worker._resetDrainWorkerForTest(rec.deps);
      const job = seed(people(2_000, "unverified"));

      await drainAll();

      const final = jobs.getJob(job.id)!;
      assert.equal(final.state, "died");
      assert.match(final.reason ?? "", /not verified/i);
      assert.doesNotMatch(
        final.reason ?? "",
        /paused|quota/i,
        "an operator must not be told to wait for a quota that was never the problem",
      );
      assert.ok(final.nextChunk < final.chunkCount, "it stopped early rather than running to the end");
      assert.equal(readdirSync(CHUNKS_DIR()).length, 0, "and destroyed the recipients it never used");
    });
  }

  /**
   * The stop only fires when EVERY attempted recipient failed the same way.
   * One rejection among successes is a bad address, not an outage, and killing
   * a healthy broadcast over it would be far worse than the grind it prevents.
   */
  test("a lone rejection among successes does not stop the job", async () => {
    const rec = recorder((to) =>
      to === "bad0@example.com" ? "SES MessageRejected: Email address is not verified" : null,
    );
    worker._resetDrainWorkerForTest(rec.deps);
    const job = seed([{ email: "bad0@example.com" }, ...people(30, "ok")]);

    await drainAll();

    const final = jobs.getJob(job.id)!;
    assert.equal(final.state, "completed");
    assert.equal(final.sent, 30);
    assert.equal(final.failed, 1);
  });

  test("stored errors carry the hash, never the address", async () => {
    const rec = recorder((to) => (to === "bad0@example.com" ? "MessageRejected" : null));
    worker._resetDrainWorkerForTest(rec.deps);
    const job = seed([{ email: "bad0@example.com" }, ...people(3, "ok")]);

    await drainAll();

    const final = jobs.getJob(job.id)!;
    assert.equal(final.failed, 1);
    assert.equal(final.sent, 3);
    for (const err of final.errors) {
      assert.ok(!err.includes("bad0@example.com"), "a persisted broadcast error is not a plaintext store");
    }
    assert.equal(final.resumable ?? true, true);
  });

  test("a resumed job mails only the people who missed it", async () => {
    const first = recorder((to) => (to.startsWith("miss") ? "MessageRejected" : null));
    worker._resetDrainWorkerForTest(first.deps);
    const dead = seed([...people(4, "got"), ...people(2, "miss")]);
    await drainAll();
    assert.equal(jobs.getJob(dead.id)?.sent, 4);

    // The organiser presses "send to the 2 who missed it", which re-uploads the
    // same list — they have no way to know which of them went out.
    const second = recorder();
    worker._resetDrainWorkerForTest(second.deps);
    const retry = jobs.createJob({
      org: "0xorganiser",
      kind: "marketing",
      subject: "Doors open at 8",
      html: "<p>See you there</p>",
      fromDisplayName: "Acme",
      fromAddress: "news@woco-net.com",
      resumeOf: dead.id,
    });
    const appended = jobs.appendChunk(retry.id, [...people(4, "got"), ...people(2, "miss")], hashEmail);
    assert.equal(appended.skipped, 4, "the four who already have it are dropped at upload");
    jobs.sealAndQueue(retry.id, { chunkCount: 1, totalRecipients: 2 });
    await drainAll();

    assert.deepEqual(
      second.sent.map((m) => m.to[0]).sort(),
      ["miss0@example.com", "miss1@example.com"],
    );
  });
});
