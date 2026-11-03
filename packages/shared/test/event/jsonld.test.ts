/**
 * schema.org/Event projection (#55). Covers Google's required-field gate, the
 * geo → Place/PostalAddress/GeoCoordinates mapping, offers from PaymentConfig vs
 * normalisation of creator input, and the description trim. Since the event page
 * bakes it at publish (#55), also the split into facts (projection, strings only)
 * and `eventLdObject` (serialisation, fixed key order), and the rule that the
 * projection only ever produces facts `parseEventLdFacts` accepts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEventJsonLd,
  eventLdFacts,
  eventLdObject,
  eventMetaDescription,
  parseEventLdFacts,
  EVENT_DESCRIPTION_MAX,
  EVENT_LD_OFFERS_MAX,
  EVENT_LD_TEXT_MAX,
  type EventJsonLdSource,
  type EventLdFacts,
} from "../../src/event/jsonld.js";
import type { SeriesSummary } from "../../src/event/types.js";

const URL_ = "https://thelocktavern.co.uk/#/events/abc";

function source(over: Partial<EventJsonLdSource> = {}): EventJsonLdSource {
  return {
    title: "Friday Live Music",
    startDate: "2026-08-01T19:00:00.000Z",
    endDate: "2026-08-01T23:00:00.000Z",
    location: "The Lock Tavern, Camden",
    ...over,
  };
}

test("emits a valid Event with the required fields", () => {
  const out = buildEventJsonLd(source(), { url: URL_ });
  assert.ok(out);
  assert.equal(out["@context"], "https://schema.org");
  assert.equal(out["@type"], "Event");
  assert.equal(out.name, "Friday Live Music");
  assert.equal(out.startDate, "2026-08-01T19:00:00.000Z");
  assert.equal(out.endDate, "2026-08-01T23:00:00.000Z");
  assert.equal(out.url, URL_);
  assert.equal(out.eventStatus, "https://schema.org/EventScheduled");
});

test("returns null when a Google-required field is missing", () => {
  assert.equal(buildEventJsonLd(source({ title: "  " }), { url: URL_ }), null);
  assert.equal(buildEventJsonLd(source({ startDate: "" }), { url: URL_ }), null);
  // No geo AND no free-text location ⇒ no Place ⇒ invalid markup, emit nothing.
  assert.equal(buildEventJsonLd(source({ location: undefined }), { url: URL_ }), null);
});

test("structured geo maps to Place + PostalAddress + GeoCoordinates", () => {
  const out = buildEventJsonLd(
    source({
      geo: { venue: "The Lock Tavern", city: "London", country: "GB", address: "35 Chalk Farm Rd", lat: 51.54, lng: -0.146 },
    }),
    { url: URL_ },
  );
  const place = out!.location as Record<string, unknown>;
  assert.equal(place["@type"], "Place");
  assert.equal(place.name, "The Lock Tavern");
  assert.deepEqual(place.address, {
    "@type": "PostalAddress",
    streetAddress: "35 Chalk Farm Rd",
    addressLocality: "London",
    addressCountry: "GB",
  });
  // Strings (schema.org takes Text): the facts are strings end to end.
  assert.deepEqual(place.geo, { "@type": "GeoCoordinates", latitude: "51.540000", longitude: "-0.146000" });
});

test("falls back to the free-text location line when geo is absent", () => {
  const place = buildEventJsonLd(source(), { url: URL_ })!.location as Record<string, unknown>;
  assert.equal(place.name, "The Lock Tavern, Camden");
  assert.equal(place.address, "The Lock Tavern, Camden");
});

test("offers come from PaymentConfig, with sale window as validity", () => {
  const series: SeriesSummary[] = [
    {
      seriesId: "s1", name: "Early Bird", description: "", totalSupply: 50, price: 0,
      saleStart: "2026-07-01T00:00:00.000Z", saleEnd: "2026-07-20T00:00:00.000Z",
      payment: {
        price: "12.50", currency: "GBP", recipientAddress: "0x0", acceptedChains: [],
        escrow: false, cryptoEnabled: false, stripeEnabled: true,
      },
    } as SeriesSummary,
  ];
  const offers = buildEventJsonLd(source({ series }), { url: URL_ })!.offers as Record<string, unknown>[];
  assert.equal(offers.length, 1);
  assert.equal(offers[0].price, "12.50");
  assert.equal(offers[0].priceCurrency, "GBP");
  assert.equal(offers[0].name, "Early Bird");
  assert.equal(offers[0].validFrom, "2026-07-01T00:00:00.000Z");
  assert.equal(offers[0].validThrough, "2026-07-20T00:00:00.000Z");
  assert.equal(offers[0].availability, "https://schema.org/InStock");
});

test("offer price includes the booking fee - Google shows it as the ticket price", () => {
  const series = [{
    seriesId: "s1", name: "GA", description: "", totalSupply: 10, price: 0,
    payment: {
      price: "12.50", currency: "GBP", recipientAddress: "0x0", acceptedChains: [],
      escrow: false, cryptoEnabled: false, stripeEnabled: true,
      feePassedToCustomer: true, buyerFeePercent: 10,
    },
  }] as SeriesSummary[];
  const offers = buildEventJsonLd(source({ series }), { url: URL_ })!.offers as Record<string, unknown>[];
  assert.equal(offers[0].price, "13.75");
});

test("a ticket type nobody can pay for has no offer - never a price of 0", () => {
  // The legacy numeric price used to become "0" in GBP: a free-ticket claim for an
  // event that has no free tickets (`freeEventsAllowed` is off).
  const legacy = [{ seriesId: "s1", name: "GA", description: "", totalSupply: 10, price: 0 }] as SeriesSummary[];
  assert.equal(buildEventJsonLd(source({ series: legacy }), { url: URL_ })!.offers, undefined);
  const zero = [{
    seriesId: "s1", name: "GA", description: "", totalSupply: 10, price: 0,
    payment: { price: "0", currency: "GBP", recipientAddress: "0x0", acceptedChains: [], escrow: false },
  }] as unknown as SeriesSummary[];
  assert.equal(buildEventJsonLd(source({ series: zero }), { url: URL_ })!.offers, undefined);
});

test("tags are normalised into keywords, not passed through raw", () => {
  const out = buildEventJsonLd(
    source({ tags: [{ type: "genre", value: "  music " }, { type: "genre", value: "Vaporwave" }] }),
    { url: URL_ },
  );
  // "music" canonicalises to "Music"; unknown vocab survives as free text.
  assert.equal(out!.keywords, "Music, Vaporwave");
});

test("cancelled events say so rather than vanishing", () => {
  const out = buildEventJsonLd(source(), { url: URL_, cancelled: true });
  assert.equal(out!.eventStatus, "https://schema.org/EventCancelled");
});

test("description is the page's: tagline first, else the description's opening, at most 300", () => {
  assert.equal(buildEventJsonLd(source({ description: "Full text" }), { url: URL_ })!.description, "Full text");
  assert.equal(buildEventJsonLd(source({ tagline: "Short line" }), { url: URL_ })!.description, "Short line");
  assert.equal(buildEventJsonLd(source({ tagline: "Short line", description: "Full text" }), { url: URL_ })!.description, "Short line");
  const long = buildEventJsonLd(source({ description: "word ".repeat(200) }), { url: URL_ })!.description as string;
  assert.ok(long.length <= EVENT_DESCRIPTION_MAX && long.endsWith("…"), String(long.length));
  assert.equal(buildEventJsonLd(source(), { url: URL_ })!.description, undefined);
});

// ── #55 deploy-time half: facts + serialiser ────────────────────────────────

const PAID = (price: string, extra: Record<string, unknown> = {}) => ({
  seriesId: "s", name: "GA", description: "", totalSupply: 10, price: 0,
  payment: { price, currency: "GBP", recipientAddress: "0x0", acceptedChains: [], escrow: false, stripeEnabled: true },
  ...extra,
}) as unknown as SeriesSummary;

function leaves(v: unknown, out: unknown[] = []): unknown[] {
  if (v && typeof v === "object") for (const x of Object.values(v)) leaves(x, out);
  else out.push(v);
  return out;
}

test("online events have no facts: no place, and the joining link is never public", () => {
  assert.equal(eventLdFacts(source({ geo: { online: true } })), null);
  assert.equal(buildEventJsonLd(source({ geo: { online: true } }), { url: URL_ }), null);
});

test("a place with no address has no facts (Google requires location.address)", () => {
  assert.equal(eventLdFacts(source({ location: "", geo: { lat: 51.5, lng: -0.1 } })), null);
  const text = eventLdFacts(source({ geo: { lat: 51.5, lng: -0.1 } }))!.place;
  assert.deepEqual(text, { name: "The Lock Tavern, Camden", addressText: "The Lock Tavern, Camden", lat: "51.500000", lng: "-0.100000" });
  const structured = eventLdFacts(source({ geo: { venue: "The Lock", country: "gb" } }))!.place;
  assert.deepEqual(structured, { name: "The Lock", country: "GB" }, "the free-text line only stands in for a missing address");
});

test("facts are strings only, with absent keys rather than undefined or null", () => {
  const f = eventLdFacts(source({
    geo: { venue: "The Lock Tavern", city: "London", country: "GB", address: "35 Chalk Farm Rd", lat: 51.54, lng: -0.146 },
    series: [PAID("12.50", { saleStart: "2026-07-01T00:00:00Z" })],
  }))!;
  for (const leaf of leaves(f)) assert.equal(typeof leaf, "string", String(leaf));
  assert.deepEqual(JSON.parse(JSON.stringify(f)), f);
  assert.equal(f.offers![0]!.validFrom, "2026-07-01T00:00:00.000Z", "dates are ISO instants");
});

test("the serialiser's key order is fixed (both renders of a page must agree byte for byte)", () => {
  const facts: EventLdFacts = {
    startDate: "2026-08-01T19:00:00.000Z",
    endDate: "2026-08-01T23:00:00.000Z",
    place: { name: "The Lock", streetAddress: "35 Chalk Farm Rd", locality: "London", country: "GB", lat: "51.540000", lng: "-0.146000" },
    offers: [{ name: "GA", price: "13.75", currency: "GBP", validFrom: "2026-07-01T00:00:00.000Z", validThrough: "2026-08-01T18:00:00.000Z" }],
  };
  const reordered = JSON.parse(JSON.stringify({
    offers: [{ validThrough: facts.offers![0]!.validThrough, validFrom: facts.offers![0]!.validFrom, currency: "GBP", price: "13.75", name: "GA" }],
    place: { lng: "-0.146000", lat: "51.540000", country: "GB", locality: "London", streetAddress: "35 Chalk Farm Rd", name: "The Lock" },
    endDate: facts.endDate, startDate: facts.startDate,
  })) as EventLdFacts;
  const opts = { name: "Gig", description: "Live", url: "https://gig.woco.eth.limo/", imageUrl: "https://g/bytes/ab" };
  const expected =
    '{"@context":"https://schema.org","@type":"Event","name":"Gig","startDate":"2026-08-01T19:00:00.000Z","endDate":"2026-08-01T23:00:00.000Z",' +
    '"location":{"@type":"Place","name":"The Lock","address":{"@type":"PostalAddress","streetAddress":"35 Chalk Farm Rd","addressLocality":"London","addressCountry":"GB"},' +
    '"geo":{"@type":"GeoCoordinates","latitude":"51.540000","longitude":"-0.146000"}},"eventAttendanceMode":"https://schema.org/OfflineEventAttendanceMode",' +
    '"url":"https://gig.woco.eth.limo/","description":"Live","image":"https://g/bytes/ab",' +
    '"offers":[{"@type":"Offer","url":"https://gig.woco.eth.limo/","price":"13.75","priceCurrency":"GBP","name":"GA","validFrom":"2026-07-01T00:00:00.000Z","validThrough":"2026-08-01T18:00:00.000Z"}]}';
  assert.equal(JSON.stringify(eventLdObject(facts, opts)), expected);
  assert.equal(JSON.stringify(eventLdObject(reordered, opts)), expected, "input key order never reaches the output");
});

test("no url given = no url anywhere, offers included; status and availability only when given", () => {
  const ld = eventLdObject(eventLdFacts(source({ series: [PAID("10.00")] }))!, { name: "Gig" });
  const s = JSON.stringify(ld);
  assert.doesNotMatch(s, /"url"|eventStatus|availability/);
});

test("whatever the event holds, the projection produces facts the parser accepts, or none", () => {
  const emojiCut = "x".repeat(EVENT_LD_TEXT_MAX - 1) + "😀";
  const odd: EventJsonLdSource[] = [
    source(),
    source({ location: "  \n " }),
    source({ startDate: "not a date" }),
    source({ startDate: "+010000-01-01T00:00:00.000Z" }),
    source({ startDate: "2026-08-01", endDate: "garbage" }),
    source({ location: emojiCut, geo: { venue: emojiCut, city: "  ", address: emojiCut } }),
    source({ geo: { country: "XX", lat: 91, lng: 0 } }),
    source({ geo: { country: "gb", lat: -89.9999999, lng: 179.9999999 } }),
    source({ geo: { lat: -0.00000001, lng: 0.00000001, city: "Null Island" } }),
    source({ series: [PAID("12345678.00"), PAID("1e3"), PAID("-5"), PAID("12.5"), PAID("0.001")] }),
    source({ series: [{ ...PAID("10.00"), payment: { ...PAID("10.00").payment!, currency: "JPY" } } as unknown as SeriesSummary] }),
    source({ series: [PAID("10.00", { name: emojiCut, saleStart: "soon", saleEnd: "2026-13-45T00:00:00Z" })] }),
    source({ series: Array.from({ length: EVENT_LD_OFFERS_MAX + 5 }, () => PAID("5.00")) }),
  ];
  for (const s of odd) {
    const f = eventLdFacts(s);
    if (f === null) continue;
    const wire = JSON.parse(JSON.stringify(f));
    assert.deepEqual(parseEventLdFacts(wire), f, JSON.stringify(s).slice(0, 120));
    assert.ok((f.offers?.length ?? 0) <= EVENT_LD_OFFERS_MAX);
    for (const leaf of leaves(f)) assert.ok(typeof leaf === "string" && !/[\uD800-\uDBFF]$/.test(leaf), String(leaf));
  }
});

test("facts a browser sends back are parsed strictly and never normalised", () => {
  const good: EventLdFacts = {
    startDate: "2026-08-01T19:00:00.000Z",
    place: { name: "The Lock", addressText: "Camden" },
    offers: [{ price: "10.00", currency: "GBP" }],
  };
  assert.deepEqual(parseEventLdFacts(good), good);
  assert.ok(parseEventLdFacts({ ...good, startDate: "2026-08-01T20:00:00+01:00" }), "an offset is a valid instant");
  const with_ = (over: Record<string, unknown>) => ({ ...good, ...over });
  const place = (over: Record<string, unknown>) => with_({ place: { ...good.place, ...over } });
  const offer = (over: Record<string, unknown>) => with_({ offers: [{ ...good.offers![0], ...over }] });
  for (const bad of [
    null, [], "x", {}, with_({ extra: 1 }), with_({ endDate: null }), with_({ offers: [] }),
    with_({ startDate: "2026-08-01" }), with_({ startDate: "2026-08-01T19:00:00" }), with_({ startDate: "2026-99-99T19:00:00Z" }),
    with_({ offers: Array.from({ length: EVENT_LD_OFFERS_MAX + 1 }, () => good.offers![0]) }),
    place({ extra: "x" }), place({ name: "" }), place({ name: "x".repeat(EVENT_LD_TEXT_MAX + 1) }), place({ name: 5 }),
    place({ addressText: undefined }), place({ country: "gb", addressText: undefined }), place({ country: "XX" }),
    place({ lat: 51.5, lng: -0.1 }), place({ lat: "51.5" }), place({ lat: "91.0", lng: "0.0" }), place({ lat: "0.0", lng: "181.0" }),
    place({ lat: "1e1", lng: "0.0" }), place({ lat: "51.5000000", lng: "0.0" }),
    offer({ price: "12.5" }), offer({ price: "-1.00" }), offer({ price: "1e3" }), offer({ price: 10 }), offer({ price: "1234567.00" }),
    offer({ currency: "gbp" }), offer({ currency: "JPY" }), offer({ currency: "toString" }), offer({ name: null }), offer({ extra: 1 }),
    offer({ validFrom: "tomorrow" }),
  ]) {
    assert.equal(parseEventLdFacts(bad), null, JSON.stringify(bad));
  }
});

test("meta description prefers tagline and trims on a word boundary", () => {
  assert.equal(eventMetaDescription({ ...source(), tagline: "Live music every Friday" }), "Live music every Friday");

  const long = "word ".repeat(80).trim();
  const out = eventMetaDescription({ ...source(), description: long });
  assert.ok(out.length <= 161, `expected trim, got ${out.length}`);
  assert.ok(out.endsWith("…"));
  assert.ok(!out.includes("  "));
});

test("collapses whitespace so markup never carries raw newlines", () => {
  assert.equal(eventMetaDescription({ ...source(), description: "one\n\ntwo   three" }), "one two three");
});
