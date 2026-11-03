/**
 * #1032 slice 5 — the event-page render moved from the server into shared code
 * without changing a byte. `fixtures/event-page-render-vectors.json` was generated
 * from the server's own functions BEFORE the move (an image, none, a failed event
 * read, all-zero and uppercase refs, a trailing-slash gateway, hostile text).
 * #70 then changed ONE line per titled vector: the template's `<title>` became the
 * event's, escaped exactly as its pinned og:title. It also added a seventh vector,
 * the first with the page's WoCo name (`label`): the first vector plus one
 * canonical line.
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
import { EVENT_DESCRIPTION_MAX, type EventLdFacts } from "../src/event/jsonld.js";

interface Vector { name: string; template: string; config: EventPageConfig; event: EventPageHead | null; label?: string; html: string }
const vectors: Vector[] = JSON.parse(readFileSync(new URL("./fixtures/event-page-render-vectors.json", import.meta.url), "utf8"));

test("the vectors cover the cases that matter", () => {
  assert.equal(vectors.length, 7);
  assert.equal(vectors.filter((v) => v.label).length, 1, "one page is published under a name");
});

for (const v of vectors) {
  test(`renders exactly as pinned: ${v.name}`, () => {
    assert.equal(renderEventPageHtml({ template: v.template, config: eventPageDeployConfig(v.config), head: v.event, name: v.label }), v.html);
  });
}

test("the canonical is the page's WoCo name, and only a valid name (#70)", () => {
  const v = vectors[0]!;
  const canonicals = (name: string | undefined) =>
    [...renderEventPageHtml({ template: v.template, config: eventPageDeployConfig(v.config), head: v.event, name }).matchAll(/<link rel="canonical" href="([^"]*)">/g)].map((m) => m[1]);
  assert.deepEqual(canonicals("friday-gig"), ["https://friday-gig.woco.eth.limo/"]);
  for (const bad of [undefined, "", "ab", "Gig", "-gig", "gig-", "a--b", "gig.x", 'a"><script>', "x".repeat(64)]) {
    assert.deepEqual(canonicals(bad), [], String(bad));
  }
  // The template's icon links are stripped; the canonical link is not one of them.
  const named = renderEventPageHtml({ template: v.template, config: eventPageDeployConfig(v.config), head: v.event, name: "friday-gig" });
  assert.equal((named.match(/rel="icon"/g) ?? []).length, 1);
  assert.doesNotMatch(named, /og:url/);
});

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

test("the page title is the event's, kept from the template only when there is none (#70)", () => {
  const v = vectors[0]!;
  const render = (head: EventPageHead | null, template = v.template) =>
    renderEventPageHtml({ template, config: eventPageDeployConfig(v.config), head });
  const titleOf = (html: string) => [...html.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]);
  assert.deepEqual(titleOf(render({ title: "  Gig  " })), ["Gig"]);
  assert.deepEqual(titleOf(render(null)), ["Event"]);
  assert.deepEqual(titleOf(render({ title: "   " })), ["Event"]);
  const untitled = v.template.replace("<title>Event</title>", "");
  assert.deepEqual(titleOf(render({ title: "Gig" }, untitled)), ["Gig"], "a template without one gets one");
  for (const t of [`<title lang="en">Event</title>`, `<title >Event</title>`, `<TITLE>Event</TITLE>`]) {
    const out = render({ title: "Gig" }, v.template.replace("<title>Event</title>", t));
    assert.equal(out.match(/<title\b/gi)?.length, 1, t);
    assert.deepEqual(titleOf(out), ["Gig"], t);
  }
  assert.ok(render({ title: "Gig" }, untitled).indexOf("<title>Gig</title>") < render({ title: "Gig" }, untitled).indexOf("</head>"));

  // Rendered live, not read from the fixture: hostile text stays inside one title.
  const hostile = vectors.find((x) => x.name === "hostile title")!;
  const live = renderEventPageHtml({ template: hostile.template, config: eventPageDeployConfig(hostile.config), head: hostile.event });
  assert.deepEqual(titleOf(live), ["$` $&amp; &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; &quot;&#39; &amp; &lt;b&gt;"]);
  assert.equal((live.match(/<script>/g) ?? []).length, 1);
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

// ── #55: description + schema.org Event baked at publish ─────────────────────

const FACTS: EventLdFacts = {
  startDate: "2026-08-01T19:00:00.000Z",
  place: { name: "The Lock", streetAddress: "35 Chalk Farm Rd", locality: "London", country: "GB", lat: "51.540000", lng: "-0.146000" },
  offers: [{ name: "GA", price: "13.75", currency: "GBP" }],
};
const named = vectors.find((v) => v.label)!;
const renderNamed = (head: EventPageHead | null, name: string | undefined = named.label) =>
  renderEventPageHtml({ template: named.template, config: eventPageDeployConfig(named.config), head, name });
const LD_OPEN = `<script type="application/ld+json" data-woco-seo="event">`;
const ldBodies = (html: string) => html.split(LD_OPEN).slice(1).map((s) => s.slice(0, s.indexOf("</script>")));

test("a description and facts add exactly these lines, and every other byte is today's (#55)", () => {
  const html = renderNamed({ ...named.event!, description: "Live music every Friday", ld: FACTS });
  const img = `https://gateway.woco-net.com/bytes/${"ab".repeat(32)}`;
  const added = [
    `  <meta name="description" content="Live music every Friday">`,
    `  <meta property="og:description" content="Live music every Friday">`,
    `  <meta name="twitter:description" content="Live music every Friday">`,
    `  ${LD_OPEN}{"@context":"https://schema.org","@type":"Event","name":"Friday Gig","startDate":"2026-08-01T19:00:00.000Z",` +
      `"location":{"@type":"Place","name":"The Lock","address":{"@type":"PostalAddress","streetAddress":"35 Chalk Farm Rd","addressLocality":"London","addressCountry":"GB"},` +
      `"geo":{"@type":"GeoCoordinates","latitude":"51.540000","longitude":"-0.146000"}},"eventAttendanceMode":"https://schema.org/OfflineEventAttendanceMode",` +
      `"url":"https://friday-gig.woco.eth.limo/","description":"Live music every Friday","image":"${img}",` +
      `"offers":[{"@type":"Offer","url":"https://friday-gig.woco.eth.limo/","price":"13.75","priceCurrency":"GBP","name":"GA"}]}</script>`,
  ];
  let rest = html;
  for (const line of added) {
    assert.ok(rest.includes(`${line}\n`), line.slice(0, 60));
    rest = rest.replace(`${line}\n`, () => "");
  }
  assert.equal(rest, named.html);
});

test("an unnamed page states no url; a page with no image of its own states no image", () => {
  const v = vectors.find((x) => x.name === "event without an image")!;
  const html = renderEventPageHtml({ template: v.template, config: eventPageDeployConfig(v.config), head: { ...v.event!, ld: FACTS } });
  const [body] = ldBodies(html);
  const ld = JSON.parse(body!) as Record<string, unknown>;
  assert.equal(ld.name, "Quiz night");
  assert.equal(ld.url, undefined);
  assert.equal(ld.image, undefined, "never the logo the share card falls back to");
  assert.doesNotMatch(body!, /"url"/);
  assert.doesNotMatch(html, /name="description"/, "no description given, none baked");
});

test("a description without facts (an online event) bakes the description and no Event", () => {
  const html = renderNamed({ title: "Online talk", description: "A talk" });
  assert.equal(ldBodies(html).length, 0);
  assert.equal((html.match(/content="A talk"/g) ?? []).length, 3);
});

test("organiser text in the Event stays data: one element, no `<` inside it, parses back exactly", () => {
  const hostile = "</script><!--<script></head><link rel=icon href=x>$` $& \"' &    \uD800 <b>";
  const title = vectors.find((x) => x.name === "hostile title")!.event!.title!;
  const ld: EventLdFacts = {
    ...FACTS,
    place: { name: hostile, addressText: hostile },
    offers: [{ name: hostile, price: "10.00", currency: "EUR" }],
  };
  const html = renderNamed({ title, description: hostile, ld });
  const bodies = ldBodies(html);
  assert.equal(bodies.length, 1);
  assert.doesNotMatch(bodies[0]!, /</);
  const parsed = JSON.parse(bodies[0]!) as { name: string; description: string; location: { name: string; address: string }; offers: { name: string }[] };
  assert.equal(parsed.name, title.trim());
  assert.equal(parsed.description, hostile);
  assert.equal(parsed.location.name, hostile);
  assert.equal(parsed.location.address, hostile);
  assert.equal(parsed.offers[0]!.name, hostile);
  // The rest of the head is untouched by it.
  assert.equal((html.match(/<\/head>/g) ?? []).length, 1);
  assert.equal((html.match(/<script>/g) ?? []).length, 1, "one config script");
  assert.equal((html.match(/rel="icon"/g) ?? []).length, 1);
  for (const m of html.matchAll(/content="([^"]*)"/g)) assert.doesNotMatch(m[1]!, /[<>]/);
  const script = /<script>(window\.SITE_CONFIG=[\s\S]*?)<\/script>/.exec(html)?.[1];
  const sandbox: { window: { SITE_CONFIG?: unknown } } = { window: {} };
  vm.runInNewContext(script!, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.window.SITE_CONFIG)), named.config);
});

test("the bytes do not depend on the head's key order or a trip through JSON", () => {
  const head: EventPageHead = { title: "Friday Gig", imageHash: "ab".repeat(32), description: "Live", ld: FACTS };
  const reordered = JSON.parse(JSON.stringify({ ld: { offers: FACTS.offers, place: FACTS.place, startDate: FACTS.startDate }, description: "Live", imageHash: head.imageHash, title: head.title }));
  assert.equal(renderNamed(reordered), renderNamed(head));
  assert.equal(renderNamed(JSON.parse(JSON.stringify(head))), renderNamed(head));
});

test("no Event without a name: a blank title bakes none, and the parser refuses facts with one", () => {
  assert.equal(ldBodies(renderNamed({ title: "   ", ld: FACTS })).length, 0);
  assert.equal(parseEventPageHead({ title: "   ", ld: FACTS }), null);
});

test("the head with a description and facts is parsed strictly and never normalised (#55)", () => {
  const head = { title: "  Gig ", imageHash: "ab".repeat(32), description: " Live ", ld: FACTS };
  assert.deepEqual(parseEventPageHead(JSON.parse(JSON.stringify(head))), head);
  assert.deepEqual(parseEventPageHead({ title: "Gig", description: "x".repeat(EVENT_DESCRIPTION_MAX) }), { title: "Gig", description: "x".repeat(EVENT_DESCRIPTION_MAX) });
  for (const bad of [
    { title: "Gig", description: "" }, { title: "Gig", description: "x".repeat(EVENT_DESCRIPTION_MAX + 1) }, { title: "Gig", description: 5 },
    { title: "Gig", description: null }, { title: "Gig", ld: null }, { title: "Gig", ld: {} }, { title: "Gig", ld: { ...FACTS, extra: 1 } },
    { title: "Gig", ld: { ...FACTS, place: { ...FACTS.place, lat: 51.54 } } },
  ]) {
    assert.equal(parseEventPageHead(bad), null, JSON.stringify(bad));
  }
});
