/**
 * schema.org/Event projection (#55). Covers Google's required-field gate, the
 * geo → Place/PostalAddress/GeoCoordinates mapping, offers from PaymentConfig vs
 * legacy numeric price, normalisation of creator input, and the description trim.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEventJsonLd, eventMetaDescription, type EventJsonLdSource } from "../../src/event/jsonld.js";
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
  assert.deepEqual(place.geo, { "@type": "GeoCoordinates", latitude: 51.54, longitude: -0.146 });
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

test("legacy numeric price (no PaymentConfig) still produces an offer", () => {
  const series = [{ seriesId: "s1", name: "GA", description: "", totalSupply: 10, price: 0 }] as SeriesSummary[];
  const offers = buildEventJsonLd(source({ series }), { url: URL_ })!.offers as Record<string, unknown>[];
  assert.equal(offers[0].price, "0");
  assert.equal(offers[0].priceCurrency, "GBP");
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

test("description prefers the real description, falls back to tagline", () => {
  assert.equal(buildEventJsonLd(source({ description: "Full text" }), { url: URL_ })!.description, "Full text");
  assert.equal(buildEventJsonLd(source({ tagline: "Short line" }), { url: URL_ })!.description, "Short line");
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
