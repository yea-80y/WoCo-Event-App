/**
 * The footer's tiny version mark (owner 2026-10-22): read from the upload's
 * `woco-feed` stamp, which a handover rewrites (build-swap.ts), so it names the build
 * actually running.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { runningBuildIndex } = await import("../src/lib/boot/build-label.ts");
const OWNER = "f8af4904c6e4f08ce5f7deab7f01221280b23a80";
const TOPIC = "aef7b3bb8b50eff1516536370de7ab15de8e24592a35d2abd9977d00ebb650b2";
const page = (content: string | null) => ({
  querySelector: (sel: string) => (sel === 'meta[name="woco-feed"]' && content !== null ? { getAttribute: () => content } : null),
}) as unknown as Pick<Document, "querySelector">;

test("the stamped feed index, or nothing", () => {
  assert.equal(runningBuildIndex(page(`v1 ${OWNER} ${TOPIC} 269`)), 269);
  assert.equal(runningBuildIndex(page(null)), null, "dev: no stamp");
  assert.equal(runningBuildIndex(page("v1 not-a-stamp 269")), null);
  assert.equal(runningBuildIndex(undefined), null);
});

test("the stamp it reads is the one the upload writes and a handover rewrites", () => {
  assert.ok(readFileSync(new URL("../../../scripts/upload-to-swarm-feed.cjs", import.meta.url), "utf8").includes('`<meta name="woco-feed" content="v1 ${ownerHex.toLowerCase()} ${topic.toString()} ${nextIdx}">`'));
  assert.ok(readFileSync(new URL("../src/lib/boot/build-swap.ts", import.meta.url), "utf8").includes('feedMeta?.setAttribute("content", formatBuildFeed({ ...page.feed, index: point.index }));'));
});

test("shown on the landing footer, tiny and dim", () => {
  const landing = readFileSync(new URL("../src/lib/landing/Splitter.svelte", import.meta.url), "utf8");
  assert.ok(landing.includes('{#if buildIndex !== null}<p class="footer-build mono">v{buildIndex}</p>{/if}'));
  assert.match(landing, /\.footer-build \{[^}]*font-size: 0\.5625rem;[^}]*color: var\(--text-dim\);[^}]*opacity: 0\.55;/);
});
