/**
 * Embed resolution for EmbedSection (#212).
 *
 * ---------------------------------------------------------------------------
 * INVARIANT — read this before changing anything in this file.
 * ---------------------------------------------------------------------------
 *
 * An organiser pastes an embed snippet (or a plain link). Previously that text
 * was injected into the page with `{@html}`, on the SAME ORIGIN as the WoCo app
 * — so it could read any visitor's stored session.
 *
 * This module removes that entirely rather than containing it: the organiser's
 * bytes are NEVER rendered. We extract candidate URLs from the text, and render
 * only a URL that has passed all three of:
 *
 *   1. it parses as a URL and its protocol is exactly `https:`;
 *   2. its hostname EXACTLY equals one of a provider's declared hosts;
 *   3. the provider recognises the URL's shape and rebuilds the embed src
 *      itself, from validated components.
 *
 * The returned `src` is bound to the iframe as an attribute by Svelte (set via
 * the DOM, never string-concatenated into markup), so it cannot re-enter a
 * markup position. Nothing else from the organiser's input survives.
 *
 * Host matching is EXACT and must stay exact. Suffix matching is the classic
 * hole here — `endsWith("youtube.com")` also matches `eviltube-youtube.com`.
 * List the `www.`/mobile variants explicitly instead.
 *
 * Adding a provider means adding a row below. Do not add a "pass through any
 * https iframe" escape hatch: the allowlist IS the security property, and the
 * builder tells organisers only supported providers are allowed.
 */

export interface EmbedOk {
  ok: true;
  /** Display name of the matched provider, used as an iframe title fallback. */
  provider: string;
  /** Fully rebuilt, validated embed URL. Safe to bind as an iframe `src`. */
  src: string;
  /** CSS `aspect-ratio` value for responsive media, when the provider scales. */
  aspect: string | null;
  /** Fixed pixel height, for providers whose players do not scale. */
  height: number | null;
}

export interface EmbedFail {
  ok: false;
  /** Organiser-facing explanation. Never contains the input. */
  reason: string;
}

export type EmbedResolution = EmbedOk | EmbedFail;

interface ProviderMatch {
  src: string;
  aspect?: string;
  height?: number;
}

interface Provider {
  name: string;
  /** Exact hostnames, lowercased. Never suffix-matched. */
  hosts: string[];
  /** Rebuild an embed src from a validated URL, or null if the shape is wrong. */
  toEmbed(u: URL): ProviderMatch | null;
}

/** YouTube video ids. Deliberately narrow. */
const YT_ID = /^[A-Za-z0-9_-]{6,20}$/;
/** Spotify resource ids are 22 chars of base62. */
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const SPOTIFY_KINDS = ["track", "album", "playlist", "episode", "show", "artist"];

/** Path segments with empty entries removed, so `/a//b/` → ["a","b"]. */
function segments(u: URL): string[] {
  return u.pathname.split("/").filter(Boolean);
}

const PROVIDERS: Provider[] = [
  {
    name: "YouTube",
    hosts: [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "youtube-nocookie.com",
      "www.youtube-nocookie.com",
      "youtu.be",
    ],
    toEmbed(u) {
      const seg = segments(u);
      let id: string | undefined;
      if (u.hostname === "youtu.be") {
        id = seg[0];
      } else if (seg[0] === "embed" || seg[0] === "shorts" || seg[0] === "live") {
        id = seg[1];
      } else if (seg[0] === "watch") {
        id = u.searchParams.get("v") ?? undefined;
      }
      if (!id || !YT_ID.test(id)) return null;
      // Default to the no-cookie host: it is the same player without the
      // tracking cookie, which keeps a visitor's first view of an organiser
      // page free of third-party profiling.
      return { src: `https://www.youtube-nocookie.com/embed/${id}`, aspect: "16 / 9" };
    },
  },
  {
    name: "Vimeo",
    hosts: ["vimeo.com", "www.vimeo.com", "player.vimeo.com"],
    toEmbed(u) {
      const seg = segments(u);
      const id = seg[0] === "video" ? seg[1] : seg[0];
      if (!id || !/^\d{6,12}$/.test(id)) return null;
      return { src: `https://player.vimeo.com/video/${id}`, aspect: "16 / 9" };
    },
  },
  {
    name: "Spotify",
    hosts: ["open.spotify.com"],
    toEmbed(u) {
      const seg = segments(u);
      // Both `/track/<id>` and the already-embedded `/embed/track/<id>`.
      const rest = seg[0] === "embed" ? seg.slice(1) : seg;
      const [kind, id] = rest;
      if (!kind || !id) return null;
      if (!SPOTIFY_KINDS.includes(kind) || !SPOTIFY_ID.test(id)) return null;
      // Single items get the compact player; collections need the tall one.
      const height = kind === "track" || kind === "episode" ? 152 : 352;
      return { src: `https://open.spotify.com/embed/${kind}/${id}`, height };
    },
  },
  {
    name: "SoundCloud",
    hosts: ["soundcloud.com", "www.soundcloud.com", "w.soundcloud.com"],
    toEmbed(u) {
      // Already a player URL: re-derive it from the inner `url` param rather
      // than trusting the rest of the query string.
      if (u.hostname === "w.soundcloud.com") {
        const inner = u.searchParams.get("url");
        if (!inner) return null;
        let innerUrl: URL;
        try {
          innerUrl = new URL(inner);
        } catch {
          return null;
        }
        if (innerUrl.protocol !== "https:") return null;
        if (!["soundcloud.com", "www.soundcloud.com", "api.soundcloud.com"].includes(innerUrl.hostname)) {
          return null;
        }
        return { src: playerUrlFor(innerUrl), height: 166 };
      }
      // A normal track/set page: /<user>/<track> or /<user>/sets/<set>.
      if (segments(u).length < 2) return null;
      return { src: playerUrlFor(u), height: 166 };
    },
  },
  {
    name: "Mixcloud",
    hosts: ["mixcloud.com", "www.mixcloud.com", "player-widget.mixcloud.com"],
    toEmbed(u) {
      if (u.hostname === "player-widget.mixcloud.com") {
        const feed = u.searchParams.get("feed");
        if (!feed) return null;
        return { src: widgetUrlFor(feed), height: 120 };
      }
      const seg = segments(u);
      if (seg.length < 2) return null;
      return { src: widgetUrlFor(`/${seg.join("/")}/`), height: 120 };
    },
  },
  {
    name: "Bandcamp",
    hosts: ["bandcamp.com"],
    toEmbed(u) {
      // Only the player form. A Bandcamp page URL is not embeddable, and the
      // player path carries its own opaque parameters we pass through as-is
      // after host + prefix validation.
      if (segments(u)[0] !== "EmbeddedPlayer") return null;
      return { src: `https://bandcamp.com${u.pathname}`, height: 120 };
    },
  },
  {
    name: "Apple Music",
    hosts: ["music.apple.com", "embed.music.apple.com"],
    toEmbed(u) {
      if (segments(u).length < 2) return null;
      return { src: `https://embed.music.apple.com${u.pathname}${u.search}`, height: 175 };
    },
  },
  {
    name: "Google Maps",
    hosts: ["google.com", "www.google.com", "maps.google.com"],
    toEmbed(u) {
      const seg = segments(u);
      // Only the dedicated embed endpoint — a normal maps link is not a frame.
      if (seg[0] !== "maps" || seg[1] !== "embed") return null;
      return { src: `https://www.google.com${u.pathname}${u.search}`, aspect: "16 / 9" };
    },
  },
];

function playerUrlFor(track: URL): string {
  const clean = `https://${track.hostname}${track.pathname}`;
  return `https://w.soundcloud.com/player/?url=${encodeURIComponent(clean)}&visual=false&show_comments=false`;
}

function widgetUrlFor(feedPath: string): string {
  return `https://player-widget.mixcloud.com/widget/iframe/?feed=${encodeURIComponent(feedPath)}`;
}

/** Guard against pathological input; an embed snippet is never this long. */
const MAX_INPUT = 20_000;
const MAX_CANDIDATES = 20;

/**
 * Pull candidate absolute URLs out of pasted text.
 *
 * This is intentionally loose — it does not need to parse HTML correctly,
 * because a mis-extracted string cannot do harm: every candidate still has to
 * survive `new URL()`, the https check, the exact-host check and the provider
 * shape check before anything is rendered. The worst outcome of a bad
 * extraction is that we show the organiser "unsupported".
 */
export function candidateUrls(input: string): string[] {
  if (!input) return [];
  const text = input.slice(0, MAX_INPUT).replace(/&amp;/gi, "&");
  const found: string[] = [];
  const re = /https?:\/\/[^\s"'<>()\\]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && found.length < MAX_CANDIDATES) {
    found.push(m[0].replace(/[.,;:!?]+$/, ""));
  }
  return found;
}

/**
 * Resolve pasted embed text to a validated, rebuilt embed URL.
 *
 * Returns the FIRST candidate a provider accepts, so an organiser can paste a
 * full `<iframe …>` snippet or just the link.
 */
export function resolveEmbed(input: string | undefined | null): EmbedResolution {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: false, reason: "No embed added yet." };

  const candidates = candidateUrls(raw);
  if (candidates.length === 0) {
    return { ok: false, reason: "No web address found. Paste the share link or embed code." };
  }

  let sawHttp = false;
  for (const candidate of candidates) {
    let u: URL;
    try {
      u = new URL(candidate);
    } catch {
      continue;
    }
    if (u.protocol !== "https:") {
      sawHttp = true;
      continue;
    }
    const host = u.hostname.toLowerCase();
    for (const provider of PROVIDERS) {
      if (!provider.hosts.includes(host)) continue;
      const match = provider.toEmbed(u);
      if (!match) continue;
      return {
        ok: true,
        provider: provider.name,
        src: match.src,
        aspect: match.aspect ?? null,
        height: match.height ?? null,
      };
    }
  }

  if (sawHttp) {
    return { ok: false, reason: "Only secure (https) links can be embedded." };
  }
  return {
    ok: false,
    reason: `Unsupported source. Supported: ${supportedProviderNames().join(", ")}.`,
  };
}

/** Provider names, for builder guidance copy and the fallback message. */
export function supportedProviderNames(): string[] {
  return PROVIDERS.map((p) => p.name);
}
