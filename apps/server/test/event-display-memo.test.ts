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
  assert.match(fn, /eventDisplayMemo\.read\(`\$\{eventDisplayKeyPrefix\(eventId\)\}\$\{untrustedSigner \?\? ""\}`/);
  assert.match(service, /const eventDisplayKeyPrefix = \(eventId: string\) => `\$\{eventId\}\|`;/);
});

test("a found event is answered stale while it refreshes; not-found is only memoized briefly and never stale", () => {
  const memo = between(service, "const eventDisplayMemo = createDisplayReadMemo", "});");
  assert.match(memo, /isEmpty: \(event\) => event === null/);
  assert.match(memo, /emptyTtlMs: 5_000/);
  assert.match(memo, /staleMs: 60 \* 60_000/);
});

test("a server-side edit (invalidateEventCache) clears every display key of that event", () => {
  const fn = between(service, "export function invalidateEventCache(", "\n}\n");
  assert.match(fn, /eventDisplayMemo\.invalidatePrefix\(eventDisplayKeyPrefix\(eventId\)\);/);
});

test("the public detail route reads through the memo, keeps its 500 and 404, and applies cancellations per request", () => {
  const handler = between(route, 'events.get("/:id", async (c) => {', "\n});\n");
  assert.match(handler, /const read = await getEventForDisplayMemo\(eventId, validHint\);/);
  assert.match(handler, /if \(read\.status === "error"\) throw new Error/);
  assert.match(handler, /if \(!event\) return c\.json\(\{ ok: false, error: "Event not found" \}, 404\);/);
  assert.match(handler, /data: withCancellation\(event\)/);
  assert.doesNotMatch(handler, /getEventForDisplay\(/, "no uncached read left on the public route");
});
