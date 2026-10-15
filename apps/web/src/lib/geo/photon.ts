import { isValidCountryCode } from "@woco/shared";

/**
 * Client-side open-places geocoder (Photon — https://photon.komoot.io), used ONLY
 * at event-create/edit time to resolve a venue/city search into coordinates. Never
 * Google Places: its ToS forbids permanently storing coordinates, which is exactly
 * what the signed EventFeed does. Photon (not Nominatim) because it's built for
 * search-as-you-type — Nominatim's usage policy explicitly disallows autocomplete
 * hitting its endpoint directly.
 */

const PHOTON_URL = "https://photon.komoot.io/api/";
/** Photon usually answers in under a second; past this it is down, not slow. */
const SEARCH_TIMEOUT_MS = 8000;

export interface PlaceResult {
  /** Primary line for the results dropdown — venue/place name, or the city itself. */
  label: string;
  /** Secondary line for the dropdown — the disambiguating context (city, country…). */
  secondary: string;
  city?: string;
  venue?: string;
  address?: string;
  /** ISO 3166-1 alpha-2, uppercase — only set when it matches our bundled vocab. */
  countryCode?: string;
  lat: number;
  lng: number;
}

/** `place`: venues, addresses and towns. `town`: towns and cities only. */
export type SearchKind = "place" | "town";

/** `superseded`: a newer search on the same box replaced this one - ignore it. */
export type SearchOutcome =
  | { status: "ok"; results: PlaceResult[] }
  | { status: "error" }
  | { status: "superseded" };

export interface LatLng {
  lat: number;
  lng: number;
}

interface PhotonProperties {
  name?: string;
  city?: string;
  state?: string;
  country?: string;
  countrycode?: string;
  osm_key?: string;
  osm_value?: string;
  street?: string;
  housenumber?: string;
}

interface PhotonFeature {
  properties: PhotonProperties;
  geometry: { coordinates: [number, number] };
}

/** Photon's `place` osm_key covers cities/towns/villages/etc — a bare area, not a venue. */
function isAreaResult(props: PhotonProperties): boolean {
  return props.osm_key === "place";
}

function toResult(f: PhotonFeature): PlaceResult | null {
  const props = f.properties;
  const [lng, lat] = f.geometry.coordinates;
  if (typeof lat !== "number" || typeof lng !== "number") return null;

  const countryCode = props.countrycode?.toUpperCase();
  const validCountry = countryCode && isValidCountryCode(countryCode) ? countryCode : undefined;
  const area = isAreaResult(props);

  const city = area ? props.name : props.city;
  const venue = area ? undefined : props.name;
  const address = !area && (props.street || props.housenumber)
    ? [props.housenumber, props.street].filter(Boolean).join(" ")
    : undefined;

  const label = props.name || address || "Unnamed place";
  const secondary = [
    !area ? city : undefined,
    props.state,
    props.country,
  ].filter((p, i, arr) => p && arr.indexOf(p) === i && p !== label).join(", ");

  return { label, secondary, city, venue, address, countryCode: validCountry, lat, lng };
}

/**
 * Human-readable single line for the event's free-text `location` display field,
 * built from a resolved place — venue/city/country, de-duplicated.
 */
export function locationLineFor(result: PlaceResult, countryName?: string): string {
  return [result.venue, result.address, result.city, countryName]
    .filter((p, i, arr) => p && arr.indexOf(p) === i)
    .join(", ");
}

/** The lookup URL. `bias` ranks results near it first; it never excludes any. */
export function photonUrl(query: string, kind: SearchKind, bias?: LatLng): string {
  const params = new URLSearchParams({ q: query, limit: "6", lang: "en" });
  if (kind === "town") params.append("layer", "city");
  if (bias) {
    params.set("lat", bias.lat.toFixed(2));
    params.set("lon", bias.lng.toFixed(2));
  }
  return `${PHOTON_URL}?${params}`;
}

// Organisers mostly run events where they ran the last one, so its place ranks
// the next search. Two decimals (~1 km) is all a ranking needs.
const LAST_PLACE_KEY = "woco:geo:last-place";

export function rememberPlace(p: LatLng): void {
  try {
    localStorage.setItem(LAST_PLACE_KEY, JSON.stringify({ lat: +p.lat.toFixed(2), lng: +p.lng.toFixed(2) }));
  } catch { /* storage blocked: the next search is just unranked */ }
}

function lastPlace(): LatLng | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_PLACE_KEY) ?? "null") as Partial<LatLng> | null;
    return typeof v?.lat === "number" && typeof v.lng === "number" ? { lat: v.lat, lng: v.lng } : undefined;
  } catch {
    return undefined;
  }
}

/** A first-time organiser's rough whereabouts, from the browser's own time zone
 *  (no permission, nothing sent anywhere): roughly where the zone's people live. */
const ZONE_CITIES: Record<string, LatLng> = {
  "Europe/London": { lat: 52.5, lng: -1.5 }, "Europe/Dublin": { lat: 53.35, lng: -6.26 },
  "Europe/Paris": { lat: 48.86, lng: 2.35 }, "Europe/Berlin": { lat: 52.52, lng: 13.4 },
  "Europe/Amsterdam": { lat: 52.37, lng: 4.9 }, "Europe/Brussels": { lat: 50.85, lng: 4.35 },
  "Europe/Madrid": { lat: 40.42, lng: -3.7 }, "Europe/Lisbon": { lat: 38.72, lng: -9.14 },
  "Europe/Rome": { lat: 41.9, lng: 12.5 }, "Europe/Zurich": { lat: 47.37, lng: 8.54 },
  "Europe/Vienna": { lat: 48.21, lng: 16.37 }, "Europe/Prague": { lat: 50.08, lng: 14.44 },
  "Europe/Warsaw": { lat: 52.23, lng: 21.01 }, "Europe/Copenhagen": { lat: 55.68, lng: 12.57 },
  "Europe/Stockholm": { lat: 59.33, lng: 18.07 }, "Europe/Oslo": { lat: 59.91, lng: 10.75 },
  "Europe/Helsinki": { lat: 60.17, lng: 24.94 }, "Europe/Athens": { lat: 37.98, lng: 23.73 },
  "America/New_York": { lat: 40.71, lng: -74.01 }, "America/Chicago": { lat: 41.88, lng: -87.63 },
  "America/Denver": { lat: 39.74, lng: -104.99 }, "America/Los_Angeles": { lat: 34.05, lng: -118.24 },
  "America/Toronto": { lat: 43.65, lng: -79.38 }, "America/Vancouver": { lat: 49.28, lng: -123.12 },
  "Australia/Sydney": { lat: -33.87, lng: 151.21 }, "Australia/Melbourne": { lat: -37.81, lng: 144.96 },
  "Asia/Singapore": { lat: 1.35, lng: 103.82 }, "Asia/Tokyo": { lat: 35.68, lng: 139.69 },
  "Asia/Dubai": { lat: 25.2, lng: 55.27 }, "Asia/Kolkata": { lat: 19.08, lng: 72.88 },
  "Africa/Lagos": { lat: 6.52, lng: 3.38 }, "Africa/Johannesburg": { lat: -26.2, lng: 28.05 },
};

export function zoneBias(zone: string | undefined): LatLng | undefined {
  return zone ? ZONE_CITIES[zone] : undefined;
}

function searchBias(): LatLng | undefined {
  let zone: string | undefined;
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* no Intl zone */ }
  return lastPlace() ?? zoneBias(zone);
}

// Typing back over a query, or re-opening the picker, answers from here at once.
const cache = new Map<string, PlaceResult[]>();
const inflight: Partial<Record<SearchKind, AbortController>> = {};

/** The answer already held for this query, if any - no network. */
export function cachedPlaces(query: string, kind: SearchKind = "place"): PlaceResult[] | undefined {
  return cache.get(`${kind}|${query.trim().toLowerCase()}`);
}

/**
 * One lookup, cancelling the previous one for the same `kind`. Debounced by the
 * caller. `error` is a failed or timed-out lookup - never reported as "no match",
 * which is what lets the picker offer manual entry only when a search really
 * found nothing.
 */
export async function searchPlaces(query: string, kind: SearchKind = "place"): Promise<SearchOutcome> {
  const q = query.trim();
  if (q.length < 3) return { status: "ok", results: [] };
  const hit = cachedPlaces(q, kind);
  if (hit) return { status: "ok", results: hit };

  inflight[kind]?.abort();
  const controller = new AbortController();
  inflight[kind] = controller;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, SEARCH_TIMEOUT_MS);

  try {
    const resp = await fetch(photonUrl(q, kind, searchBias()), { signal: controller.signal });
    if (!resp.ok) return { status: "error" };
    const json = await resp.json();
    const features = (json?.features ?? []) as PhotonFeature[];
    const results = features.map(toResult).filter((r): r is PlaceResult => r !== null);
    cache.set(`${kind}|${q.toLowerCase()}`, results);
    return { status: "ok", results };
  } catch {
    return controller.signal.aborted && !timedOut ? { status: "superseded" } : { status: "error" };
  } finally {
    clearTimeout(timer);
    if (inflight[kind] === controller) delete inflight[kind];
  }
}
