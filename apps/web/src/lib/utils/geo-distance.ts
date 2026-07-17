/**
 * Client-side "near me" distance math for the discovery facet filter (#37).
 * Runs entirely in the browser against EventGeo.lat/lng already present on
 * snapshot cards — no geocoder round-trip for a filter/sort operation.
 */

/** Active "near me" facet: the user's located position + chosen search radius. */
export interface NearMeState {
  lat: number;
  lng: number;
  radiusKm: number;
}

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance between two lat/lng points, in kilometres. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Short display label for a distance, e.g. "3.2 km" / "48 km". */
export function formatDistanceKm(km: number): string {
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}
