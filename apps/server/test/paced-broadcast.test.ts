/**
 * A paced marketing send (#619), end to end through the real worker, with the
 * clock mocked so an hour between batches takes no time.
 *
 * Only the final hop to the ESP is faked. The job store, the worker, the
 * pacing ledger and the compliance path are production code.
 */

import { test, describe, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OutboundEmail } from "../src/lib/email/types.js";
import type { SendEmailOptions } from "../src/lib/email/send.js";

process.env.EMAIL_HASH_SECRET = "test-secret-paced-broadcast";
process.env.PUBLIC_API_BASE = "https://events-api.example.com";
process.env.MARKETING_POSTAL_ADDRESS = "WoCo Ltd, 1 Test Street, London";

let jobs: typeof import("../src/lib/email/broadcast-jobs.js");
let worker: typeof import("../src/lib/email/drain-worker.js");
let pacing: typeof import("../src/lib/sender-pacing/index.js");
let glue: typeof import("../src/lib/email/broadcast-pacing.js");
let consent: typeof import("../src/lib/marketing/consent-store.js");
let cap: typeof import("../src/lib/marketing/send-cap.js");
let shared: typeof import("@woco/shared");
let hashEmail: (email: string) => string;

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-paced-broadcast-")));
  jobs = await import("../src/lib/email/broadcast-jobs.js");
  worker = await import("../src/lib/email/drain-worker.js");
  pacing = await import("../src/lib/sender-pacing/index.js");
  glue = await import("../src/lib/email/broadcast-pacing.js");
  consent = await import("../src/lib/marketing/consent-store.js");
  cap = await import("../src/lib/marketing/send-cap.js");
  shared = await import("@woco/shared");
  ({ hashEmail } = await import("../src/lib/event/claim-service.js"));
});

const ORG = "0xabcd000000000000000000000000000000000619";
const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-09-22T09:00:00Z");

let sent: Array<{ to: string; ctx: Record<string, string> | undefined }>;

beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: T0 });
  jobs._resetForTest();
  pacing._resetPacingForTest();
  sent = [];
  worker._resetDrainWorkerForTest({
    async send(msg: OutboundEmail, opts?: SendEmailOptions) {
      sent.push({ to: msg.to[0]!, ctx: opts?.context });
    },
  });
});

afterEach(() => {
  mock.timers.reset();
});

const people = (n: number, p: string) => Array.from({ length: n }, (_, i) => ({ email: `${p}${i}@example.com` }));
const CHUNKS = () => join(process.cwd(), ".data", "broadcast-chunks");
const at = (ms: number) => mock.timers.setTime(ms);

async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await worker._pumpOnceForTest();
}

/** A marketing job: `proven` go at once, `fresh` are new to the platform. */
function paced(proven: number, fresh: number, over: Record<string, unknown> = {}) {
  const job = jobs.createJob({
    org: ORG,
    kind: "marketing",
    subject: "Doors at 8",
    html: "<p>See you there</p>",
    fromDisplayName: "Acme",
    fromAddress: "news@woco-net.com",
    ...over,
  } as Parameters<typeof jobs.createJob>[0]);
  const provenSet = new Set(people(proven, "old").map((r) => hashEmail(r.email)));
  const all = [...people(proven, "old"), ...people(fresh, "new")];
  let chunks = 0;
  for (let i = 0; i < all.length; i += jobs.MAX_CHUNK_RECIPIENTS) {
    const r = jobs.appendChunk(job.id, all.slice(i, i + jobs.MAX_CHUNK_RECIPIENTS), hashEmail, (h) => provenSet.has(h));
    if (r.accepted > 0) chunks++;
  }
  jobs.sealAndQueue(
    job.id,
    { chunkCount: chunks, totalRecipients: job.accepted },
    job.unproven > 0 ? { holdUntil: pacing.holdUntil(ORG, job.unproven) } : {},
  );
  return job;
}

describe("the schedule", { timeout: 60_000 }, () => {
  test("proven contacts go at once; new contacts go 100 an hour", async () => {
    const job = paced(140, 250);
    await drain();
    assert.equal(sent.length, 240, "140 returning + the first 100 new");
    assert.equal(job.waiting?.for, "next-batch");
    assert.equal(job.waiting?.until, new Date(T0 + HOUR).toISOString());

    at(T0 + 59 * MIN);
    await drain();
    assert.equal(sent.length, 240, "not a minute early");

    at(T0 + HOUR);
    await drain();
    assert.equal(sent.length, 340);

    at(T0 + 2 * HOUR);
    await drain();
    assert.equal(sent.length, 390);
    assert.equal(job.state, "completed");
    assert.equal(job.sentProven, 140);
    assert.equal(job.sentUnproven, 250);
  });

  test("every message carries its job and batch, so a bounce lands on the right count", async () => {
    const job = paced(3, 2);
    await drain();
    const batches = sent.map((m) => m.ctx?.batch);
    assert.deepEqual(batches, ["p", "p", "p", "u1", "u1"]);
    assert.ok(sent.every((m) => m.ctx?.job === job.id && m.ctx?.organiser === ORG));
    for (const m of sent) {
      const tags = (await import("../src/lib/email/message-tags.js")).buildMessageTags("marketing", m.ctx);
      assert.equal(tags.woco_ctx_job, job.id);
      assert.ok(tags.woco_ctx_batch, "the batch tag survives the tag charset");
    }
  });

  test("the day ceiling parks the job until UTC midnight, then the next rung's batch", async () => {
    const job = paced(0, 1_300);
    await drain();
    for (let h = 1; h < 10; h++) {
      at(T0 + h * HOUR);
      await drain();
    }
    assert.equal(sent.length, 1_000);
    at(T0 + 10 * HOUR);
    await drain();
    assert.equal(job.waiting?.for, "day-ceiling");
    assert.equal(job.waiting?.until, "2026-09-23T00:00:00.000Z");

    at(Date.parse("2026-09-23T00:00:00Z"));
    await drain();
    assert.equal(sent.length, 1_300, "rung 2 releases 300 at once");
    assert.equal(job.state, "completed");
  });

  test("a paced send is bounded by its schedule; an unpaced one keeps the drain formula", () => {
    // 250 new: batches at 09:00, 10:00 and 11:00, so the plan ends at 11:00
    // and the bound is a day after that.
    const pacedJob = paced(0, 250);
    assert.equal(Date.parse(pacedJob.expiresAt), T0 + 2 * HOUR + shared.PACING_HOLD_SLACK_MS);

    // However large the send, the 7-day ceiling binds.
    assert.ok(pacing.holdUntil(ORG, 1_000_000) <= T0 + shared.PACING_MAX_HOLD_MS);

    const unpaced = paced(10, 0);
    assert.equal(Date.parse(unpaced.expiresAt), T0 + jobs.drainTtlMs(10));
  });
});

describe("pauses and stops", { timeout: 60_000 }, () => {
  test("a bounce pause parks new contacts and says why", async () => {
    const job = paced(0, 300);
    await drain();
    pacing.recordBounce(ORG, `${job.id}:u1`, "General", 5, T0 + 5 * MIN);
    at(T0 + HOUR);
    await drain();
    assert.equal(sent.length, 100, "nothing new goes while paused");
    assert.equal(job.waiting?.for, "bounce-hold");
    assert.match(job.waiting?.message ?? "", /^Paused for new contacts - 5 of 100 new contacts bounced/);
  });

  test("a stop ends the job at once, destroys what is held, and blocks a restart until lifted", async () => {
    const job = paced(0, 300);
    await drain();
    pacing.recordBounce(ORG, `${job.id}:u1`, "General", 10, T0 + 5 * MIN);
    assert.equal(job.state, "stopped");
    assert.match(job.reason ?? "", new RegExp(shared.SUPPORT_EMAIL.replace(".", "\\.")));
    assert.deepEqual(readdirSync(CHUNKS()).filter((f) => f.startsWith(job.id)), [], "payload destroyed");

    const refusal = glue.pacingStartRefusal(ORG, T0 + 10 * MIN);
    assert.equal(refusal?.code, "SENDER_STOPPED");
    pacing.liftSender(ORG, "ops:test", "suppression-list hits", T0 + 20 * MIN);
    assert.equal(glue.pacingStartRefusal(ORG, T0 + 21 * MIN), null);
  });

  test("a pause that arrives mid-batch stops the batch between chunks", async () => {
    // One earlier sending day puts the sender on rung 2: this batch is 300,
    // three chunks of 100.
    pacing.admit(ORG, "earlier:u1", 100, T0 - 24 * HOUR);
    pacing.recordAccepted(ORG, "earlier:u1", "u", Array.from({ length: 100 }, (_, i) => `${i}`.padEnd(64, "d")), T0 - 24 * HOUR);
    let fired = false;
    worker._resetDrainWorkerForTest({
      async send(msg: OutboundEmail, opts?: SendEmailOptions) {
        sent.push({ to: msg.to[0]!, ctx: opts?.context });
        if (!fired) {
          fired = true;
          // 8 of the 100 earlier new contacts bounce while chunk 1 is going out.
          pacing.recordBounce(ORG, "earlier:u1", "General", 8);
        }
      },
    });
    const job = paced(0, 300);
    await drain();
    assert.equal(sent.length, 100, "the chunk in flight finishes; the other two wait");
    assert.equal(job.batch?.chunksLeft, 2, "the batch stays open for when the pause lifts");
    assert.equal(job.waiting?.for, "bounce-hold");
  });

  test("a send that resumes after a pause stops saying it is paused", async () => {
    pacing.admit(ORG, "earlier:u1", 100, T0 - 24 * HOUR);
    pacing.recordAccepted(ORG, "earlier:u1", "u", Array.from({ length: 100 }, (_, i) => `${i}`.padEnd(64, "e")), T0 - 24 * HOUR);
    const seen: Array<string | undefined> = [];
    let job!: ReturnType<typeof paced>;
    let fired = false;
    worker._resetDrainWorkerForTest({
      async send(msg: OutboundEmail, opts?: SendEmailOptions) {
        sent.push({ to: msg.to[0]!, ctx: opts?.context });
        if (!fired) {
          fired = true;
          pacing.recordBounce(ORG, "earlier:u1", "General", 8);
        } else if (sent.length > 100) {
          seen.push(job.waiting?.for);
        }
      },
    });
    job = paced(0, 300);
    await drain();
    assert.equal(job.waiting?.for, "bounce-hold");

    pacing.liftSender(ORG, "ops:test", "benign", T0 + 30 * MIN);
    at(T0 + 31 * MIN);
    await drain();
    assert.equal(sent.length, 300);
    assert.ok(seen.length > 0 && seen.every((w) => w === undefined), `the card said ${seen.find(Boolean)} while sending`);
  });

  test("returning contacts' first bounces are counted even before their chunk finishes", async () => {
    let job!: ReturnType<typeof paced>;
    let fired = false;
    worker._resetDrainWorkerForTest({
      async send(msg: OutboundEmail, opts?: SendEmailOptions) {
        sent.push({ to: msg.to[0]!, ctx: opts?.context });
        if (!fired) {
          fired = true;
          // Hard bounces come back in seconds, while the chunk is still going out.
          pacing.recordBounce(ORG, `${job.id}:p`, "General", 40);
        }
      },
    });
    job = paced(400, 0);
    await drain();
    assert.equal(pacing.pacingWindow(ORG).all.bounces, 40);
    assert.equal(job.state, "stopped", "40 of 400 returning contacts is the SES pause line");
  });

  test("attendee broadcasts never wait on, or die with, a marketing pause or stop", async () => {
    pacing.admit(ORG, "earlier:u1", 100, T0 - 2 * HOUR);
    pacing.recordAccepted(ORG, "earlier:u1", "u", ["f".repeat(64), "g".repeat(64)], T0 - 2 * HOUR);
    pacing.recordComplaint(ORG, "earlier:u1", { feedbackType: "abuse" }, 2, T0 - HOUR);
    const event = () => {
      const j = jobs.createJob({
        org: ORG, kind: "event", eventId: "ev1", subject: "Venue moved", html: "<p>x</p>",
        fromDisplayName: "Gig", fromAddress: "n@woco-net.com",
      });
      jobs.appendChunk(j.id, people(3, "att"), hashEmail);
      jobs.sealAndQueue(j.id, { chunkCount: 1, totalRecipients: 3 });
      return j;
    };
    const held = event();
    await drain();
    assert.equal(held.state, "completed", "a complaint pause on marketing does not hold attendee mail");

    const queued = event();
    pacing.stopSender(ORG, "ops:test", "investigating");
    assert.equal(queued.state, "queued", "a marketing stop does not end an attendee broadcast");
    await drain();
    assert.equal(queued.state, "completed");
  });

  test("a pause for new contacts only still lets a send start", () => {
    pacing.admit(ORG, "earlier:u1", 100, T0 - 2 * HOUR);
    pacing.recordAccepted(ORG, "earlier:u1", "u", Array.from({ length: 100 }, (_, i) => `${i}`.padEnd(64, "c")), T0 - 2 * HOUR);
    pacing.recordBounce(ORG, "earlier:u1", "General", 5, T0 - HOUR);
    assert.equal(pacing.pacingState(ORG).kind, "held");
    assert.equal(glue.pacingStartRefusal(ORG), null, "returning contacts can still be told");
  });

  test("a stopped send that reached people outlives the per-organiser record cap", async () => {
    const job = paced(0, 300);
    await drain();
    pacing.recordBounce(ORG, `${job.id}:u1`, "General", 10, T0 + 5 * MIN);
    assert.equal(job.state, "stopped");
    for (let i = 0; i < 25; i++) {
      // Each newer than the last, so the stopped job is the OLDEST record and
      // the per-organiser cap would reach it first.
      at(T0 + (i + 10) * MIN);
      const other = jobs.createJob({
        org: ORG, kind: "event", eventId: "e", subject: "s", html: "h", fromDisplayName: "E", fromAddress: "n@woco-net.com",
      });
      jobs.finishJob(other, "completed");
    }
    jobs.sweep();
    assert.ok(jobs.getJob(job.id), "its record is what a resume skips by once the stop is lifted");
  });

  test("a complaint pause holds returning contacts too, and refuses a new start", async () => {
    pacing.admit(ORG, "earlier:u1", 100, T0 - 2 * HOUR);
    pacing.recordAccepted(ORG, "earlier:u1", "u", ["a".repeat(64), "b".repeat(64)], T0 - 2 * HOUR);
    pacing.recordComplaint(ORG, "earlier:u1", { feedbackType: "abuse" }, 2, T0 - HOUR);

    const job = paced(600, 0);
    await drain();
    assert.equal(sent.length, 0);
    assert.equal(job.waiting?.for, "complaint-hold");
    assert.equal(glue.pacingStartRefusal(ORG)?.code, "SENDER_PAUSED");
  });

  test("a pause that outlasts the bound expires the job; the resume skips everyone reached", async () => {
    const job = paced(0, 300);
    await drain();
    pacing.recordBounce(ORG, `${job.id}:u1`, "General", 5, T0 + 5 * MIN);
    at(Date.parse(job.expiresAt) + MIN);
    await drain();
    assert.equal(job.state, "expired");
    assert.deepEqual(readdirSync(CHUNKS()).filter((f) => f.startsWith(job.id)), []);

    const resume = jobs.createJob({
      org: ORG, kind: "marketing", subject: "x", html: "x", fromDisplayName: "Acme",
      fromAddress: "news@woco-net.com", resumeOf: job.id,
    });
    assert.equal(jobs.appendChunk(resume.id, people(300, "new"), hashEmail).skipped, 100);
  });
});

describe("resume chains (#620)", { timeout: 60_000 }, () => {
  test("a resume of a resume skips everyone ANY earlier job reached, even with that job's record gone", () => {
    const list = [...people(3, "a"), ...people(3, "b"), ...people(3, "c")];
    const make = (resumeOf?: string) =>
      jobs.createJob({
        org: ORG, kind: "marketing", subject: "x", html: "x", fromDisplayName: "Acme",
        fromAddress: "news@woco-net.com", ...(resumeOf ? { resumeOf } : {}),
      });
    const drained = (job: ReturnType<typeof make>, delivered: string[]) => {
      jobs.sealAndQueue(job.id, { chunkCount: job.chunkCount, totalRecipients: job.accepted });
      jobs.recordChunkDrained(job, "p", {
        sent: delivered.length, suppressed: 0, crossed: 0, failed: 0,
        sentHashes: delivered.map(hashEmail), errors: [],
      });
      jobs.finishJob(job, "died", "restart");
    };

    const a = make();
    jobs.appendChunk(a.id, list, hashEmail);
    drained(a, list.slice(0, 3).map((r) => r.email));

    const b = make(a.id);
    assert.equal(jobs.appendChunk(b.id, list, hashEmail).skipped, 3);
    drained(b, list.slice(3, 6).map((r) => r.email));

    // A's record is pruned — the chain must not depend on it.
    unlinkSync(join(process.cwd(), ".data", "broadcast-jobs", `${a.id}.json`));
    jobs._reloadForTest();

    const c = make(b.id);
    const r = jobs.appendChunk(c.id, list, hashEmail);
    assert.equal(r.skipped, 6, "the a* people B skipped are still skipped by C");
    assert.equal(r.accepted, 3);
  });

  test("an access report names only the job that reached someone, not every resume after it", () => {
    const first = jobs.createJob({
      org: ORG, kind: "marketing", subject: "x", html: "x", fromDisplayName: "Acme", fromAddress: "n@woco-net.com",
    });
    jobs.appendChunk(first.id, people(2, "x"), hashEmail);
    jobs.sealAndQueue(first.id, { chunkCount: 1, totalRecipients: 2 });
    jobs.recordChunkDrained(first, "p", {
      sent: 1, suppressed: 0, crossed: 0, failed: 0, sentHashes: [hashEmail("x0@example.com")], errors: [],
    });
    jobs.finishJob(first, "died", "restart");
    const second = jobs.createJob({
      org: ORG, kind: "marketing", subject: "x", html: "x", fromDisplayName: "Acme",
      fromAddress: "n@woco-net.com", resumeOf: first.id,
    });
    assert.deepEqual(
      jobs.broadcastsContaining(hashEmail("x0@example.com")).map((b) => b.jobId),
      [first.id],
    );
    assert.ok(second.priorDelivered.includes(hashEmail("x0@example.com")));
  });
});

describe("the payload", { timeout: 60_000 }, () => {
  test("uploads are re-cut into 500s of returning contacts and 100s of new ones", () => {
    const job = paced(140, 1_100);
    assert.equal(job.pChunks, 1);
    assert.equal(job.uChunks, 11);
    assert.equal(job.proven, 140);
    assert.equal(job.unproven, 1_100);
    const files = readdirSync(CHUNKS()).filter((f) => f.startsWith(job.id));
    assert.equal(files.filter((f) => f.includes(".in.")).length, 0, "upload chunks are gone");
    assert.equal(files.length, 12);
  });

  test("a new-contact chunk moved into the returning run does not open", () => {
    // Same job, same slot number — only the run differs, so this fails ONLY
    // because the run is part of the authenticated data.
    const job = paced(0, 200);
    copyFileSync(join(CHUNKS(), `${job.id}.u.0.bin`), join(CHUNKS(), `${job.id}.p.0.bin`));
    assert.equal(jobs.readChunk(job.id, "p", 0), null, "pacing cannot be skipped by renaming a file");
    assert.ok(jobs.readChunk(job.id, "u", 0));
  });

  test("each job has its own key, and a chunk that outlives its job cannot be read", () => {
    const one = paced(5, 0);
    const two = paced(5, 0);
    const keep = join(process.cwd(), "stray.bin");
    copyFileSync(join(CHUNKS(), `${one.id}.p.0.bin`), keep);
    copyFileSync(join(CHUNKS(), `${one.id}.p.0.bin`), join(CHUNKS(), `${two.id}.p.7.bin`));
    assert.equal(jobs.readChunk(two.id, "p", 7), null, "one job cannot open another's chunk");

    jobs.cancelJob(one);
    copyFileSync(keep, join(CHUNKS(), `${one.id}.p.0.bin`));
    assert.equal(jobs.readChunk(one.id, "p", 0), null, "the key went with the job");
  });
});

describe("accounting", { timeout: 60_000 }, () => {
  test("a batch sent after the start reservation aged out is counted against the daily cap", async () => {
    const job = paced(0, 200);
    jobs.markReserved(job, 200);
    job.reservedAt = new Date(T0 - 25 * HOUR).toISOString();
    const before = cap.capRemaining(ORG);
    await drain();
    assert.equal(cap.capRemaining(ORG), before - 100);
  });

  test("a batch inside the reservation's window is not counted twice", async () => {
    const job = paced(0, 200);
    jobs.markReserved(job, 200);
    assert.equal(job.reservedAt, new Date(T0).toISOString(), "the reservation's age is what ages it out");
    const before = cap.capRemaining(ORG);
    await drain();
    assert.equal(cap.capRemaining(ORG), before);
  });

  test("health reports paced jobs and how long the oldest has been running — counts only", async () => {
    paced(0, 300);
    await drain();
    at(T0 + 2 * HOUR + 30 * MIN);
    const h = jobs.broadcastQueueHealth();
    assert.equal(h.pacedJobs, 1);
    assert.equal(h.oldestPendingHours, 2.5);
    assert.ok(!JSON.stringify(h).includes(ORG.slice(2, 10)));
  });
});

describe("who counts as reached before", { timeout: 60_000 }, () => {
  test("proof, or a checkout opt-in to this organiser — and nothing else", () => {
    const h = hashEmail("buyer@example.com");
    assert.equal(glue.reachedBefore(ORG, h), false);
    consent.recordConsent(h, ORG, { ts: new Date().toISOString(), source: "csv-import", notice: "x" });
    assert.equal(glue.reachedBefore(ORG, h), false, "an import warranty is not delivery");
    consent.recordConsent(h, ORG, { ts: new Date().toISOString(), source: "checkout", notice: "x" });
    assert.equal(glue.reachedBefore(ORG, h), true);
    assert.equal(glue.reachedBefore("0x1111111111111111111111111111111111111111", h), false, "per organiser");
  });
});

describe("data-subject requests", { timeout: 60_000 }, () => {
  test("pacing proof is reported under Art. 15 and erased under Art. 17", async () => {
    const subject = await import("../src/lib/marketing/subject-request.js");
    const h = hashEmail("person@example.com");
    pacing.admit(ORG, "j:u1", 1, T0);
    pacing.recordAccepted(ORG, "j:u1", "u", [h], T0);
    pacing.sweepPacing(() => false, T0 + HOUR);
    assert.deepEqual(subject.reportSubject(h).pacingProof, [ORG]);
    subject.eraseSubject(h);
    assert.equal(pacing.isProven(ORG, h), false);
    assert.deepEqual(subject.reportSubject(h).pacingProof, []);
  });
});

describe("health", { timeout: 60_000 }, () => {
  test("pacing reports itself blind when SES has no configuration set to publish tags", () => {
    const saved = { p: process.env.EMAIL_PROVIDER, c: process.env.SES_CONFIGURATION_SET };
    try {
      process.env.EMAIL_PROVIDER = "ses";
      delete process.env.SES_CONFIGURATION_SET;
      const blind = glue.senderPacingHealth();
      assert.equal(blind.tagging, false);
      assert.equal(blind.ok, false);
      process.env.SES_CONFIGURATION_SET = "woco-events";
      assert.equal(glue.senderPacingHealth().ok, true);
    } finally {
      if (saved.p === undefined) delete process.env.EMAIL_PROVIDER; else process.env.EMAIL_PROVIDER = saved.p;
      if (saved.c === undefined) delete process.env.SES_CONFIGURATION_SET; else process.env.SES_CONFIGURATION_SET = saved.c;
    }
  });
});
