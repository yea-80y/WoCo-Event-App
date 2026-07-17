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

let inflight: AbortController | null = null;

/** Debounced by the caller — this just does one lookup, cancelling any prior one. */
export async function searchPlaces(query: string): Promise<PlaceResult[]> {
  const q = query.trim();
  if (q.length < 3) return [];

  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;

  try {
    const url = `${PHOTON_URL}?q=${encodeURIComponent(q)}&limit=6&lang=en`;
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return [];
    const json = await resp.json();
    const features = (json?.features ?? []) as PhotonFeature[];
    return features.map(toResult).filter((r): r is PlaceResult => r !== null);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return [];
    return [];
  }
}
