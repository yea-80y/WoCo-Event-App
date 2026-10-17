/**
 * The event place picker (owner, 2026-10-15): one search box, manual entry only
 * when a search has ANSWERED and found nothing useful - never because it is slow -
 * and no event published or saved without a place or Online.
 *
 * The geocoder module runs under Node against a stubbed fetch. The components
 * declare `$state`, which Node cannot load, so they are checked by SOURCE SCAN.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { photonUrl, zoneBias, searchPlaces, cachedPlaces } from "../src/lib/geo/photon.js";

const SRC = new URL("../src/", import.meta.url).pathname;
const read = (p: string) => readFileSync(SRC + p, "utf-8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const PUB_FEATURE = {
  properties: { name: "The Abington Public House", street: "Wellingborough Road", housenumber: "383", city: "Northampton", country: "United Kingdom", countrycode: "GB", osm_key: "amenity", osm_value: "pub" },
  geometry: { coordinates: [-0.8705699, 52.2457874] },
};

type FetchFn = typeof fetch;
const realFetch = globalThis.fetch;
function stubFetch(fn: (url: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => fn(String(input), init)) as FetchFn;
}
test.afterEach(() => { globalThis.fetch = realFetch; });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("the URL: towns-only adds the city layer; a bias ranks, rounded to ~1 km", () => {
  const venue = new URL(photonUrl("Abington Pub", "place"));
  assert.equal(venue.searchParams.get("q"), "Abington Pub");
  assert.equal(venue.searchParams.get("layer"), null);
  const town = new URL(photonUrl("Ketter", "town", { lat: 52.245787, lng: -0.870569 }));
  assert.equal(town.searchParams.get("layer"), "city");
  assert.equal(town.searchParams.get("lat"), "52.25");
  assert.equal(town.searchParams.get("lon"), "-0.87");
});

test("a first-time organiser's search leans toward their time zone, and an unknown zone adds nothing", () => {
  assert.ok(zoneBias("Europe/London"));
  assert.equal(zoneBias("Mars/Olympus"), undefined);
  assert.equal(zoneBias(undefined), undefined);
});

test("a search that answers returns its places, and the same query is then answered without the network", async () => {
  let calls = 0;
  stubFetch(async () => { calls++; return json({ features: [PUB_FEATURE] }); });
  const out = await searchPlaces("abington public house");
  assert.equal(out.status, "ok");
  assert.equal(out.status === "ok" && out.results[0]?.venue, "The Abington Public House");
  assert.equal(out.status === "ok" && out.results[0]?.countryCode, "GB");
  assert.ok(cachedPlaces("Abington Public House  "), "case and spacing do not miss the cache");
  await searchPlaces("Abington Public House");
  assert.equal(calls, 1);
});

test("a failed lookup is an ERROR, never 'no match' - so it cannot offer manual entry", async () => {
  stubFetch(async () => json({ message: "rate limited" }, 429));
  assert.deepEqual(await searchPlaces("failing query one"), { status: "error" });
  stubFetch(async () => { throw new TypeError("network down"); });
  assert.deepEqual(await searchPlaces("failing query two"), { status: "error" });
  assert.equal(cachedPlaces("failing query one"), undefined, "a failure is not remembered as an answer");
});

test("an empty answer is a real 'no match'", async () => {
  stubFetch(async () => json({ features: [] }));
  assert.deepEqual(await searchPlaces("joes barn nowhere"), { status: "ok", results: [] });
});

test("a search replaced by a newer one on the same box is superseded, not an error", async () => {
  stubFetch((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  }));
  const first = searchPlaces("slow first query");
  stubFetch(async () => json({ features: [PUB_FEATURE] }));
  const second = searchPlaces("second query");
  assert.deepEqual(await first, { status: "superseded" });
  assert.equal((await second).status, "ok");
});

test("the town box and the venue box do not cancel each other", async () => {
  let release!: () => void;
  stubFetch((url, init) => url.includes("layer=city")
    ? Promise.resolve(json({ features: [] }))
    : new Promise((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      release = () => resolve(json({ features: [PUB_FEATURE] }));
    }));
  const venue = searchPlaces("venue box query");
  const town = await searchPlaces("town box query", "town");
  assert.equal(town.status, "ok");
  release();
  assert.equal((await venue).status, "ok");
});

// ---------------------------------------------------------------------------
// The components
// ---------------------------------------------------------------------------

const SEARCH = code(read("lib/creator/events/PlaceSearch.svelte"));
const PICKER = code(read("lib/creator/events/LocationPicker.svelte"));
const EDITOR = code(read("lib/creator/events/EventEditor.svelte"));
const PANEL = code(read("lib/creator/events/EditEventPanel.svelte"));
const BUTTON = code(read("lib/creator/events/PublishButton.svelte"));

test("manual entry is offered only for the query a finished search answered", () => {
  assert.match(SEARCH, /const current = \$derived\(answered && answered\.query === query\.trim\(\) && !loading \? answered : null\);/);
  // Every place that offers it is behind an answered, successful search.
  const offers = [...SEARCH.matchAll(/onclick=\{manual\}|mousedown[^\n]*manual\(\)/g)].length;
  assert.equal(offers, 2, "the dropdown row and the no-match note - nowhere else");
  assert.match(SEARCH, /\{#if onmanual && current\?\.status === "ok"\}/);
  assert.match(SEARCH, /const noMatch = \$derived\(current\?\.status === "ok" && results\.length === 0\);/);
  assert.match(SEARCH, /\{#if current\?\.status === "error"\}[\s\S]*?Try again[\s\S]*?\{:else if noMatch\}/, "an error offers a retry, not manual entry");
});

test("the place comes from the picker alone - no free-text location box is left", () => {
  for (const [name, src] of [["EventEditor", EDITOR], ["EditEventPanel", PANEL]] as const) {
    assert.doesNotMatch(src, /bind:value=\{location\}/, `${name} must not keep a separate location box`);
    assert.match(src, /<LocationPicker bind:geo bind:location \/>/, `${name} must render the picker`);
  }
});

test("online, a picked place, or a venue with a picked town - each writes a place", () => {
  assert.match(PICKER, /if \(mode === "online"\) return \{ geo: \{ online: true \}, line: "Online" \};/);
  assert.match(PICKER, /if \(!venue \|\| !town\) return \{ geo: undefined, line: "" \};/, "manual entry needs the town's coordinates");
  assert.match(PICKER, /lat: town\.lat,\s*lng: town\.lng,/);
  assert.match(PICKER, /const g: EventGeo = \{ lat: place\.lat, lng: place\.lng \};/);
});

test("publish and save both wait for a place", () => {
  assert.match(BUTTON, /const hasPlace = \$derived\(eventHasPlace\(geo\)\);/);
  assert.match(BUTTON, /const canPublish = \$derived\(\s*title\.trim\(\) &&\s*hasPlace &&/);
  assert.match(PANEL, /const canSave = \$derived\(.*&& hasPlace\);/);
  assert.match(PANEL, /if \(geo && !geoEqual\(geo, event\.geo\)\) updates\.geo = geo;/, "an edit never sends an empty geo");
});
