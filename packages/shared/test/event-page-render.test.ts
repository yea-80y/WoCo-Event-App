/**
 * #1032 slice 5 — the event-page render moved from the server into shared code
 * without changing a byte. `fixtures/event-page-render-vectors.json` was generated
 * from the server's own functions BEFORE the move (an image, none, a failed event
 * read, all-zero and uppercase refs, a trailing-slash gateway, hostile text).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  eventPageDeployConfig,
  parseEventPageHead,
  renderEventPageHtml,
  EVENT_PAGE_TITLE_MAX,
  type EventPageConfig,
  type EventPageHead,
} from "../src/site/event-page.js";

interface Vector { name: string; template: string; config: EventPageConfig; event: EventPageHead | null; html: string }
const vectors: Vector[] = JSON.parse(readFileSync(new URL("./fixtures/event-page-render-vectors.json", import.meta.url), "utf8"));

test("the vectors cover the cases that matter", () => {
  assert.equal(vectors.length, 6);
});

for (const v of vectors) {
  test(`renders exactly as the server did: ${v.name}`, () => {
    assert.equal(renderEventPageHtml({ template: v.template, config: eventPageDeployConfig(v.config), head: v.event }), v.html);
  });
}

test("the config keeps the server's key order, whatever order it is given in", () => {
  const c = vectors[0]!.config;
  const reordered = { eventSigner: c.eventSigner, eventId: c.eventId, contentGatewayUrl: c.contentGatewayUrl, gatewayUrl: c.gatewayUrl, apiUrl: c.apiUrl };
  assert.equal(JSON.stringify(eventPageDeployConfig(reordered)), JSON.stringify(c));
});

test("hostile text stays data: one config script, one icon link, nothing escaped out", () => {
  const v = vectors.find((x) => x.name === "hostile title")!;
  const script = /<script>(window\.SITE_CONFIG=[\s\S]*?)<\/script>/.exec(v.html)?.[1];
  assert.ok(script);
  const sandbox: { window: { SITE_CONFIG?: unknown } } = { window: {} };
  vm.runInNewContext(script, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.window.SITE_CONFIG)), v.config);
  assert.equal((v.html.match(/<script>/g) ?? []).length, 1);
  assert.equal((v.html.match(/rel="icon"/g) ?? []).length, 1, "the template's icon link is replaced, not added to");
  for (const m of v.html.matchAll(/content="([^"]*)"/g)) assert.doesNotMatch(m[1]!, /[<>]/);
});

test("the head a browser sends is parsed strictly and never normalised", () => {
  const img = "ab".repeat(32);
  assert.deepEqual(parseEventPageHead({ title: "Gig" }), { title: "Gig" });
  assert.deepEqual(parseEventPageHead({ title: "  Gig  ", imageHash: img }), { title: "  Gig  ", imageHash: img });
  assert.deepEqual(parseEventPageHead({ title: "x".repeat(EVENT_PAGE_TITLE_MAX) }), { title: "x".repeat(EVENT_PAGE_TITLE_MAX) });
  for (const bad of [
    null, "Gig", [], {}, { title: "" }, { title: 5 }, { title: "x".repeat(EVENT_PAGE_TITLE_MAX + 1) },
    { title: "Gig", imageHash: img.toUpperCase() }, { title: "Gig", imageHash: "0".repeat(64) },
    { title: "Gig", imageHash: img.slice(2) }, { title: "Gig", imageHash: `0x${img}` }, { title: "Gig", imageHash: null },
    { title: "Gig", extra: 1 },
  ]) {
    assert.equal(parseEventPageHead(bad), null, JSON.stringify(bad));
  }
});
