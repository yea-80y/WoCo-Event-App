/**
 * Discover's filters (layout option B, owner 2026-10-15): the rules run under
 * Node; the layout is checked by SOURCE SCAN, since the components declare
 * `$state`, which Node cannot load.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SnapshotCard, EventGeo } from "@woco/shared";
import {
  ONLINE, passesCountry, passesNearMe, passesAll, countryOptions, genreOptions, visibleGenres, distanceKm,
  type DiscoverFilter,
} from "../src/lib/attendee/home/discover-filter.js";

function card(id: string, geo: EventGeo | undefined, genres: string[] = []): SnapshotCard {
  return {
    eventId: id, title: id, imageHash: "00".repeat(32) as SnapshotCard["imageHash"], startDate: "2099-01-01T19:00:00.000Z",
    location: "", creatorAddress: "0x0000000000000000000000000000000000000001", seriesCount: 1, totalTickets: 10,
    createdAt: "2026-10-15T00:00:00.000Z", tags: genres.map((value) => ({ type: "genre", value })),
    ...(geo ? { geo } : {}),
  } as SnapshotCard;
}

const PUB = card("pub", { country: "GB", city: "Northampton", lat: 52.2457874, lng: -0.8705699 }, ["Music", "Nightlife"]);
const BARN = card("barn", { country: "GB", city: "Kettering", lat: 52.3963, lng: -0.7303 }, ["Music"]);
const ROUNDHOUSE = card("roundhouse", { country: "GB", city: "London", lat: 51.5432, lng: -0.1519 }, ["Comedy"]);
const BERGHAIN = card("berghain", { country: "DE", city: "Berlin", lat: 52.5112, lng: 13.443 }, ["Nightlife"]);
const WEBINAR = card("webinar", { online: true }, ["Talks & Workshops"]);
const OLD = card("old", undefined);
const ALL = [PUB, BARN, ROUNDHOUSE, BERGHAIN, WEBINAR, OLD];

const NORTHAMPTON = { lat: 52.2405, lng: -0.9027, radiusKm: 50 };
const none: DiscoverFilter = { country: "", genres: new Set(), nearMe: null };
const ids = (cards: SnapshotCard[]) => cards.map((c) => c.eventId);

test("near me keeps what is inside the radius, measured from the viewer", () => {
  const near = ALL.filter((e) => passesNearMe(e, NORTHAMPTON));
  assert.deepEqual(ids(near), ["pub", "barn"], "London is ~95 km away");
  assert.ok(Math.abs(distanceKm(PUB, NORTHAMPTON)! - 2.3) < 0.2);
  assert.deepEqual(ids(ALL.filter((e) => passesNearMe(e, { ...NORTHAMPTON, radiusKm: 100 }))), ["pub", "barn", "roundhouse"]);
});

test("online events and events with no place are never near", () => {
  assert.equal(passesNearMe(WEBINAR, NORTHAMPTON), false);
  assert.equal(passesNearMe(OLD, NORTHAMPTON), false);
  assert.equal(distanceKm(WEBINAR, NORTHAMPTON), undefined);
});

test("Online is a choice in the country menu, and picking it shows only online events", () => {
  assert.deepEqual(ids(ALL.filter((e) => passesCountry(e, ONLINE))), ["webinar"]);
  assert.deepEqual(ids(ALL.filter((e) => passesCountry(e, "GB"))), ["pub", "barn", "roundhouse"]);
  const opts = countryOptions(ALL, none);
  assert.deepEqual(opts.map((o) => `${o.code}:${o.count}`), ["online:1", "GB:3", "DE:1"]);
});

test("the country menu counts under the other facets, never its own", () => {
  const nearOpts = countryOptions(ALL, { ...none, nearMe: NORTHAMPTON });
  assert.deepEqual(nearOpts.map((o) => `${o.code}:${o.count}`), ["GB:2"], "online is not near, so it is not offered");
  const picked = countryOptions(ALL, { ...none, country: "DE", nearMe: NORTHAMPTON });
  assert.ok(picked.some((o) => o.code === "DE" && o.count === 0), "the current choice stays visible so it can be undone");
});

test("genres: counted under the other facets; only genres events carry are shown, plus any selected", () => {
  const near = genreOptions(ALL, { ...none, nearMe: NORTHAMPTON });
  const count = (v: string) => near.find((g) => g.value === v)?.count;
  assert.equal(count("Music"), 2);
  assert.equal(count("Nightlife"), 1);
  assert.equal(count("Comedy"), 0);
  assert.deepEqual(visibleGenres(near, new Set()).map((g) => g.value), ["Music", "Nightlife"]);
  assert.deepEqual(visibleGenres(near, new Set(["Comedy"])).map((g) => g.value), ["Music", "Nightlife", "Comedy"]);
  assert.deepEqual(visibleGenres(genreOptions([OLD], none), new Set()), [], "no tagged events: no genre row at all");
});

test("all three facets combine", () => {
  const f: DiscoverFilter = { country: "GB", genres: new Set(["Music"]), nearMe: NORTHAMPTON };
  assert.deepEqual(ids(ALL.filter((e) => passesAll(e, f))), ["pub", "barn"]);
  assert.deepEqual(ids(ALL.filter((e) => passesAll(e, none))), ids(ALL), "no filter hides nothing");
});

// ---------------------------------------------------------------------------
// The layout
// ---------------------------------------------------------------------------

const SRC = new URL("../src/", import.meta.url).pathname;
const read = (p: string) => readFileSync(SRC + p, "utf-8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const HOME = code(read("lib/attendee/home/Home.svelte"));
const ROW = code(read("lib/attendee/home/GenreRow.svelte"));

test("the place sits in the headline, genres under it, country beside the tabs", () => {
  const hero = HOME.slice(HOME.indexOf('<section class="hero">'), HOME.indexOf("</section>"));
  assert.match(hero, /<NearMeLine bind:nearMe \/>/, "the distance choice is part of the hero");
  const afterHero = HOME.slice(HOME.indexOf("</section>"));
  assert.ok(afterHero.indexOf("<GenreRow") < afterHero.indexOf('<div class="tabs">'), "genres sit between the hero and the tabs");
  const tabs = afterHero.slice(afterHero.indexOf('<div class="tabs">'), afterHero.indexOf('<section class="events-section">'));
  assert.match(tabs, /class="country-select" bind:value=\{country\}/);
  assert.doesNotMatch(HOME, /DiscoveryFilters/);
});

test("the filtering itself is the tested module, not a copy in the page", () => {
  assert.match(HOME, /allEvents\.filter\(\(e\) => passesAll\(e, filter\)\)/);
  assert.match(HOME, /countryOptions\(allEvents, filter\)/);
  assert.match(HOME, /genreOptions\(allEvents, filter\)/);
  assert.match(ROW, /visibleGenres\(genres, selectedGenres\)/);
  assert.doesNotMatch(HOME, /haversineKm/, "distance comes from discover-filter, one formula");
});
