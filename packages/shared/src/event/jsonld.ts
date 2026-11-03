import type { EventFeed, EventGeo, EventTag, FiatCurrency, SeriesSummary } from "./types.js";
import { normaliseTags } from "./tags.js";
import { isValidCountryCode, normaliseGeo } from "./geo.js";
import { headlinePrice } from "./fees.js";

/**
 * schema.org/Event structured data (#55).
 *
 * Why this exists: organiser event pages cannot out-rank Skiddle/RA/Fatsoma on
 * domain authority, but Google's Event rich results are driven by this markup and
 * lean far less on authority than the blue links do. That makes structured data
 * the one SEO surface a small organiser can actually win — see docs/SEO_PLAN.md D4.
 *
 * Two halves, so the markup baked into an event page at publish and the markup the
 * page's runtime sets agree by construction:
 *   - `eventLdFacts` PROJECTS an event to final display values (normalised geo,
 *     the headline price with its booking fee, ISO dates, strings only). It is the
 *     only part that knows fee arithmetic and vocabularies.
 *   - `eventLdObject` SERIALISES those facts, in a fixed key order, with nothing
 *     else on its path. An event page's head carries the facts (`site/event-page.ts`)
 *     and the browser and the server both render them, byte for byte, so nothing that
 *     can change between an app build and a server build may run here.
 * `parseEventLdFacts` is the strict check of facts a browser sends back; the
 * projection only ever produces facts it accepts, so a publish is never refused for
 * what the server itself suggested.
 */

/** Fields this projection needs. Structural so callers can pass a card or a feed. */
export interface EventJsonLdSource {
  title: string;
  tagline?: string;
  description?: string;
  startDate: string;
  endDate?: string;
  /** Free-text display location line. */
  location?: string;
  geo?: EventGeo;
  tags?: EventTag[];
  series?: SeriesSummary[];
}

export interface EventJsonLdOptions {
  /** Canonical URL of the event page. Omitted when the page has no stable address. */
  url?: string;
  /** Fully-resolved image URL (gateway), not a bare Swarm ref. */
  imageUrl?: string;
  /** Display name of the organiser, when known. */
  organiserName?: string;
  /** Cancelled events must say so rather than disappear — a silently removed
   *  event keeps showing stale rich results until the page is re-crawled. */
  cancelled?: boolean;
}

/** Where the event is, as display values. Strings only (see `EventLdFacts`). */
export interface EventLdPlace {
  name: string;
  streetAddress?: string;
  locality?: string;
  /** ISO 3166-1 alpha-2, uppercase. */
  country?: string;
  /** The free-text location line, only when there is no structured address. */
  addressText?: string;
  /** Decimal degrees, always with `lng`. */
  lat?: string;
  lng?: string;
}

/** One ticket type's price: the headline price (booking fee included). */
export interface EventLdOffer {
  name?: string;
  /** Decimal, two places: "12.50". */
  price: string;
  currency: FiatCurrency;
  validFrom?: string;
  validThrough?: string;
}

/**
 * What is true of an event and stable at publish. Every value is a STRING and an
 * absent value is an absent key: the facts cross Node -> browser -> Node as JSON on
 * their way to two renders that must agree, and a string cannot be re-formatted on
 * the way (a number could). Availability and status are deliberately not facts —
 * they change after publish, so only the runtime states them.
 */
export interface EventLdFacts {
  startDate: string;
  endDate?: string;
  place: EventLdPlace;
  offers?: EventLdOffer[];
}

/** The longest text value (a name, an address line) the facts carry. */
export const EVENT_LD_TEXT_MAX = 200;
/** The most ticket types the facts carry. */
export const EVENT_LD_OFFERS_MAX = 20;

/** Adding a currency to `FiatCurrency` fails the build here until it is listed. */
const LD_CURRENCIES: Record<FiatCurrency, true> = { USD: true, GBP: true, EUR: true };
const LD_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})$/;
const LD_PRICE = /^\d{1,6}\.\d{2}$/;
const LD_LAT = /^-?\d{1,2}\.\d{1,6}$/;
const LD_LNG = /^-?\d{1,3}\.\d{1,6}$/;

type Json = Record<string, unknown>;

// ── The checks, shared by the projection and the parser ─────────────────────

function isText(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= EVENT_LD_TEXT_MAX;
}

function isLdDate(v: unknown): v is string {
  return typeof v === "string" && LD_DATE.test(v) && !Number.isNaN(Date.parse(v));
}

function hasOnly(o: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(o).every((k) => keys.includes(k));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isPlace(v: unknown): v is EventLdPlace {
  if (!isRecord(v) || !hasOnly(v, ["name", "streetAddress", "locality", "country", "addressText", "lat", "lng"])) return false;
  if (!isText(v.name)) return false;
  for (const k of ["streetAddress", "locality", "addressText"] as const) {
    if (v[k] !== undefined && !isText(v[k])) return false;
  }
  if (v.country !== undefined && !(typeof v.country === "string" && /^[A-Z]{2}$/.test(v.country) && isValidCountryCode(v.country))) return false;
  // Google requires an address: structured parts, or the free-text line.
  if (v.streetAddress === undefined && v.locality === undefined && v.country === undefined && v.addressText === undefined) return false;
  if ((v.lat === undefined) !== (v.lng === undefined)) return false;
  if (v.lat !== undefined) {
    if (typeof v.lat !== "string" || typeof v.lng !== "string" || !LD_LAT.test(v.lat) || !LD_LNG.test(v.lng)) return false;
    if (Math.abs(parseFloat(v.lat)) > 90 || Math.abs(parseFloat(v.lng)) > 180) return false;
  }
  return true;
}

function isOffer(v: unknown): v is EventLdOffer {
  if (!isRecord(v) || !hasOnly(v, ["name", "price", "currency", "validFrom", "validThrough"])) return false;
  if (v.name !== undefined && !isText(v.name)) return false;
  if (typeof v.price !== "string" || !LD_PRICE.test(v.price)) return false;
  if (typeof v.currency !== "string" || !Object.prototype.hasOwnProperty.call(LD_CURRENCIES, v.currency)) return false;
  if (v.validFrom !== undefined && !isLdDate(v.validFrom)) return false;
  if (v.validThrough !== undefined && !isLdDate(v.validThrough)) return false;
  return true;
}

/**
 * Facts a browser sends back, or null. Strict and non-normalising, like
 * `parseEventPageHead`: known keys only at every level, strings only, no nulls.
 */
export function parseEventLdFacts(v: unknown): EventLdFacts | null {
  if (!isRecord(v) || !hasOnly(v, ["startDate", "endDate", "place", "offers"])) return null;
  if (!isLdDate(v.startDate)) return null;
  if (v.endDate !== undefined && !isLdDate(v.endDate)) return null;
  if (!isPlace(v.place)) return null;
  if (v.offers !== undefined) {
    if (!Array.isArray(v.offers) || v.offers.length < 1 || v.offers.length > EVENT_LD_OFFERS_MAX) return null;
    if (!v.offers.every(isOffer)) return null;
  }
  return v as unknown as EventLdFacts;
}

// ── Projection: an event -> facts ───────────────────────────────────────────

/** Trimmed and capped, never ending on half of a surrogate pair. */
function capText(raw: string | undefined, max = EVENT_LD_TEXT_MAX): string | undefined {
  let s = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
  s = s.trim();
  return s || undefined;
}

/** A stored date as an ISO instant, or undefined when it does not parse. */
function ldDate(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const t = Date.parse(raw.trim());
  if (Number.isNaN(t)) return undefined;
  const iso = new Date(t).toISOString();
  return isLdDate(iso) ? iso : undefined;
}

/** Place from the structured geo, falling back to the free-text line. */
function placeFacts(geo: EventGeo | undefined, freeText: string | undefined): EventLdPlace | null {
  const g = normaliseGeo(geo);
  // An online event has no place, and its joining link is never public.
  if (g?.online) return null;
  const text = capText(freeText);
  const place: EventLdPlace = { name: capText(g?.venue) ?? capText(g?.city) ?? text ?? "Venue" };
  const street = capText(g?.address);
  const locality = capText(g?.city);
  if (street) place.streetAddress = street;
  if (locality) place.locality = locality;
  if (g?.country) place.country = g.country;
  if (!street && !locality && !g?.country && text) place.addressText = text;
  if (typeof g?.lat === "number" && typeof g?.lng === "number") {
    place.lat = g.lat.toFixed(6);
    place.lng = g.lng.toFixed(6);
  }
  return isPlace(place) ? place : null;
}

/** A paid ticket type's headline price. A series nobody can pay for has no offer. */
function offerFacts(series: SeriesSummary): EventLdOffer | null {
  const headline = headlinePrice(series.payment);
  if (!headline || !series.payment) return null;
  const offer: EventLdOffer = { price: headline.amount.toFixed(2), currency: series.payment.currency };
  const name = capText(series.name);
  if (name) offer.name = name;
  const from = ldDate(series.saleStart);
  const through = ldDate(series.saleEnd);
  if (from) offer.validFrom = from;
  if (through) offer.validThrough = through;
  return isOffer(offer) ? offer : null;
}

/**
 * An event's facts, or null when it lacks what Google requires (a start date and a
 * place with an address) — partial markup risks a structured-data penalty, so we
 * emit nothing rather than something invalid. Online events have no facts.
 */
export function eventLdFacts(source: EventJsonLdSource): EventLdFacts | null {
  const startDate = ldDate(source.startDate);
  const place = placeFacts(source.geo, source.location);
  if (!startDate || !place) return null;
  const facts: EventLdFacts = { startDate, place };
  const endDate = ldDate(source.endDate);
  if (endDate) facts.endDate = endDate;
  const offers = (source.series ?? [])
    .map(offerFacts)
    .filter((o): o is EventLdOffer => o !== null)
    .slice(0, EVENT_LD_OFFERS_MAX);
  if (offers.length) facts.offers = offers;
  return parseEventLdFacts(facts);
}

// ── Serialisation: facts -> schema.org ──────────────────────────────────────

/** What a page adds to the facts. Only the runtime knows availability and status. */
export interface EventLdObjectOptions {
  name: string;
  description?: string;
  url?: string;
  imageUrl?: string;
  keywords?: string;
  organiserName?: string;
  status?: "scheduled" | "cancelled";
  /** schema.org availability URL, stated on every offer. */
  availability?: string;
}

/**
 * The schema.org Event for some facts. Pure and in a fixed key order: every object
 * is a literal built here, never a spread of its input.
 */
export function eventLdObject(facts: EventLdFacts, o: EventLdObjectOptions): Json {
  const p = facts.place;
  const place: Json = { "@type": "Place", name: p.name };
  if (p.streetAddress !== undefined || p.locality !== undefined || p.country !== undefined) {
    const address: Json = { "@type": "PostalAddress" };
    if (p.streetAddress !== undefined) address.streetAddress = p.streetAddress;
    if (p.locality !== undefined) address.addressLocality = p.locality;
    if (p.country !== undefined) address.addressCountry = p.country;
    place.address = address;
  } else if (p.addressText !== undefined) {
    // A bare string address is still valid schema.org and beats omitting it.
    place.address = p.addressText;
  }
  if (p.lat !== undefined && p.lng !== undefined) {
    place.geo = { "@type": "GeoCoordinates", latitude: p.lat, longitude: p.lng };
  }

  const ld: Json = {
    "@context": "https://schema.org",
    "@type": "Event",
    name: o.name,
    startDate: facts.startDate,
  };
  if (facts.endDate !== undefined) ld.endDate = facts.endDate;
  ld.location = place;
  ld.eventAttendanceMode = "https://schema.org/OfflineEventAttendanceMode";
  if (o.status) ld.eventStatus = o.status === "cancelled" ? "https://schema.org/EventCancelled" : "https://schema.org/EventScheduled";
  if (o.url) ld.url = o.url;
  if (o.description) ld.description = o.description;
  if (o.imageUrl) ld.image = o.imageUrl;
  if (o.keywords) ld.keywords = o.keywords;
  if (o.organiserName) ld.organizer = { "@type": "Organization", name: o.organiserName };
  if (facts.offers?.length) {
    ld.offers = facts.offers.map((f) => {
      const offer: Json = { "@type": "Offer" };
      if (o.url) offer.url = o.url;
      offer.price = f.price;
      offer.priceCurrency = f.currency;
      if (o.availability) offer.availability = o.availability;
      if (f.name !== undefined) offer.name = f.name;
      if (f.validFrom !== undefined) offer.validFrom = f.validFrom;
      if (f.validThrough !== undefined) offer.validThrough = f.validThrough;
      return offer;
    });
  }
  return ld;
}

/** The longest description an event page carries (meta tags + JSON-LD). */
export const EVENT_DESCRIPTION_MAX = 300;

/**
 * Build a schema.org Event object for a page's runtime: the facts plus what only
 * the live page knows. Null when the event has no title or no facts.
 */
export function buildEventJsonLd(
  source: EventJsonLdSource,
  options: EventJsonLdOptions = {},
): Json | null {
  const name = source.title?.trim();
  const facts = eventLdFacts(source);
  if (!name || !facts) return null;
  const keywords = normaliseTags(source.tags).map((t) => t.value).join(", ");
  return eventLdObject(facts, {
    name,
    description: eventMetaDescription(source, EVENT_DESCRIPTION_MAX - 1) || undefined,
    url: options.url,
    imageUrl: options.imageUrl,
    keywords: keywords || undefined,
    organiserName: options.organiserName?.trim() || undefined,
    status: options.cancelled ? "cancelled" : "scheduled",
    availability: "https://schema.org/InStock",
  });
}

/** Convenience for the common case: a full `EventFeed`. */
export function eventFeedToJsonLd(feed: EventFeed, options: EventJsonLdOptions = {}): Json | null {
  return buildEventJsonLd(feed, options);
}

/**
 * Meta description for an event page. Prefers the tagline (written to be a
 * one-liner), falls back to the opening of the description. Trimmed at a word
 * boundary near `max` (160 = where search results truncate), so at most `max` + 1
 * characters with the ellipsis, never ending on half of a surrogate pair.
 */
export function eventMetaDescription(source: Pick<EventJsonLdSource, "tagline" | "description">, max = 160): string {
  const raw = (source.tagline || source.description || "").replace(/\s+/g, " ").trim();
  if (raw.length <= max) return raw;
  let cut = raw.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > max * 0.6) cut = cut.slice(0, lastSpace);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut.trimEnd() + "…";
}
