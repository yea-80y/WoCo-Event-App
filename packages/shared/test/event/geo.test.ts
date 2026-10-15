/**
 * Structured-geo normaliser (#37 location model). Covers the build-time filter
 * policy: ISO country validation + uppercasing, label trim/cap, coordinate
 * bounds as a pair, drop-when-nothing-usable, and determinism.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseGeo, eventHasPlace, isValidCountryCode, countryName, geoWithinSizeLimit, GEO_MAX_JSON_BYTES } from "../../src/event/geo.js";
import type { EventGeo } from "../../src/event/types.js";

test("validates + uppercases a known ISO country", () => {
  assert.deepEqual(normaliseGeo({ country: "gb" }), { country: "GB" });
  assert.deepEqual(normaliseGeo({ country: " De " }), { country: "DE" });
});

test("drops an unknown country code", () => {
  assert.equal(normaliseGeo({ country: "ZZ" }), undefined);
});

test("keeps a valid lat/lng pair, drops out-of-range or half pairs", () => {
  assert.deepEqual(normaliseGeo({ country: "US", lat: 40.7, lng: -74 }), { country: "US", lat: 40.7, lng: -74 });
  assert.deepEqual(normaliseGeo({ country: "US", lat: 99, lng: 0 }), { country: "US" });
  assert.deepEqual(normaliseGeo({ country: "US", lat: 40.7 } as EventGeo), { country: "US" });
});

test("trims + caps free-text labels; keeps venue/city as display", () => {
  const out = normaliseGeo({ country: "DE", city: "  Berlin ", venue: "Berghain" });
  assert.deepEqual(out, { country: "DE", city: "Berlin", venue: "Berghain" });
  const long = normaliseGeo({ country: "FR", city: "x".repeat(200) });
  assert.equal((long!.city as string).length, 80);
});

test("coords-only geo (no country) is still usable", () => {
  assert.deepEqual(normaliseGeo({ lat: 51.5, lng: -0.12 }), { lat: 51.5, lng: -0.12 });
});

test("nothing usable → undefined", () => {
  assert.equal(normaliseGeo({}), undefined);
  assert.equal(normaliseGeo(undefined), undefined);
  assert.equal(normaliseGeo({ country: "ZZ", address: "" }), undefined);
});

test("preserves the reserved venueRef seam", () => {
  assert.deepEqual(normaliseGeo({ country: "GB", venueRef: "woco:venue:abc" }), { country: "GB", venueRef: "woco:venue:abc" });
});

test("deterministic — same input twice yields deep-equal output", () => {
  const input: EventGeo = { country: "gb", city: "London", venue: "Village Underground", lat: 51.52, lng: -0.07 };
  assert.deepEqual(normaliseGeo(input), normaliseGeo(input));
});

test("geoWithinSizeLimit: accepts legit geo, rejects oversized raw payloads", () => {
  assert.equal(geoWithinSizeLimit({ country: "GB", city: "London", venue: "Village Underground", address: "54 Holywell Ln", lat: 51.52, lng: -0.07 }), true);
  assert.equal(geoWithinSizeLimit({ address: "x".repeat(GEO_MAX_JSON_BYTES + 1) }), false);
  // Multi-byte chars count as UTF-8 bytes, not JS string length.
  assert.equal(geoWithinSizeLimit({ address: "€".repeat(GEO_MAX_JSON_BYTES / 2) }), false);
});

test("helpers: isValidCountryCode + countryName", () => {
  assert.equal(isValidCountryCode("gb"), true);
  assert.equal(isValidCountryCode("ZZ"), false);
  assert.equal(countryName("de"), "Germany");
  assert.equal(countryName("ZZ"), null);
});

test("online: kept as the whole geo, every other field dropped", () => {
  assert.deepEqual(normaliseGeo({ online: true }), { online: true });
  assert.deepEqual(normaliseGeo({ online: true, country: "GB", lat: 52.2, lng: -0.9, venue: "Pub" }), { online: true });
  // Only the literal `true` - a feed is organiser-written JSON.
  assert.equal(normaliseGeo({ online: "yes" } as unknown as EventGeo), undefined);
});

test("eventHasPlace: online, or a valid coordinate pair - nothing else", () => {
  assert.equal(eventHasPlace({ online: true }), true);
  assert.equal(eventHasPlace({ country: "GB", city: "Northampton", lat: 52.2457874, lng: -0.8705699 }), true);
  assert.equal(eventHasPlace({ lat: 0, lng: 0 }), true, "zero is a coordinate");
  assert.equal(eventHasPlace(undefined), false);
  assert.equal(eventHasPlace({}), false);
  assert.equal(eventHasPlace({ country: "GB", city: "Northampton", venue: "The Abington" }), false, "a name is not a place to measure from");
  assert.equal(eventHasPlace({ lat: 52.2 } as EventGeo), false);
  assert.equal(eventHasPlace({ lat: 120, lng: 0 }), false);
  assert.equal(eventHasPlace({ online: false } as unknown as EventGeo), false);
});
