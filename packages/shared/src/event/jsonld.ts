import type { EventFeed, EventGeo, EventTag, SeriesSummary } from "./types.js";
import { normaliseTags } from "./tags.js";
import { normaliseGeo } from "./geo.js";

/**
 * schema.org/Event structured data (#55).
 *
 * Why this exists: organiser event pages cannot out-rank Skiddle/RA/Fatsoma on
 * domain authority, but Google's Event rich results are driven by this markup and
 * lean far less on authority than the blue links do. That makes structured data
 * the one SEO surface a small organiser can actually win — see docs/SEO_PLAN.md D4.
 *
 * The #37 discovery fields (`EventGeo`, `EventTag`) are already the exact shape
 * schema.org wants, so this is a projection, not new data. Values go through
 * `normaliseGeo`/`normaliseTags` so markup carries the canonical vocabulary rather
 * than raw creator input.
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
  /** Canonical URL of the event page. Required — Google uses it to dedupe. */
  url: string;
  /** Fully-resolved image URL (gateway), not a bare Swarm ref. */
  imageUrl?: string;
  /** Display name of the organiser, when known. */
  organiserName?: string;
  /** Cancelled events must say so rather than disappear — a silently removed
   *  event keeps showing stale rich results until the page is re-crawled. */
  cancelled?: boolean;
}

type Json = Record<string, unknown>;

/** ISO 4217 currency for an offer. Falls back to GBP only when a price exists
 *  without a currency (legacy `SeriesSummary.price`, which predates PaymentConfig). */
function offerFor(series: SeriesSummary, url: string): Json | null {
  const payment = series.payment;
  const price = payment ? payment.price : series.price != null ? String(series.price) : null;
  if (price == null) return null;

  const offer: Json = {
    "@type": "Offer",
    url,
    price,
    priceCurrency: payment?.currency ?? "GBP",
    availability: "https://schema.org/InStock",
  };
  if (series.name) offer.name = series.name;
  if (series.saleStart) offer.validFrom = series.saleStart;
  if (series.saleEnd) offer.validThrough = series.saleEnd;
  return offer;
}

/** Place block from the structured geo, falling back to the free-text line.
 *  Google requires `location` for Event rich results, so this always returns
 *  something when any location information exists at all. */
function placeFor(geo: EventGeo | undefined, freeText: string | undefined): Json | null {
  const g = normaliseGeo(geo);
  const name = g?.venue || g?.city || freeText?.trim();
  if (!name && !g) return null;

  const place: Json = { "@type": "Place", name: name || "Venue" };

  const address: Json = { "@type": "PostalAddress" };
  if (g?.address) address.streetAddress = g.address;
  if (g?.city) address.addressLocality = g.city;
  if (g?.country) address.addressCountry = g.country;
  // A bare string address is still valid schema.org and beats omitting it.
  place.address = Object.keys(address).length > 1 ? address : (freeText?.trim() || undefined);

  if (typeof g?.lat === "number" && typeof g?.lng === "number") {
    place.geo = { "@type": "GeoCoordinates", latitude: g.lat, longitude: g.lng };
  }
  return place;
}

/**
 * Build a schema.org Event object. Returns null when the event lacks the fields
 * Google requires (name + startDate + location) — emitting partial markup risks a
 * structured-data penalty, so we emit nothing rather than something invalid.
 */
export function buildEventJsonLd(
  source: EventJsonLdSource,
  options: EventJsonLdOptions,
): Json | null {
  const name = source.title?.trim();
  const startDate = source.startDate?.trim();
  const location = placeFor(source.geo, source.location);
  if (!name || !startDate || !location) return null;

  const jsonld: Json = {
    "@context": "https://schema.org",
    "@type": "Event",
    name,
    startDate,
    location,
    url: options.url,
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    eventStatus: options.cancelled
      ? "https://schema.org/EventCancelled"
      : "https://schema.org/EventScheduled",
  };

  if (source.endDate?.trim()) jsonld.endDate = source.endDate.trim();

  const description = (source.description || source.tagline || "").trim();
  if (description) jsonld.description = description;

  if (options.imageUrl) jsonld.image = options.imageUrl;

  const keywords = normaliseTags(source.tags).map((t) => t.value);
  if (keywords.length) jsonld.keywords = keywords.join(", ");

  if (options.organiserName?.trim()) {
    jsonld.organizer = { "@type": "Organization", name: options.organiserName.trim() };
  }

  const offers = (source.series ?? [])
    .map((s) => offerFor(s, options.url))
    .filter((o): o is Json => o !== null);
  if (offers.length) jsonld.offers = offers;

  return jsonld;
}

/** Convenience for the common case: a full `EventFeed`. */
export function eventFeedToJsonLd(feed: EventFeed, options: EventJsonLdOptions): Json | null {
  return buildEventJsonLd(feed, options);
}

/**
 * Meta description for an event page. Prefers the tagline (written to be a
 * one-liner), falls back to the opening of the description. Trimmed at a word
 * boundary near the 160-char mark search results truncate at.
 */
export function eventMetaDescription(source: EventJsonLdSource, max = 160): string {
  const raw = (source.tagline || source.description || "").replace(/\s+/g, " ").trim();
  if (raw.length <= max) return raw;
  const cut = raw.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}
