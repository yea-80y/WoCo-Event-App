/**
 * The background broadcast queue.
 *
 * These are the properties an organiser's trust rests on, not the mechanics:
 *
 *   1. NOBODY IS MAILED TWICE. Resume after a death, a replayed chunk, a
 *      duplicate address across two chunks — all must converge on one send.
 *   2. NOBODY IS SILENTLY MISSED. A lost chunk upload must fail the start, not
 *      produce a job that completes while a hundred people were never mailed.
 *   3. THE PLAINTEXT GOES AWAY. Chunks are unreadable at rest, deleted as they
 *      drain, and destroyed on a timer whether or not the job ever ran.
 *   4. A DEAD JOB IS LOUD. A restart mid-send is the #98 silent-failure shape
 *      at broadcast scale unless health says so.
 */

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EMAIL_HASH_SECRET = "test-secret-broadcast-queue";

let jobs: typeof import("../src/lib/email/broadcast-jobs.js");
let cap: typeof import("../src/lib/marketing/send-cap.js");
let root: string;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "woco-broadcast-queue-test-"));
  process.chdir(root);
  jobs = await import("../src/lib/email/broadcast-jobs.js");
  cap = await import("../src/lib/marketing/send-cap.js");
});

beforeEach(() => {
  jobs._resetForTest();
});

/** Deterministic stand-in for `hashEmail` — the real one needs the HMAC secret. */
const hash = (email: string) => `h:${email.trim().toLowerCase()}`;

const CHUNKS_DIR = () => join(process.cwd(), ".data", "broadcast-chunks");

function newJob(over: Partial<Parameters<typeof jobs.createJob>[0]> = {}) {
  return jobs.createJob({
    org: "0xOrganiser",
    kind: "marketing",
    subject: "Doors open at 8",
    html: "<p>see you there</p>",
    fromDisplayName: "Acme",
    fromAddress: "news@woco-net.com",
    ...over,
  });
}

const people = (n: number, prefix = "p") =>
  Array.from({ length: n }, (_, i) => ({ email: `${prefix}${i}@example.com` }));

// ---------------------------------------------------------------------------

describe("chunk upload", () => {
  test("recipients are unreadable on disk", () => {
    const job = newJob();
    jobs.appendChunk(job.id, [{ email: "buyer@example.com" }], hash);

    const files = readdirSync(CHUNKS_DIR());
    assert.equal(files.length, 1);
    const raw = readFileSync(join(CHUNKS_DIR(), files[0]!)).toString("utf-8");
    assert.ok(
      !raw.includes("buyer@example.com"),
      "a backup or VM snapshot that catches this file must catch ciphertext",
    );
    // And it round-trips through the in-process key.
    assert.deepEqual(jobs.readChunk(job.id, 0), [{ email: "buyer@example.com" }]);
  });

  test("a chunk cannot be replayed into a different slot", () => {
    const job = newJob();
    jobs.appendChunk(job.id, [{ email: "a@example.com" }], hash);

    // Copy chunk 0's ciphertext into slot 1. The AAD binds it to {jobId, index},
    // so opening it as chunk 1 must fail rather than quietly re-mailing chunk
    // 0's recipients — the failure a plain "encrypt the file" would not catch.
    copyFileSync(join(CHUNKS_DIR(), `${job.id}.0.bin`), join(CHUNKS_DIR(), `${job.id}.1.bin`));
    assert.throws(() => jobs.readChunk(job.id, 1), /auth/i);
    assert.deepEqual(jobs.readChunk(job.id, 0), [{ email: "a@example.com" }], "slot 0 still opens");
  });

  test("the same address in two chunks is accepted once", () => {
    const job = newJob();
    jobs.appendChunk(job.id, [{ email: "dup@example.com" }, { email: "a@example.com" }], hash);
    const second = jobs.appendChunk(
      job.id,
      [{ email: "DUP@example.com" }, { email: "b@example.com" }],
      hash,
    );
    assert.equal(second.skipped, 1, "sendMarketingBatch only dedupes within one call");
    assert.equal(second.accepted, 1);
    assert.equal(job.accepted, 3);
  });

  test("a chunk of nothing but duplicates writes no file", () => {
    const job = newJob();
    jobs.appendChunk(job.id, [{ email: "a@example.com" }], hash);
    const before = readdirSync(CHUNKS_DIR()).length;
    const result = jobs.appendChunk(job.id, [{ email: "a@example.com" }], hash);
    assert.equal(result.accepted, 0);
    assert.equal(readdirSync(CHUNKS_DIR()).length, before, "an empty chunk is not a chunk");
    assert.equal(job.chunkCount, 1, "and must not consume a chunk index");
  });

  test("a started job stops accepting recipients", () => {
    const job = newJob();
    jobs.appendChunk(job.id, people(3), hash);
    jobs.sealAndQueue(job.id, { chunkCount: 1, totalRecipients: 3 });
    assert.throws(
      () => jobs.appendChunk(job.id, people(1, "late"), hash),
      /not accepting recipients/,
    );
  });
});

describe("start", () => {
  test("refuses when the client uploaded less than it thinks it did", () => {
    // The failure this prevents: one chunk POST lost to a flaky connection, and
    // a job that drains, completes and reports success while a hundred people
    // were never mailed.
    const job = newJob();
    jobs.appendChunk(job.id, people(500), hash);
    assert.throws(
      () => jobs.sealAndQueue(job.id, { chunkCount: 2, totalRecipients: 1000 }),
      /Upload incomplete/,
    );
    assert.equal(jobs.getJob(job.id)?.state, "draft", "and nothing is queued");
  });

  test("refuses a job with no recipients", () => {
    const job = newJob();
    assert.throws(() => jobs.sealAndQueue(job.id, { chunkCount: 0, totalRecipients: 0 }), /No recipients/);
  });

  test("is idempotent — a double-click does not queue twice", () => {
    const job = newJob();
    jobs.appendChunk(job.id, people(5), hash);
    const first = jobs.sealAndQueue(job.id, { chunkCount: 1, totalRecipients: 5 });
    const second = jobs.sealAndQueue(job.id, { chunkCount: 1, totalRecipients: 5 });
    assert.equal(first.id, second.id);
    assert.equal(second.state, "queued");
  });

  test("the TTL is derived from the work, not fixed", () => {
    // A constant would fossilise today's list cap. 2x expected drain, floored so
    // a small job still has room to be scheduled and capped so "bounded in time"
    // stays true even if someone turns the send rate right down for warm-up.
    assert.equal(jobs.drainTtlMs(10, 12), 15 * 60_000, "floor");
    assert.equal(jobs.drainTtlMs(20_000, 12), Math.ceil((20_000 / 12) * 1000) * 2);
    assert.equal(jobs.drainTtlMs(20_000, 1), 4 * 60 * 60_000, "cap");
  });
});

describe("draining", () => {
  test("the record of what was sent is durable BEFORE the chunk is destroyed", () => {
    // Order is load-bearing. Deleting first and crashing before the persist
    // would lose who was mailed while the chunk is already gone — and a resume,
    // which skips on sentHashes, would re-deliver the lot.
    const job = newJob();
    jobs.appendChunk(job.id, people(2), hash);
    jobs.sealAndQueue(job.id, { chunkCount: 1, totalRecipients: 2 });

    jobs.recordChunkDrained(job, {
      sent: 2,
      suppressed: 0,
      failed: 0,
      sentHashes: [hash("p0@example.com"), hash("p1@example.com")],
      errors: [],
    });

    assert.equal(existsSync(join(CHUNKS_DIR(), `${job.id}.0.bin`)), false, "chunk destroyed");
    // Read the file back, not the in-memory object: the point is that it landed.
    const onDisk = JSON.parse(
      readFileSync(join(process.cwd(), ".data", "broadcast-jobs", `${job.id}.json`), "utf-8"),
    ) as { sentHashes: string[]; nextChunk: number; state: string };
    assert.equal(onDisk.sentHashes.length, 2);
    assert.equal(onDisk.nextChunk, 1);
    assert.equal(onDisk.state, "running");
  });

  test("finishing destroys every remaining chunk", () => {
    const job = newJob();
    jobs.appendChunk(job.id, people(3, "a"), hash);
    jobs.appendChunk(job.id, people(3, "b"), hash);
    jobs.sealAndQueue(job.id, { chunkCount: 2, totalRecipients: 6 });
    assert.equal(readdirSync(CHUNKS_DIR()).length, 2);

    jobs.cancelJob(job);
    assert.equal(
      readdirSync(CHUNKS_DIR()).length,
      0,
      "a cancel that leaves recipients on disk is not a cancel",
    );
    assert.equal(job.state, "cancelled");
  });

  test("runnable jobs exclude the finished, the expired and the fully drained", () => {
    const live = newJob();
    jobs.appendChunk(live.id, people(2, "live"), hash);
    jobs.sealAndQueue(live.id, { chunkCount: 1, totalRecipients: 2 });

    const done = newJob();
    jobs.appendChunk(done.id, people(2, "done"), hash);
    jobs.sealAndQueue(done.id, { chunkCount: 1, totalRecipients: 2 });
    jobs.finishJob(done, "completed");

    const ids = jobs.runnableJobs().map((j) => j.id);
    assert.deepEqual(ids, [live.id]);
  });
});

describe("resume", () => {
  test("a resumed job skips everyone the dead one already mailed", () => {
    const first = newJob();
    jobs.appendChunk(first.id, people(4), hash);
    jobs.sealAndQueue(first.id, { chunkCount: 1, totalRecipients: 4 });
    jobs.recordChunkDrained(first, {
      sent: 2,
      suppressed: 0,
      failed: 0,
      sentHashes: [hash("p0@example.com"), hash("p1@example.com")],
      errors: [],
    });
    jobs.finishJob(first, "died", "restart");

    // The organiser re-uploads the SAME list — they have no way to know which
    // half went out, and should not have to.
    const second = newJob({ resumeOf: first.id });
    const result = jobs.appendChunk(second.id, people(4), hash);
    assert.equal(result.skipped, 2, "p0 and p1 already have the email");
    assert.equal(result.accepted, 2);
    assert.deepEqual(
      jobs.readChunk(second.id, 0)?.map((r) => r.email),
      ["p2@example.com", "p3@example.com"],
    );
  });

  test("a resume of a job that sent nothing mails everyone", () => {
    const first = newJob();
    jobs.appendChunk(first.id, people(3), hash);
    jobs.sealAndQueue(first.id, { chunkCount: 1, totalRecipients: 3 });
    jobs.finishJob(first, "died", "restart before any chunk drained");

    const second = newJob({ resumeOf: first.id });
    assert.equal(jobs.appendChunk(second.id, people(3), hash).accepted, 3);
  });
});

describe("restart", () => {
  test("kills in-flight jobs, destroys the payload, and says how many were missed", () => {
    const job = newJob();
    jobs.appendChunk(job.id, people(10), hash);
    jobs.sealAndQueue(job.id, { chunkCount: 1, totalRecipients: 10 });
    jobs.recordChunkDrained(job, {
      sent: 4, suppressed: 0, failed: 0,
      sentHashes: people(4).map((p) => hash(p.email)),
      errors: [],
    });

    jobs._reloadForTest(); // memory dropped, disk kept — a process restart
    const killed = jobs.reconcileOnBoot();

    assert.equal(killed.length, 1);
    assert.equal(killed[0]!.state, "died");
    assert.match(killed[0]!.reason ?? "", /6 recipient\(s\) were not mailed/);
    assert.equal(readdirSync(CHUNKS_DIR()).length, 0, "the payload cannot be read anyway");
  });

  test("a died job is an ALARM, not a statistic", () => {
    const job = newJob();
    jobs.appendChunk(job.id, people(10), hash);
    jobs.sealAndQueue(job.id, { chunkCount: 1, totalRecipients: 10 });
    jobs._reloadForTest();
    jobs.reconcileOnBoot();

    const health = jobs.broadcastQueueHealth();
    assert.equal(health.diedUnresumed, 1);
    assert.equal(health.ok, false, "an organiser whose announcement stopped halfway must be visible");
  });

  test("resuming a died job clears the alarm", () => {
    const job = newJob();
    jobs.appendChunk(job.id, people(10), hash);
    jobs.sealAndQueue(job.id, { chunkCount: 1, totalRecipients: 10 });
    jobs._reloadForTest();
    jobs.reconcileOnBoot();

    newJob({ resumeOf: job.id });
    assert.equal(jobs.broadcastQueueHealth().ok, true);
  });

  test("a job that was already finished is left alone", () => {
    const job = newJob();
    jobs.appendChunk(job.id, people(2), hash);
    jobs.sealAndQueue(job.id, { chunkCount: 1, totalRecipients: 2 });
    jobs.finishJob(job, "completed");

    jobs._reloadForTest();
    assert.equal(jobs.reconcileOnBoot().length, 0);
    assert.equal(jobs.getJob(job.id)?.state, "completed");
  });
});

describe("the TTL sweep", () => {
  test("destroys an abandoned draft's recipients", () => {
    // The case nothing else visits: an organiser uploads three chunks and closes
    // the tab. Without the sweep those addresses sit on disk until a restart.
    const job = newJob();
    jobs.appendChunk(job.id, people(5), hash);
    assert.equal(readdirSync(CHUNKS_DIR()).length, 1);

    const later = Date.now() + 16 * 60_000;
    const expired = jobs.sweep(later);

    assert.equal(expired.length, 1);
    assert.equal(jobs.getJob(job.id)?.state, "expired");
    assert.equal(readdirSync(CHUNKS_DIR()).length, 0);
  });

  test("leaves a draft that is still being uploaded to", () => {
    const job = newJob();
    jobs.appendChunk(job.id, people(5), hash);
    assert.equal(jobs.sweep(Date.now() + 60_000).length, 0, "a slow upload is not an abandoned one");
  });

  test("expires a started job that ran past its limit", () => {
    const job = newJob();
    jobs.appendChunk(job.id, people(5), hash);
    jobs.sealAndQueue(job.id, { chunkCount: 1, totalRecipients: 5 });
    const expired = jobs.sweep(Date.now() + 5 * 60 * 60_000);
    assert.equal(expired.length, 1);
    assert.equal(readdirSync(CHUNKS_DIR()).length, 0);
  });

  test("drops hash-only records once they are past retention", () => {
    const job = newJob();
    jobs.appendChunk(job.id, people(2), hash);
    jobs.sealAndQueue(job.id, { chunkCount: 1, totalRecipients: 2 });
    jobs.finishJob(job, "completed");

    jobs.sweep(Date.now() + 8 * 24 * 60 * 60_000);
    assert.equal(jobs.getJob(job.id), null, "the resume window is 7 days, not forever");
  });
});

describe("the daily-cap reservation", () => {
  test("a reservation is corrected to what the job actually sent", () => {
    // Without this a job killed at 5% leaves the whole 20,000 reserved, the cap
    // reads zero, and the organiser cannot resume for 24 hours — the accounting
    // for a failure blocking the remedy for it.
    const org = "0xcaporg";
    cap.reserveSend(org, 20_000, "job-1");
    assert.equal(cap.capRemaining(org, 20_000), 0);

    assert.equal(cap.reconcileReservation(org, "job-1", 1_000), true);
    assert.equal(cap.capRemaining(org, 20_000), 19_000);
  });

  test("reconciling an unknown job changes nothing", () => {
    const org = "0xcaporg2";
    cap.reserveSend(org, 100, "job-a");
    assert.equal(cap.reconcileReservation(org, "job-b", 0), false);
    assert.equal(cap.capRemaining(org, 2_000), 1_900);
  });

  test("an ordinary send is not reconcilable — only reservations are", () => {
    const org = "0xcaporg3";
    cap.recordSend(org, 50);
    assert.equal(cap.reconcileReservation(org, "job-x", 0), false);
  });
});

describe("ownership and bounds", () => {
  test("jobs are listed per organiser", () => {
    const mine = newJob({ org: "0xMe" });
    newJob({ org: "0xThem" });
    assert.deepEqual(jobs.listJobsForOrg("0xme").map((j) => j.id), [mine.id]);
  });

  test("a job cannot exceed the chunk ceiling", () => {
    const job = newJob();
    for (let i = 0; i < jobs.MAX_CHUNKS; i++) {
      jobs.appendChunk(job.id, [{ email: `c${i}@example.com` }], hash);
    }
    assert.throws(() => jobs.appendChunk(job.id, [{ email: "over@example.com" }], hash), /Too many chunks/);
  });

  test("the chunk bound never binds before the recipient cap does", () => {
    // The trap this closes: a fixed MAX_CHUNKS becomes a SECOND, lower ceiling
    // that #101 would not think to move when it raises the list cap, and a
    // 150,000-contact organiser would hit a limit nothing documents.
    assert.ok(
      jobs.MAX_CHUNKS * jobs.MAX_CHUNK_RECIPIENTS > jobs.MAX_JOB_RECIPIENTS,
      "chunk capacity must exceed the recipient cap, not sit under it",
    );
  });
});
