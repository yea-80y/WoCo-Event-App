import type { EventGeo } from "./types.js";

/**
 * Structured event geography + its build-time normaliser (#37 location model).
 *
 * WHY this is not a controlled tag: location is hierarchical (country → city →
 * venue) and fundamentally geographic. A flat curated place-name vocabulary can
 * never scale internationally and can't disambiguate ("London"/"Londres", the
 * 30 Springfields). So location lives in a structured `geo` object anchored on
 * COORDINATES — the one universal, language-independent primitive — with an ISO
 * country code as the only controlled facet.
 *
 * DECENTRALISATION: the controlled part (country) is this static bundled list —
 * no server, works offline, forever. The city/venue label + lat/lng are produced
 * by a client-side OPEN places geocoder (OSM/Nominatim/Photon/Mapbox — NOT Google
 * Places, whose ToS forbids storing coordinates) at CREATE time, then baked
 * permanently into the creator-signed feed. Discovery/reads never touch a
 * geocoder — they filter the immutable snapshot cards client-side. Coordinates
 * outlive any provider.
 *
 * Same truth-vs-policy split as tags.ts: raw geo rides in the creator-signed
 * feed (truth); `normaliseGeo` runs when the snapshot builder copies it into a
 * card (policy) so a card only ever carries a known country code + capped fields.
 */

/** One country in the controlled facet. `code` is ISO 3166-1 alpha-2 (uppercase). */
export interface Country {
  code: string;
  name: string;
}

/**
 * ISO 3166-1 alpha-2 countries — the controlled, bundled location facet. Ordered
 * by name for direct rendering in a picker. A place not represented by a code
 * here still lists fine via coordinates (country is the coarse filter, not a gate).
 */
export const COUNTRY_VOCAB: readonly Country[] = [
  { code: "AF", name: "Afghanistan" }, { code: "AX", name: "Åland Islands" },
  { code: "AL", name: "Albania" }, { code: "DZ", name: "Algeria" },
  { code: "AS", name: "American Samoa" }, { code: "AD", name: "Andorra" },
  { code: "AO", name: "Angola" }, { code: "AI", name: "Anguilla" },
  { code: "AQ", name: "Antarctica" }, { code: "AG", name: "Antigua and Barbuda" },
  { code: "AR", name: "Argentina" }, { code: "AM", name: "Armenia" },
  { code: "AW", name: "Aruba" }, { code: "AU", name: "Australia" },
  { code: "AT", name: "Austria" }, { code: "AZ", name: "Azerbaijan" },
  { code: "BS", name: "Bahamas" }, { code: "BH", name: "Bahrain" },
  { code: "BD", name: "Bangladesh" }, { code: "BB", name: "Barbados" },
  { code: "BY", name: "Belarus" }, { code: "BE", name: "Belgium" },
  { code: "BZ", name: "Belize" }, { code: "BJ", name: "Benin" },
  { code: "BM", name: "Bermuda" }, { code: "BT", name: "Bhutan" },
  { code: "BO", name: "Bolivia" }, { code: "BQ", name: "Bonaire, Sint Eustatius and Saba" },
  { code: "BA", name: "Bosnia and Herzegovina" }, { code: "BW", name: "Botswana" },
  { code: "BV", name: "Bouvet Island" }, { code: "BR", name: "Brazil" },
  { code: "IO", name: "British Indian Ocean Territory" }, { code: "BN", name: "Brunei Darussalam" },
  { code: "BG", name: "Bulgaria" }, { code: "BF", name: "Burkina Faso" },
  { code: "BI", name: "Burundi" }, { code: "CV", name: "Cabo Verde" },
  { code: "KH", name: "Cambodia" }, { code: "CM", name: "Cameroon" },
  { code: "CA", name: "Canada" }, { code: "KY", name: "Cayman Islands" },
  { code: "CF", name: "Central African Republic" }, { code: "TD", name: "Chad" },
  { code: "CL", name: "Chile" }, { code: "CN", name: "China" },
  { code: "CX", name: "Christmas Island" }, { code: "CC", name: "Cocos (Keeling) Islands" },
  { code: "CO", name: "Colombia" }, { code: "KM", name: "Comoros" },
  { code: "CG", name: "Congo" }, { code: "CD", name: "Congo (Democratic Republic)" },
  { code: "CK", name: "Cook Islands" }, { code: "CR", name: "Costa Rica" },
  { code: "CI", name: "Côte d'Ivoire" }, { code: "HR", name: "Croatia" },
  { code: "CU", name: "Cuba" }, { code: "CW", name: "Curaçao" },
  { code: "CY", name: "Cyprus" }, { code: "CZ", name: "Czechia" },
  { code: "DK", name: "Denmark" }, { code: "DJ", name: "Djibouti" },
  { code: "DM", name: "Dominica" }, { code: "DO", name: "Dominican Republic" },
  { code: "EC", name: "Ecuador" }, { code: "EG", name: "Egypt" },
  { code: "SV", name: "El Salvador" }, { code: "GQ", name: "Equatorial Guinea" },
  { code: "ER", name: "Eritrea" }, { code: "EE", name: "Estonia" },
  { code: "SZ", name: "Eswatini" }, { code: "ET", name: "Ethiopia" },
  { code: "FK", name: "Falkland Islands" }, { code: "FO", name: "Faroe Islands" },
  { code: "FJ", name: "Fiji" }, { code: "FI", name: "Finland" },
  { code: "FR", name: "France" }, { code: "GF", name: "French Guiana" },
  { code: "PF", name: "French Polynesia" }, { code: "TF", name: "French Southern Territories" },
  { code: "GA", name: "Gabon" }, { code: "GM", name: "Gambia" },
  { code: "GE", name: "Georgia" }, { code: "DE", name: "Germany" },
  { code: "GH", name: "Ghana" }, { code: "GI", name: "Gibraltar" },
  { code: "GR", name: "Greece" }, { code: "GL", name: "Greenland" },
  { code: "GD", name: "Grenada" }, { code: "GP", name: "Guadeloupe" },
  { code: "GU", name: "Guam" }, { code: "GT", name: "Guatemala" },
  { code: "GG", name: "Guernsey" }, { code: "GN", name: "Guinea" },
  { code: "GW", name: "Guinea-Bissau" }, { code: "GY", name: "Guyana" },
  { code: "HT", name: "Haiti" }, { code: "HM", name: "Heard Island and McDonald Islands" },
  { code: "VA", name: "Holy See" }, { code: "HN", name: "Honduras" },
  { code: "HK", name: "Hong Kong" }, { code: "HU", name: "Hungary" },
  { code: "IS", name: "Iceland" }, { code: "IN", name: "India" },
  { code: "ID", name: "Indonesia" }, { code: "IR", name: "Iran" },
  { code: "IQ", name: "Iraq" }, { code: "IE", name: "Ireland" },
  { code: "IM", name: "Isle of Man" }, { code: "IL", name: "Israel" },
  { code: "IT", name: "Italy" }, { code: "JM", name: "Jamaica" },
  { code: "JP", name: "Japan" }, { code: "JE", name: "Jersey" },
  { code: "JO", name: "Jordan" }, { code: "KZ", name: "Kazakhstan" },
  { code: "KE", name: "Kenya" }, { code: "KI", name: "Kiribati" },
  { code: "KP", name: "Korea (North)" }, { code: "KR", name: "Korea (South)" },
  { code: "KW", name: "Kuwait" }, { code: "KG", name: "Kyrgyzstan" },
  { code: "LA", name: "Laos" }, { code: "LV", name: "Latvia" },
  { code: "LB", name: "Lebanon" }, { code: "LS", name: "Lesotho" },
  { code: "LR", name: "Liberia" }, { code: "LY", name: "Libya" },
  { code: "LI", name: "Liechtenstein" }, { code: "LT", name: "Lithuania" },
  { code: "LU", name: "Luxembourg" }, { code: "MO", name: "Macao" },
  { code: "MG", name: "Madagascar" }, { code: "MW", name: "Malawi" },
  { code: "MY", name: "Malaysia" }, { code: "MV", name: "Maldives" },
  { code: "ML", name: "Mali" }, { code: "MT", name: "Malta" },
  { code: "MH", name: "Marshall Islands" }, { code: "MQ", name: "Martinique" },
  { code: "MR", name: "Mauritania" }, { code: "MU", name: "Mauritius" },
  { code: "YT", name: "Mayotte" }, { code: "MX", name: "Mexico" },
  { code: "FM", name: "Micronesia" }, { code: "MD", name: "Moldova" },
  { code: "MC", name: "Monaco" }, { code: "MN", name: "Mongolia" },
  { code: "ME", name: "Montenegro" }, { code: "MS", name: "Montserrat" },
  { code: "MA", name: "Morocco" }, { code: "MZ", name: "Mozambique" },
  { code: "MM", name: "Myanmar" }, { code: "NA", name: "Namibia" },
  { code: "NR", name: "Nauru" }, { code: "NP", name: "Nepal" },
  { code: "NL", name: "Netherlands" }, { code: "NC", name: "New Caledonia" },
  { code: "NZ", name: "New Zealand" }, { code: "NI", name: "Nicaragua" },
  { code: "NE", name: "Niger" }, { code: "NG", name: "Nigeria" },
  { code: "NU", name: "Niue" }, { code: "NF", name: "Norfolk Island" },
  { code: "MK", name: "North Macedonia" }, { code: "MP", name: "Northern Mariana Islands" },
  { code: "NO", name: "Norway" }, { code: "OM", name: "Oman" },
  { code: "PK", name: "Pakistan" }, { code: "PW", name: "Palau" },
  { code: "PS", name: "Palestine" }, { code: "PA", name: "Panama" },
  { code: "PG", name: "Papua New Guinea" }, { code: "PY", name: "Paraguay" },
  { code: "PE", name: "Peru" }, { code: "PH", name: "Philippines" },
  { code: "PN", name: "Pitcairn" }, { code: "PL", name: "Poland" },
  { code: "PT", name: "Portugal" }, { code: "PR", name: "Puerto Rico" },
  { code: "QA", name: "Qatar" }, { code: "RE", name: "Réunion" },
  { code: "RO", name: "Romania" }, { code: "RU", name: "Russia" },
  { code: "RW", name: "Rwanda" }, { code: "BL", name: "Saint Barthélemy" },
  { code: "SH", name: "Saint Helena" }, { code: "KN", name: "Saint Kitts and Nevis" },
  { code: "LC", name: "Saint Lucia" }, { code: "MF", name: "Saint Martin" },
  { code: "PM", name: "Saint Pierre and Miquelon" }, { code: "VC", name: "Saint Vincent and the Grenadines" },
  { code: "WS", name: "Samoa" }, { code: "SM", name: "San Marino" },
  { code: "ST", name: "Sao Tome and Principe" }, { code: "SA", name: "Saudi Arabia" },
  { code: "SN", name: "Senegal" }, { code: "RS", name: "Serbia" },
  { code: "SC", name: "Seychelles" }, { code: "SL", name: "Sierra Leone" },
  { code: "SG", name: "Singapore" }, { code: "SX", name: "Sint Maarten" },
  { code: "SK", name: "Slovakia" }, { code: "SI", name: "Slovenia" },
  { code: "SB", name: "Solomon Islands" }, { code: "SO", name: "Somalia" },
  { code: "ZA", name: "South Africa" }, { code: "GS", name: "South Georgia and the South Sandwich Islands" },
  { code: "SS", name: "South Sudan" }, { code: "ES", name: "Spain" },
  { code: "LK", name: "Sri Lanka" }, { code: "SD", name: "Sudan" },
  { code: "SR", name: "Suriname" }, { code: "SJ", name: "Svalbard and Jan Mayen" },
  { code: "SE", name: "Sweden" }, { code: "CH", name: "Switzerland" },
  { code: "SY", name: "Syria" }, { code: "TW", name: "Taiwan" },
  { code: "TJ", name: "Tajikistan" }, { code: "TZ", name: "Tanzania" },
  { code: "TH", name: "Thailand" }, { code: "TL", name: "Timor-Leste" },
  { code: "TG", name: "Togo" }, { code: "TK", name: "Tokelau" },
  { code: "TO", name: "Tonga" }, { code: "TT", name: "Trinidad and Tobago" },
  { code: "TN", name: "Tunisia" }, { code: "TR", name: "Türkiye" },
  { code: "TM", name: "Turkmenistan" }, { code: "TC", name: "Turks and Caicos Islands" },
  { code: "TV", name: "Tuvalu" }, { code: "UG", name: "Uganda" },
  { code: "UA", name: "Ukraine" }, { code: "AE", name: "United Arab Emirates" },
  { code: "GB", name: "United Kingdom" }, { code: "US", name: "United States" },
  { code: "UM", name: "United States Minor Outlying Islands" }, { code: "UY", name: "Uruguay" },
  { code: "UZ", name: "Uzbekistan" }, { code: "VU", name: "Vanuatu" },
  { code: "VE", name: "Venezuela" }, { code: "VN", name: "Vietnam" },
  { code: "VG", name: "Virgin Islands (British)" }, { code: "VI", name: "Virgin Islands (U.S.)" },
  { code: "WF", name: "Wallis and Futuna" }, { code: "EH", name: "Western Sahara" },
  { code: "YE", name: "Yemen" }, { code: "ZM", name: "Zambia" },
  { code: "ZW", name: "Zimbabwe" },
] as const;

/** Fast membership check for the country facet (uppercase ISO alpha-2). */
const COUNTRY_CODE_SET: ReadonlySet<string> = new Set(COUNTRY_VOCAB.map((c) => c.code));

/** True if `code` is a known ISO 3166-1 alpha-2 country code (case-insensitive). */
export function isValidCountryCode(code: string): boolean {
  return typeof code === "string" && COUNTRY_CODE_SET.has(code.trim().toUpperCase());
}

/** Resolve a country code to its display name, or null if unknown. */
export function countryName(code: string): string | null {
  const cc = typeof code === "string" ? code.trim().toUpperCase() : "";
  return COUNTRY_VOCAB.find((c) => c.code === cc)?.name ?? null;
}

/** Defensive caps — geo rides inside the signed feed and the snapshot card. */
const GEO_LABEL_MAX = 80;
const GEO_ADDR_MAX = 160;
const GEO_REF_MAX = 96;

/** API-boundary sanity cap on RAW geo. The signed EventFeed must fit a 4096-byte
 *  (gzipped) feed page shared with every other field, and legitimate geo tops out
 *  around ~500 bytes — so reject absurd payloads at the route instead of letting
 *  them fail the feed encode mid-publish. */
export const GEO_MAX_JSON_BYTES = 1024;

/** True when `geo` serialises within GEO_MAX_JSON_BYTES (UTF-8). */
export function geoWithinSizeLimit(geo: unknown): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(geo)).length <= GEO_MAX_JSON_BYTES;
  } catch {
    return false;
  }
}

function cleanStr(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().slice(0, max);
  return s || undefined;
}

/**
 * Normalise a creator-supplied geo object for a snapshot card: uppercase +
 * validate the ISO country, trim + cap the free-text labels, and keep lat/lng
 * only as a valid pair inside geographic bounds. Pure + deterministic so a
 * rebuild reproduces byte-identical cards. Returns undefined when nothing usable
 * remains (mirrors normaliseTags — never throw, coerce or drop).
 */
export function normaliseGeo(geo: EventGeo | undefined): EventGeo | undefined {
  if (!geo || typeof geo !== "object") return undefined;
  const out: EventGeo = {};

  if (typeof geo.country === "string") {
    const cc = geo.country.trim().toUpperCase();
    if (COUNTRY_CODE_SET.has(cc)) out.country = cc;
  }
  const city = cleanStr(geo.city, GEO_LABEL_MAX);
  if (city) out.city = city;
  const venue = cleanStr(geo.venue, GEO_LABEL_MAX);
  if (venue) out.venue = venue;
  const address = cleanStr(geo.address, GEO_ADDR_MAX);
  if (address) out.address = address;
  const venueRef = cleanStr(geo.venueRef, GEO_REF_MAX);
  if (venueRef) out.venueRef = venueRef;

  // Coordinates are only meaningful as a valid pair inside geographic bounds.
  if (
    typeof geo.lat === "number" && typeof geo.lng === "number" &&
    Number.isFinite(geo.lat) && Number.isFinite(geo.lng) &&
    geo.lat >= -90 && geo.lat <= 90 && geo.lng >= -180 && geo.lng <= 180
  ) {
    out.lat = geo.lat;
    out.lng = geo.lng;
  }

  // No country, no coords, no label ⇒ nothing to filter or paint by.
  if (!out.country && out.lat === undefined && !out.city && !out.venue) return undefined;
  return out;
}
