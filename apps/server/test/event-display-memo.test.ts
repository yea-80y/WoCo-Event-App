/**
 * The public event detail (GET /api/events/:id) reads through a display memo
 * (`eventDisplayMemo`, service.ts) so an event page seen a few times an hour stops
 * paying a cold chain read + feed scan on almost every visit. Pinned here: the key
 * includes the caller's signer hint, a not-found is never answered stale, a
 * server-side edit clears every key of its event, and the route still applies the
 * cancellation record per request. The memo's own behaviour: display-read-memo.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const service = readFileSync(new URL("../src/lib/event/service.ts", import.meta.url), "utf-8");
const route = readFileSync(new URL("../src/routes/events.ts", import.meta.url), "utf-8");
const between = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `missing: ${start}`);
  return src.slice(i, src.indexOf(end, i));
};

test("the memo key is the event AND the caller's signer hint, never the event alone", () => {
  const fn = between(service, "export async function getEventForDisplayMemo(", "\n}\n");
  assert.match(fn, /eventDisplayMemo\.read\(`\$\{eventDisplayKeyPrefix\(eventId\)\}\$\{hintKey\}`/);
  assert.match(service, /const eventDisplayKeyPrefix = \(eventId: string\) => `\$\{eventId\}\|`;/);
});

test("a recorded event's hinted callers share one key (the record decides the signer, not the hint)", () => {
  const fn = between(service, "export async function getEventForDisplayMemo(", "\n}\n");
  assert.match(fn, /const hintKey = untrustedSigner && getRecordedFeedSigner\(eventId\) \? "recorded" : \(untrustedSigner \?\? ""\);/);
  const resolve = between(service, "async function resolveCreatorFeedSigner(", "\n}\n");
  assert.match(resolve, /getRecordedFeedSigner\(eventId\)/, "the record is the trusted carrier, ahead of any hint");
});

test("a read that throws is logged with its cause and answered as an error, never memoized", () => {
  const fn = between(service, "export async function getEventForDisplayMemo(", "\n}\n");
  assert.match(fn, /\} catch \(err\) \{\s*console\.error\(`\[event\] \$\{eventId\}: display read failed:`, err\);\s*return \{ status: "error" \};/);
});

test("a found event is answered stale while it refreshes; not-found is only memoized briefly and never stale", () => {
  const memo = between(service, "const eventDisplayMemo = createDisplayReadMemo", "});");
  assert.match(memo, /isEmpty: \(event\) => event === null/);
  assert.match(memo, /emptyTtlMs: 5_000/);
  assert.match(memo, /staleMs: 60 \* 60_000/);
});

test("a degraded read is answered, never memoized: carrier lookup failed, dirty scan, keys or feed unreadable", () => {
  const read = between(service, "async function readEventForDisplay(", "\n}\n");
  assert.match(read, /if \(found === CARRIER_TIMED_OUT\) carrierFailed = true;/);
  assert.match(read, /\} catch \{\s*carrierFailed = true;\s*\}/);
  assert.match(read, /if \(soc\) return \{ event: soc\.deleted \? null : soc, degraded: carrierFailed \|\| \(res\.status === "found" && !res\.scanClean\) \};/);
  assert.match(read, /if \(res\.status === "unavailable"\) return \{ event: \(await getEventRead\(eventId\)\)\.feed, degraded: true \};/);
  assert.match(read, /const read = await getEventRead\(eventId\);\s*return \{ event: read\.feed, degraded: !read\.settled \};/);
  const memoRead = between(service, "export async function getEventForDisplayMemo(", "\n}\n");
  assert.match(memoRead, /return r\.degraded \? \{ status: "ok", data: r\.event, keep: false \} : \{ status: "ok", data: r\.event \};/);
});

test("the trusted read says when its answer is unsettled: keys unreadable (warm or cold), dirty scan, feed unreadable", () => {
  const fn = between(service, "async function getEventRead(", "\n}\n");
  assert.match(fn, /cacheable: true,\s*settled: keys\.kind !== "unavailable",/);
  assert.match(fn, /return \{ feed: null, cacheable: false, settled: false \};/);
  assert.match(fn, /\} else if \(soc\.status === "unavailable"\) socUnavailable = true;/);
  assert.match(fn, /return \{ feed, cacheable, settled: cacheable && !socUnavailable \};/);
});

test("create and chain-confirm (primeEventCache) clear the event's display keys too", () => {
  const fn = between(service, "export function primeEventCache(", "\n}\n");
  assert.match(fn, /eventDisplayMemo\.invalidatePrefix\(eventDisplayKeyPrefix\(eventId\)\);/);
});

test("a new key-ring generation for an organiser drops every display entry of their events (#186)", () => {
  assert.match(
    service,
    /onKeyRingGeneration\(\(account\) =>\s*eventDisplayMemo\.invalidateWhere\(\(event\) => event\?\.creatorAddress\?\.toLowerCase\(\) === account\),\s*\);/,
  );
});

test("a server-side edit (invalidateEventCache) clears every display key of that event", () => {
  const fn = between(service, "export function invalidateEventCache(", "\n}\n");
  assert.match(fn, /eventDisplayMemo\.invalidatePrefix\(eventDisplayKeyPrefix\(eventId\)\);/);
});

test("the public detail route reads through the memo, keeps its 500 and 404, and applies cancellations per request", () => {
  const handler = between(route, 'events.get("/:id", async (c) => {', "\n});\n");
  assert.match(handler, /const read = await getEventForDisplayMemo\(eventId, validHint\);/);
  assert.match(handler, /if \(read\.status === "error"\) return c\.json\(\{ ok: false, error: "Failed to get event" \}, 500\);/);
  assert.match(handler, /if \(!event\) return c\.json\(\{ ok: false, error: "Event not found" \}, 404\);/);
  assert.match(handler, /data: withCancellation\(event\)/);
  assert.doesNotMatch(handler, /getEventForDisplay\(/, "no uncached read left on the public route");
});
