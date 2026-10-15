import type { SnapshotCard } from "@woco/shared";
import { COUNTRY_VOCAB, GENRE_VOCAB } from "@woco/shared";
import { haversineKm, type NearMeState } from "../../utils/geo-distance.js";

/**
 * Discover's facet filter (#37), client-side over the snapshot cards. Pure so the
 * rules are tested directly; Home.svelte only holds the selected values.
 */

/** The country menu's choice for online events: they have no country to be filed under. */
export const ONLINE = "online";

export interface DiscoverFilter {
  /** An ISO country code, ONLINE, or "" for any. */
  country: string;
  genres: ReadonlySet<string>;
  nearMe: NearMeState | null;
}

export interface CountryOption {
  code: string;
  name: string;
  count: number;
}

export interface GenreOption {
  value: string;
  count: number;
}

export function passesCountry(e: SnapshotCard, country: string): boolean {
  if (!country) return true;
  if (country === ONLINE) return e.geo?.online === true;
  return e.geo?.country === country;
}

export function passesGenre(e: SnapshotCard, genres: ReadonlySet<string>): boolean {
  if (genres.size === 0) return true;
  return e.tags?.some((t) => t.type === "genre" && genres.has(t.value)) ?? false;
}

/** Distance from the viewer, when both ends have coordinates. */
export function distanceKm(e: SnapshotCard, nearMe: NearMeState | null): number | undefined {
  if (!nearMe || e.geo?.lat === undefined || e.geo?.lng === undefined) return undefined;
  return haversineKm(nearMe.lat, nearMe.lng, e.geo.lat, e.geo.lng);
}

/** Online events and any without coordinates are never "near". */
export function passesNearMe(e: SnapshotCard, nearMe: NearMeState | null): boolean {
  if (!nearMe) return true;
  const km = distanceKm(e, nearMe);
  return km !== undefined && km <= nearMe.radiusKm;
}

export function passesAll(e: SnapshotCard, f: DiscoverFilter): boolean {
  return passesCountry(e, f.country) && passesGenre(e, f.genres) && passesNearMe(e, f.nearMe);
}

/**
 * Options for the country menu. Counts exclude the country facet itself (picking
 * one never hides the others) but respect genre and distance. Only places with
 * events are offered - plus the current choice, so it can always be seen and undone.
 */
export function countryOptions(events: readonly SnapshotCard[], f: DiscoverFilter): CountryOption[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (!passesGenre(e, f.genres) || !passesNearMe(e, f.nearMe)) continue;
    const key = e.geo?.online === true ? ONLINE : e.geo?.country;
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const countries = COUNTRY_VOCAB
    .filter((c) => counts.has(c.code) || c.code === f.country)
    .map((c) => ({ code: c.code, name: c.name, count: counts.get(c.code) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const online = counts.has(ONLINE) || f.country === ONLINE
    ? [{ code: ONLINE, name: "Online", count: counts.get(ONLINE) ?? 0 }]
    : [];
  return [...online, ...countries];
}

/** Genre options, counted under the other two facets. */
export function genreOptions(events: readonly SnapshotCard[], f: DiscoverFilter): GenreOption[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (!passesCountry(e, f.country) || !passesNearMe(e, f.nearMe)) continue;
    for (const t of e.tags ?? []) {
      if (t.type === "genre") counts.set(t.value, (counts.get(t.value) ?? 0) + 1);
    }
  }
  return GENRE_VOCAB.map((value) => ({ value, count: counts.get(value) ?? 0 }));
}

/** A genre no listed event carries is not an option; a selected one stays so it can be turned off. */
export function visibleGenres(options: readonly GenreOption[], selected: ReadonlySet<string>): GenreOption[] {
  return options.filter((g) => g.count > 0 || selected.has(g.value));
}
