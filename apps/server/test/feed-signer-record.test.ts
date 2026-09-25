/**
 * #670: each event's feed signer + verified creator, pinned at create.
 *
 * An unlisted event's only money-path carrier. Before it, such an event sold for
 * the 10 minutes its create primed the cache and then answered "Event not found"
 * at every checkout. Each rule below is pinned on its own, against a real file.
 */

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "woco-feed-signers-"));
const DATA = join(dir, ".data");
const FILE = join(DATA, "event-feed-signers.json");
// The store captures `join(process.cwd(), ".data")` at load: chdir before importing it.
process.chdir(dir);
const m = await import("../src/lib/event/feed-signer-record.js");
const listing = await import("../src/lib/event/listing-state.js");
process.chdir(originalCwd);

const EVENT = "5ebcdaba-482f-4da5-bfcf-6e1fa75794a0";
const SIGNER = "0x24B9cdcd0e8460333ea5f9e8064957635cb7c3fc";
const CREATOR = "0xEa1478b3818f3a06b83ceb7ec6f710a51115d879";
const OTHER = "0x1111111111111111111111111111111111111111";

function reset(fileContent?: string) {
  rmSync(DATA, { recursive: true, force: true });
  if (fileContent !== undefined) {
    mkdirSync(DATA, { recursive: true });
    writeFileSync(FILE, fileContent);
  }
  m.__resetFeedSignerRecordForTest();
}

before(() => reset());
beforeEach(() => reset());
after(() => rmSync(dir, { recursive: true, force: true }));

const feed = (creatorAddress: string | undefined) =>
  ({ eventId: EVENT, creatorAddress, title: "t", series: [] }) as unknown as Parameters<typeof m.acceptEventFeed>[1];

// ── The record ────────────────────────────────────────────────────────────────

test("a recorded event resolves lowercase, and the file lands owner-only", () => {
  m.recordEventFeedSigner(EVENT, SIGNER, CREATOR);
  const r = m.getRecordedFeedSigner(EVENT);
  assert.equal(r?.signer, SIGNER.toLowerCase());
  assert.equal(r?.creatorAddress, CREATOR.toLowerCase());
  assert.ok(r?.recordedAt);
  assert.equal(statSync(FILE).mode & 0o777, 0o600);
  const onDisk = JSON.parse(readFileSync(FILE, "utf-8"));
  assert.equal(onDisk[EVENT].signer, SIGNER.toLowerCase());
});

test("it survives a restart", () => {
  m.recordEventFeedSigner(EVENT, SIGNER, CREATOR);
  m.__resetFeedSignerRecordForTest();
  assert.equal(m.getRecordedFeedSigner(EVENT)?.signer, SIGNER.toLowerCase());
});

test("an event with no record resolves to null", () => {
  assert.equal(m.getRecordedFeedSigner(EVENT), null);
});

test("write-once: identical values are idempotent, any change THROWS and changes nothing", () => {
  m.recordEventFeedSigner(EVENT, SIGNER, CREATOR);
  const first = m.getRecordedFeedSigner(EVENT);
  m.recordEventFeedSigner(EVENT, SIGNER.toLowerCase(), CREATOR.toUpperCase().replace("0X", "0x"));
  assert.deepEqual(m.getRecordedFeedSigner(EVENT), first);
  assert.throws(() => m.recordEventFeedSigner(EVENT, OTHER, CREATOR), m.FeedSignerRebindError);
  assert.throws(() => m.recordEventFeedSigner(EVENT, SIGNER, OTHER), m.FeedSignerRebindError);
  assert.deepEqual(m.getRecordedFeedSigner(EVENT), first);
  m.__resetFeedSignerRecordForTest();
  assert.deepEqual(m.getRecordedFeedSigner(EVENT), first, "nothing reached the file either");
});

test("a malformed address is refused and nothing is recorded", () => {
  for (const [s, c] of [["0x123", CREATOR], [SIGNER, "not-an-address"], ["", CREATOR]]) {
    assert.throws(() => m.recordEventFeedSigner(EVENT, s, c));
  }
  assert.equal(m.getRecordedFeedSigner(EVENT), null);
});

test("/list and /unlist never touch it: the listing overlay's seed is a different store (#674)", () => {
  m.recordEventFeedSigner(EVENT, SIGNER, CREATOR);
  const before = m.getRecordedFeedSigner(EVENT);
  const card = { eventId: EVENT, title: "someone else's card", creatorAddress: OTHER, apiUrl: "https://elsewhere.example" };
  listing.setListed(EVENT, true, card as Parameters<typeof listing.setListed>[2], { explicitlyListed: true });
  listing.setListed(EVENT, false);
  assert.deepEqual(m.getRecordedFeedSigner(EVENT), before);
});

// ── A file it cannot read ─────────────────────────────────────────────────────

test("a file that is not JSON is never served, never overwritten, and alarms", () => {
  reset("{ this is not json");
  assert.equal(m.getRecordedFeedSigner(EVENT), null);
  assert.throws(() => m.recordEventFeedSigner(EVENT, SIGNER, CREATOR), m.FeedSignerStoreUnreadableError);
  assert.equal(readFileSync(FILE, "utf-8"), "{ this is not json", "the file stays exactly as found");
  assert.deepEqual(m.feedSignerRecordHealth(), { ok: false, unreadable: true, unreadableRecords: 0, count: 0 });
});

test("a JSON array is not a store either", () => {
  reset("[]");
  assert.throws(() => m.recordEventFeedSigner(EVENT, SIGNER, CREATOR), m.FeedSignerStoreUnreadableError);
  assert.equal(m.feedSignerRecordHealth().unreadable, true);
});

test("one bad record is kept on disk untouched, never served, and alarms; the rest still work", () => {
  const good = { signer: SIGNER.toLowerCase(), creatorAddress: CREATOR.toLowerCase(), recordedAt: "2026-09-25T00:00:00Z" };
  reset(JSON.stringify({ "bad-id": { signer: "0xnope" }, "good-id": good }));
  assert.equal(m.getRecordedFeedSigner("bad-id"), null);
  assert.deepEqual(m.getRecordedFeedSigner("good-id"), good);
  assert.deepEqual(m.feedSignerRecordHealth(), { ok: false, unreadable: false, unreadableRecords: 1, count: 1 });
  // A later write keeps the bad entry byte-for-byte, and cannot claim its id.
  m.recordEventFeedSigner(EVENT, SIGNER, CREATOR);
  const onDisk = JSON.parse(readFileSync(FILE, "utf-8"));
  assert.deepEqual(onDisk["bad-id"], { signer: "0xnope" });
  assert.throws(() => m.recordEventFeedSigner("bad-id", SIGNER, CREATOR), m.FeedSignerRebindError);
});

// Root ignores a 0500 directory, so under root this would be a false red, not a finding.
test("a write that cannot reach disk is not a record: it throws and forgets", { skip: process.getuid?.() === 0 }, () => {
  m.recordEventFeedSigner("first", SIGNER, CREATOR); // creates .data
  chmodSync(DATA, 0o500);
  try {
    assert.throws(() => m.recordEventFeedSigner(EVENT, SIGNER, CREATOR), m.FeedSignerWriteError);
    assert.equal(m.getRecordedFeedSigner(EVENT), null);
  } finally {
    chmodSync(DATA, 0o700);
  }
});

test("health is green with readable records", () => {
  m.recordEventFeedSigner(EVENT, SIGNER, CREATOR);
  assert.deepEqual(m.feedSignerRecordHealth(), { ok: true, unreadable: false, unreadableRecords: 0, count: 1 });
});

// ── Who is paid ───────────────────────────────────────────────────────────────

test("a recorded event's feed must name the recorded creator, or it is not found", () => {
  m.recordEventFeedSigner(EVENT, SIGNER, CREATOR);
  assert.ok(m.acceptEventFeed(EVENT, feed(CREATOR.toLowerCase())), "same creator, any case");
  assert.ok(m.acceptEventFeed(EVENT, feed(CREATOR)));
  assert.equal(m.acceptEventFeed(EVENT, feed(OTHER)), null, "a different creator would be paid instead");
  assert.equal(m.acceptEventFeed(EVENT, feed(undefined)), null, "a feed that names no creator");
  assert.equal(m.acceptEventFeed(EVENT, null), null);
});

test("an event with no record (legacy, or created without a signer) passes unchanged", () => {
  const f = feed(OTHER);
  assert.equal(m.acceptEventFeed(EVENT, f), f);
});

test("the store's own failures are recognised, so the organiser gets a plain sentence", () => {
  assert.equal(m.isFeedSignerStoreError(new m.FeedSignerRebindError("x")), true);
  assert.equal(m.isFeedSignerStoreError(new m.FeedSignerStoreUnreadableError("x")), true);
  assert.equal(m.isFeedSignerStoreError(new m.FeedSignerWriteError("x")), true);
  assert.equal(m.isFeedSignerStoreError(new Error("Stripe account not onboarded")), false);
});

// ── Wiring (text checks: getEvent reads Swarm, which a unit test cannot) ──────

const service = readFileSync(new URL("../src/lib/event/service.ts", import.meta.url), "utf-8");
const between = (from: string, to: string) => {
  const a = service.indexOf(from);
  assert.ok(a >= 0, `missing ${from}`);
  const b = service.indexOf(to, a);
  assert.ok(b > a, `missing ${to} after ${from}`);
  return service.slice(a, b);
};

test("create records the signer BEFORE the cache is primed and the feed goes out for signing", () => {
  const create = between("export async function createEventV2(", "\nexport ");
  const rec = create.indexOf("recordEventFeedSigner(eventId, creatorFeedSigner, creatorAddress)");
  const prime = create.indexOf("primeEventCache(eventId, eventFeed)");
  assert.ok(rec > 0 && prime > rec, "record, then prime");
  assert.match(create, /if \(creatorFeedSigner\) recordEventFeedSigner\(/, "optional: no signer, no record");
});

test("the resolver asks the record before the directory", () => {
  const resolver = between("async function resolveCreatorFeedSigner(", "\n}\n");
  const rec = resolver.indexOf("getRecordedFeedSigner(eventId)");
  const dir = resolver.indexOf("listEvents()");
  assert.ok(rec > 0 && dir > rec, "record first, directory second");
});

test("getEvent checks the creator before it caches or serves a feed", () => {
  const getEvent = between("export async function getEvent(", "\n}\n");
  const accept = getEvent.indexOf("feed = acceptEventFeed(eventId, feed)");
  const deleted = getEvent.indexOf("if (feed?.deleted)");
  const cache = getEvent.indexOf("_eventCache.set(");
  assert.ok(accept > 0 && deleted > accept && cache > accept, "accept, then the deleted check and the cache");
});

test("the directory's signer is born from the record", () => {
  assert.match(service, /const feedSigner = resolutionSigner\(eventId, updated\);/);
  const helper = between("function resolutionSigner(", "\n}\n");
  assert.match(helper, /return recorded \?\? feed\.creatorFeedSigner;/);
});

test("registration's cold-cache fallback checks the creator before it primes the cache", () => {
  const confirm = between("export async function confirmSeriesOnChain(", "\nexport ");
  const read = confirm.indexOf("feed = acceptEventFeed(eventId, await readEventFeedSoc(eventId, signerHint))");
  const prime = confirm.indexOf("primeEventCache(eventId, updated)");
  assert.ok(read > 0 && prime > read, "accept the fallback read, then prime");
});

test("the public page applies the same creator check, so it never shows what checkout refuses", () => {
  const display = between("export async function getEventForDisplay(", "\n}\n");
  assert.match(display, /const soc = acceptEventFeed\(eventId, await readEventFeedSoc\(/);
});

test("create never hands the organiser the store's operator text", () => {
  const route = readFileSync(new URL("../src/routes/events.ts", import.meta.url), "utf-8");
  const c = route.slice(route.indexOf('console.error("[api] createEventV2 error:", err);'));
  const handler = c.slice(0, c.indexOf("});"));
  assert.match(handler, /isFeedSignerStoreError\(err\)\s*\n?\s*\? "Publishing is paused while the server is repaired/);
});

test("/api/health carries the store's alarm", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
  assert.match(index, /\n\s*eventFeedSigners: feedSignerRecordHealth\(\),/);
});
