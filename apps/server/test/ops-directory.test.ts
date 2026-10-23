/**
 * The operator's directory surface: list what the public directory shows, take
 * an event out of it, and rebuild now.
 *
 * Unlisting has to go through the overlay rather than the file: an EMPTIED
 * listing file is re-seeded from the last snapshot on the next rebuild, so the
 * events come straight back. What these pin is that an unlist clears the flag
 * but keeps the row (and its seed), that it never invents a row for an event
 * that was not listed, and that the rebuild it needs is actually asked for.
 * The rebuild itself writes to Swarm, so it is swapped for a recorder here.
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SnapshotCard } from "@woco/shared";

process.env.EMAIL_HASH_SECRET = "test-secret-ops-directory";

let ops: typeof import("../src/routes/ops.js");
let ls: typeof import("../src/lib/event/listing-state.js");

const TOKEN = "test-operator-token-0123456789";
const originalToken = process.env.OPS_TOKEN;

let scheduled: string[] = [];
let fullRuns = 0;
let fullFails: Error | null = null;

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-ops-directory-")));
  ops = await import("../src/routes/ops.js");
  ls = await import("../src/lib/event/listing-state.js");
  ops._setDirectoryRebuildForTest({
    schedule: (eventId?: string) => { if (eventId) scheduled.push(eventId); },
    full: async () => {
      fullRuns++;
      if (fullFails) throw fullFails;
    },
  });
});

after(() => {
  if (originalToken === undefined) delete process.env.OPS_TOKEN;
  else process.env.OPS_TOKEN = originalToken;
});

beforeEach(() => {
  ops._resetOpsLockoutForTest();
  process.env.OPS_TOKEN = TOKEN;
  scheduled = [];
  fullRuns = 0;
  fullFails = null;
});

function card(eventId: string, title = eventId): SnapshotCard {
  return {
    eventId, title, imageHash: ("00".repeat(32)) as SnapshotCard["imageHash"],
    startDate: "2999-01-01", location: "", creatorAddress: "0x0" as SnapshotCard["creatorAddress"],
    seriesCount: 1, totalTickets: 10, createdAt: "2026-01-01T00:00:00Z", tags: [],
  };
}

function list(eventId: string, title?: string): void {
  ls.setListed(eventId, true, card(eventId, title), { explicitlyListed: true });
}

const call = (path: string, init: RequestInit = {}) => ops.ops.request(path, init);
const authed = (path: string, init: RequestInit = {}) =>
  call(path, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${TOKEN}` } });
const post = (path: string, body: unknown) =>
  authed(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function rowOnDisk(eventId: string): unknown {
  const file = join(process.cwd(), ".data", "event-listing-state.json");
  return (JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>)[eventId];
}

describe("POST /events/:id/unlist", () => {
  test("needs the operator token", async () => {
    list("evt-auth");
    const res = await call("/events/evt-auth/unlist", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ by: "test" }),
    });
    assert.equal(res.status, 404);
    assert.equal(ls.isListedForSnapshot("evt-auth"), true);
  });

  test("needs `by`, and changes nothing without it", async () => {
    list("evt-noby");
    const res = await post("/events/evt-noby/unlist", {});
    assert.equal(res.status, 400);
    assert.equal(ls.isListedForSnapshot("evt-noby"), true);
    assert.deepEqual(scheduled, []);
  });

  test("takes a listed event out, keeps its row and seed, and asks for a rebuild", async () => {
    list("evt-out", "Test night");
    const res = await post("/events/evt-out/unlist", { by: "test" });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data, { eventId: "evt-out", wasListed: true });
    assert.equal(ls.isListedForSnapshot("evt-out"), false);
    // The row stays, so an overlay of unlisted rows is never "empty" and never re-seeded.
    assert.equal(ls.hasAnyRows(), true);
    assert.equal(ls.getListingSeed("evt-out")?.title, "Test night");
    assert.equal((rowOnDisk("evt-out") as { listed: boolean }).listed, false);
    assert.deepEqual(scheduled, ["evt-out"]);
  });

  test("an event that is not listed is left alone - no row invented, no rebuild", async () => {
    const res = await post("/events/evt-never-seen/unlist", { by: "test" });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data, { eventId: "evt-never-seen", wasListed: false });
    assert.equal(ls.getListingSeed("evt-never-seen"), null);
    assert.equal(rowOnDisk("evt-never-seen"), undefined);
    assert.deepEqual(scheduled, []);
  });

  test("a tombstoned event reads as not listed", async () => {
    list("evt-tomb");
    ls.setTombstoned("evt-tomb");
    const res = await post("/events/evt-tomb/unlist", { by: "test" });
    assert.deepEqual((await res.json()).data, { eventId: "evt-tomb", wasListed: false });
    assert.deepEqual(scheduled, []);
  });
});

describe("GET /directory", () => {
  test("lists exactly the listed events, by their card titles", async () => {
    list("evt-shown", "Shown night");
    list("evt-hidden");
    await post("/events/evt-hidden/unlist", { by: "test" });
    const { data } = await (await authed("/directory")).json();
    const ids = data.listed.map((e: { eventId: string }) => e.eventId);
    assert.ok(ids.includes("evt-shown"));
    assert.ok(!ids.includes("evt-hidden"));
    assert.equal(data.count, data.listed.length);
    assert.equal(data.listed.find((e: { eventId: string }) => e.eventId === "evt-shown").title, "Shown night");
  });
});

describe("POST /directory/rebuild", () => {
  test("runs one full reconcile", async () => {
    const res = await post("/directory/rebuild", { by: "test" });
    assert.equal(res.status, 200);
    assert.equal(fullRuns, 1);
    assert.equal(typeof (await res.json()).data.listed, "number");
  });

  test("a failed rebuild is reported, never answered ok", async () => {
    fullFails = new Error("bee unreachable");
    const res = await post("/directory/rebuild", { by: "test" });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /bee unreachable/);
  });

  test("needs `by`, and does not rebuild without it", async () => {
    const res = await post("/directory/rebuild", {});
    assert.equal(res.status, 400);
    assert.equal(fullRuns, 0);
  });
});
