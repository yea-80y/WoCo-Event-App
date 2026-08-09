/**
 * EmbedSection no longer renders organiser-pasted HTML at all (#212). What it
 * renders is a URL this resolver rebuilt from validated parts, so the
 * properties pinned here are the ones that make that true:
 *
 *   - nothing resolves unless the host EXACTLY matches an allowlisted provider;
 *   - lookalike hosts that a suffix match would wrongly accept are rejected;
 *   - non-https never resolves;
 *   - the returned src is always a provider URL, never organiser text.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveEmbed,
  candidateUrls,
  supportedProviderNames,
} from "../src/lib/components/site/sections/embed-src.js";

function ok(input: string) {
  const r = resolveEmbed(input);
  assert.ok(r.ok, `expected resolve, got: ${r.ok ? "" : r.reason}`);
  return r;
}

function rejected(input: string, label: string) {
  const r = resolveEmbed(input);
  assert.equal(r.ok, false, `${label}: expected rejection, resolved to ${r.ok ? r.src : ""}`);
}

test("a full iframe snippet resolves to a rebuilt provider url", () => {
  const r = ok('<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" allowfullscreen></iframe>');
  assert.equal(r.provider, "YouTube");
  assert.equal(r.src, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  assert.equal(r.aspect, "16 / 9");
});

test("a plain share link resolves too", () => {
  assert.equal(ok("https://youtu.be/dQw4w9WgXcQ").src, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  assert.equal(
    ok("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=xyz").src,
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
  );
});

test("query strings pasted as HTML entities are decoded before parsing", () => {
  const r = ok('<iframe src="https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=30"></iframe>');
  assert.equal(r.src, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
});

test("other supported providers resolve to their own hosts", () => {
  assert.equal(ok("https://vimeo.com/123456789").src, "https://player.vimeo.com/video/123456789");
  assert.equal(
    ok("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT").src,
    "https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT",
  );
  assert.ok(ok("https://soundcloud.com/artist/track-name").src.startsWith("https://w.soundcloud.com/player/"));
  assert.ok(ok("https://www.mixcloud.com/dj/show/").src.startsWith("https://player-widget.mixcloud.com/"));
  assert.ok(ok("https://bandcamp.com/EmbeddedPlayer/album=123/").src.startsWith("https://bandcamp.com/EmbeddedPlayer/"));
  assert.ok(ok("https://www.google.com/maps/embed?pb=!1m18").src.startsWith("https://www.google.com/maps/embed"));
});

test("audio players get a fixed height, video gets an aspect ratio", () => {
  const track = ok("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT");
  assert.equal(track.height, 152);
  assert.equal(track.aspect, null);

  const playlist = ok("https://open.spotify.com/playlist/4cOdK2wGLETKBW3PvgPWqT");
  assert.equal(playlist.height, 352);

  const video = ok("https://vimeo.com/123456789");
  assert.equal(video.aspect, "16 / 9");
  assert.equal(video.height, null);
});

test("host matching is exact — lookalike domains are refused", () => {
  // Each of these would pass a naive `endsWith` or `includes` host check.
  rejected("https://evil-youtube.com/embed/dQw4w9WgXcQ", "prefixed host");
  rejected("https://youtube.com.attacker.test/embed/dQw4w9WgXcQ", "suffixed host");
  rejected("https://notyoutube.com/embed/dQw4w9WgXcQ", "substring host");
  rejected("https://open.spotify.com.evil.test/track/4cOdK2wGLETKBW3PvgPWqT", "spotify lookalike");
  rejected("https://player.vimeo.com.evil.test/video/123456789", "vimeo lookalike");
});

test("only https resolves", () => {
  rejected("http://www.youtube.com/embed/dQw4w9WgXcQ", "plain http");
  const r = resolveEmbed("http://www.youtube.com/embed/dQw4w9WgXcQ");
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /https/i);
});

test("unsupported and non-url input is refused with guidance", () => {
  rejected("https://example.test/embed/whatever", "unknown provider");
  rejected("just some words", "no url at all");
  rejected("", "empty");
  rejected("   ", "whitespace");

  const r = resolveEmbed("https://example.test/thing");
  assert.equal(r.ok, false);
  // The message names what IS supported, and never echoes the input back.
  for (const name of supportedProviderNames()) {
    assert.ok((r.ok ? "" : r.reason).includes(name), `reason should name ${name}`);
  }
  assert.ok(!(r.ok ? "" : r.reason).includes("example.test"), "reason must not echo input");
});

test("script-bearing paste resolves only via its allowlisted url, never its markup", () => {
  // A paste that mixes a loader script with a legitimate player: the script is
  // simply not part of what gets rendered — only the rebuilt provider url is.
  const r = ok(
    '<script src="https://cdn.evil.test/x.js"></script>' +
      '<iframe src="https://player.vimeo.com/video/123456789"></iframe>',
  );
  assert.equal(r.src, "https://player.vimeo.com/video/123456789");
  assert.ok(!r.src.includes("evil.test"));
});

test("a wrong-shaped url on an allowlisted host still refuses", () => {
  rejected("https://www.youtube.com/", "youtube root");
  rejected("https://open.spotify.com/track/short", "bad spotify id");
  rejected("https://vimeo.com/notanumber", "bad vimeo id");
  rejected("https://bandcamp.com/album/123", "bandcamp non-player path");
  rejected("https://www.google.com/maps/place/somewhere", "maps non-embed path");
});

test("soundcloud player urls are rebuilt from the inner url, not trusted whole", () => {
  const r = ok(
    "https://w.soundcloud.com/player/?url=https%3A//soundcloud.com/artist/track&color=%23ff0000",
  );
  assert.ok(r.src.startsWith("https://w.soundcloud.com/player/?url="));
  assert.ok(!r.src.includes("color"), "extra params from the paste must not survive");

  rejected(
    "https://w.soundcloud.com/player/?url=https%3A//evil.test/track",
    "player pointing off-provider",
  );
});

test("candidateUrls is bounded and strips trailing punctuation", () => {
  assert.deepEqual(candidateUrls("see https://vimeo.com/123456789."), ["https://vimeo.com/123456789"]);
  const many = candidateUrls(Array.from({ length: 50 }, () => "https://a.test/x").join(" "));
  assert.ok(many.length <= 20, `expected a cap, got ${many.length}`);
  assert.deepEqual(candidateUrls(""), []);
});
