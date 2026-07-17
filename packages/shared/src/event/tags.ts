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
 * Launch surfaces `genre` here. Location is NOT a tag — it moved to the
 * structured `EventGeo` object (event/geo.ts) because a curated place-name vocab
 * can't scale internationally. `artist` / `brand` (and a future music
 * `subgenre`) ride the same mechanism later with no schema change.
 *
 * The free-text `other` escape hatch means a missing term never breaks a listing
 * (it just lands under `other`), so this list can grow without a migration.
 */

/** Controlled values for the `genre` facet. An event may carry several. */
export const GENRE_VOCAB = [
  "Music", "Nightlife", "Arts & Culture", "Food & Drink", "Film",
  "Comedy", "Theatre & Performance", "Talks & Workshops", "Sports & Fitness",
  "Wellness", "Community", "Markets", "Family", "Business & Networking", "Gaming",
] as const;

/** Facets that enforce a controlled vocabulary at build time. `location` is
 *  intentionally absent — location discovery lives in EventGeo now, so any
 *  legacy `location` tag passes through as free text rather than being coerced. */
const CONTROLLED: Partial<Record<EventTagType, readonly string[]>> = {
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
