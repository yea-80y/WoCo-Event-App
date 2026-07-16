import type { EventTag, EventTagType } from "./types.js";

/**
 * Controlled discovery vocabulary + the build-time normaliser.
 *
 * Truth vs policy: tags live in the CREATOR-SIGNED event content (EventFeed).
 * The controlled vocabulary here is a BUILD-TIME FILTER POLICY — the snapshot
 * builder runs `normaliseTags` when it copies tags into a card, so an unknown
 * value is coerced to the free-text `other` facet rather than silently trusted
 * as a controlled facet. This keeps discovery facets clean without turning the
 * vocabulary into a truth-layer (content-signature) constraint.
 *
 * Launch surfaces `location` + `genre`. `artist` / `brand` ride the same
 * mechanism later with no schema change.
 *
 * ⚠️ DRAFT VOCAB — pending owner sign-off. The free-text `other` escape hatch
 * means a missing term never breaks a listing (it just lands under `other`), so
 * this list can grow without a migration. Curate before launch.
 */

/** Controlled city / region values for the `location` facet. Kept separate from
 *  the free-text venue/address string on the event (that stays for display). A
 *  city not listed here still works via the `other` escape hatch. */
export const LOCATION_VOCAB = [
  "London", "Manchester", "Birmingham", "Leeds", "Liverpool", "Bristol",
  "Sheffield", "Newcastle", "Nottingham", "Leicester", "Brighton", "Cardiff",
  "Glasgow", "Edinburgh", "Belfast", "Dublin", "Online",
] as const;

/** Controlled values for the `genre` facet. An event may carry several. */
export const GENRE_VOCAB = [
  "Music", "Nightlife", "Arts & Culture", "Food & Drink", "Film",
  "Comedy", "Theatre & Performance", "Talks & Workshops", "Sports & Fitness",
  "Wellness", "Community", "Markets", "Family", "Business & Networking", "Gaming",
] as const;

/** Facets that enforce a controlled vocabulary at build time. */
const CONTROLLED: Partial<Record<EventTagType, readonly string[]>> = {
  location: LOCATION_VOCAB,
  genre: GENRE_VOCAB,
};

/** The five valid facets — anything else (incl. a non-string) is coerced to `other`
 *  so a malformed/novel type can never enter the signed feed or a snapshot card. */
const VALID_TYPES = new Set<EventTagType>(["location", "genre", "artist", "brand", "other"]);

/** Defensive caps — tags ride inside the signed feed and the snapshot card. */
const MAX_TAGS = 12;
const MAX_VALUE_LEN = 48;

/** Case-insensitive canonical match against a facet's vocabulary. Returns the
 *  vocabulary's own casing (so cards are consistent) or null if unknown. */
function canonicalise(facet: readonly string[], value: string): string | null {
  const needle = value.trim().toLowerCase();
  return facet.find((v) => v.toLowerCase() === needle) ?? null;
}

/**
 * Normalise a creator-supplied tag list for a snapshot card: trim, drop empties,
 * coerce unknown controlled-facet values to `other` (never drop — free-text
 * discovery still works), dedupe by (type,value), and cap. Pure + deterministic
 * so a rebuild reproduces byte-identical cards.
 */
export function normaliseTags(tags: EventTag[] | undefined): EventTag[] {
  if (!tags?.length) return [];
  const out: EventTag[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    if (!raw || typeof raw.value !== "string") continue;
    const value = raw.value.trim().slice(0, MAX_VALUE_LEN);
    if (!value) continue;

    // Coerce any unknown/non-string facet to the free-text `other` bucket.
    let type: EventTagType = VALID_TYPES.has(raw.type) ? raw.type : "other";
    let canonical = value;
    const vocab = CONTROLLED[type];
    if (vocab) {
      const hit = canonicalise(vocab, value);
      if (hit) canonical = hit;
      else type = "other"; // unknown controlled value → free-text facet
    }

    const key = `${type}:${canonical.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type, value: canonical });
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}
