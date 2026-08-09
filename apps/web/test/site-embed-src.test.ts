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

test("mixcloud widget feeds are validated and rebuilt, not passed through", () => {
  // A widget URL whose feed already points at Mixcloud: kept, but rebuilt from
  // the path alone so the pasted scheme/host/query are discarded.
  const r = ok("https://player-widget.mixcloud.com/widget/iframe/?feed=%2Fdj%2Fshow%2F");
  assert.equal(r.src, "https://player-widget.mixcloud.com/widget/iframe/?feed=%2Fdj%2Fshow%2F");

  const fromUrl = ok(
    "https://player-widget.mixcloud.com/widget/iframe/?feed=https%3A%2F%2Fwww.mixcloud.com%2Fdj%2Fshow%2F&hide_cover=1",
  );
  assert.equal(fromUrl.src, "https://player-widget.mixcloud.com/widget/iframe/?feed=%2Fdj%2Fshow%2F");
  assert.ok(!fromUrl.src.includes("hide_cover"), "pasted query must not survive");

  // An allowlisted widget aimed at an off-provider feed. The frame's own origin
  // would still be Mixcloud's, which is why this needs its own check.
  rejected(
    "https://player-widget.mixcloud.com/widget/iframe/?feed=https%3A%2F%2Fevil.test%2Fx",
    "off-provider feed url",
  );
  rejected(
    "https://player-widget.mixcloud.com/widget/iframe/?feed=http%3A%2F%2Fwww.mixcloud.com%2Fdj%2Fshow%2F",
    "non-https feed url",
  );
  rejected(
    "https://player-widget.mixcloud.com/widget/iframe/?feed=%2F%2Fevil.test%2Fx",
    "protocol-relative feed",
  );
  rejected("https://player-widget.mixcloud.com/widget/iframe/", "missing feed");
});

test("instagram posts, reels and tv resolve to the iframe embed path", () => {
  assert.equal(
    ok("https://www.instagram.com/p/C1yZ8XkNQrS/").src,
    "https://www.instagram.com/p/C1yZ8XkNQrS/embed/",
  );
  assert.equal(
    ok("https://www.instagram.com/reel/C1yZ8XkNQrS/?igsh=tracking").src,
    "https://www.instagram.com/reel/C1yZ8XkNQrS/embed/",
  );
  // Already an embed URL — idempotent, and the tracking query is dropped.
  assert.equal(
    ok("https://www.instagram.com/p/C1yZ8XkNQrS/embed/").src,
    "https://www.instagram.com/p/C1yZ8XkNQrS/embed/",
  );
  rejected("https://www.instagram.com/someprofile/", "profile, not a post");
  rejected("https://www.instagram.com/", "instagram root");
});

test("tiktok resolves from the share link or an existing embed url", () => {
  assert.equal(
    ok("https://www.tiktok.com/@scout2015/video/6718335390845095173").src,
    "https://www.tiktok.com/embed/v2/6718335390845095173",
  );
  assert.equal(
    ok("https://www.tiktok.com/embed/v2/6718335390845095173").src,
    "https://www.tiktok.com/embed/v2/6718335390845095173",
  );
  rejected("https://www.tiktok.com/@scout2015", "profile, not a video");
  rejected("https://www.tiktok.com/@x/video/notanid", "non-numeric id");
  // Short links need a network round trip to resolve; this module makes none.
  rejected("https://vm.tiktok.com/ZMabcdef/", "short link host");
});

test("facebook plugin href is validated and rebuilt, not passed through", () => {
  const post = ok("https://www.facebook.com/20531316728/posts/10154009990506729");
  assert.ok(post.src.startsWith("https://www.facebook.com/plugins/post.php?href="));
  assert.ok(post.src.includes(encodeURIComponent("https://www.facebook.com/20531316728/posts/10154009990506729")));

  const video = ok("https://www.facebook.com/somepage/videos/1234567890/");
  assert.ok(video.src.startsWith("https://www.facebook.com/plugins/video.php?href="));
  assert.equal(video.aspect, "16 / 9");

  // An allowlisted plugin aimed off-provider — the frame origin would still be
  // Facebook's, which is exactly why the href needs its own check.
  rejected(
    "https://www.facebook.com/plugins/post.php?href=https%3A%2F%2Fevil.test%2Fx",
    "off-provider href",
  );
  rejected(
    "https://www.facebook.com/plugins/post.php?href=http%3A%2F%2Fwww.facebook.com%2Fx%2Fposts%2F1",
    "non-https href",
  );
  rejected(
    "https://www.facebook.com/plugins/post.php?href=https%3A%2F%2Fwww.facebook.com%2Fplugins%2Fpost.php%3Fhref%3Dx",
    "plugin nested in a plugin",
  );
  rejected("https://www.facebook.com/plugins/post.php", "missing href");
});

test("youtube playlists resolve, but a single video still wins", () => {
  const list = "PLabcdefghijklmnop";
  assert.equal(
    ok(`https://www.youtube.com/playlist?list=${list}`).src,
    `https://www.youtube-nocookie.com/embed/videoseries?list=${list}`,
  );
  assert.equal(
    ok(`https://www.youtube.com/embed/videoseries?list=${list}`).src,
    `https://www.youtube-nocookie.com/embed/videoseries?list=${list}`,
  );
  // A watch URL carrying both means "this video", not "this playlist".
  assert.equal(
    ok(`https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=${list}`).src,
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
  );
  rejected("https://www.youtube.com/playlist?list=short", "bad playlist id");
});

test("the new providers are exact-host too", () => {
  rejected("https://instagram.com.evil.test/p/C1yZ8XkNQrS/", "instagram lookalike");
  rejected("https://evil-tiktok.com/@x/video/6718335390845095173", "tiktok lookalike");
  rejected("https://facebook.com.evil.test/x/posts/1", "facebook lookalike");
});

test("candidateUrls is bounded and strips trailing punctuation", () => {
  assert.deepEqual(candidateUrls("see https://vimeo.com/123456789."), ["https://vimeo.com/123456789"]);
  const many = candidateUrls(Array.from({ length: 50 }, () => "https://a.test/x").join(" "));
  assert.ok(many.length <= 20, `expected a cap, got ${many.length}`);
  assert.deepEqual(candidateUrls(""), []);
});
