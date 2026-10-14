/**
 * The boot-time "is this the newest build?" check (lib/boot/build-check.ts) and the
 * handover page parse (lib/boot/build-swap.ts). Background: 2026-10-14 a phone was
 * handed build 224 by woco.eth.limo while 241 was current - Bee's feed lookup landed
 * short (ethersphere/bee#5251).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { calculateCacAddress, encodeSpan, feedUpdateAddress, feedUpdateIdentifier, type ChunkRead, type ChunkSource } from "@woco/shared";
import {
  checkBuild,
  formatBuildFeed,
  pageSources,
  parseBuildFeed,
  readHighWater,
  writeHighWater,
  type BuildFeed,
} from "../src/lib/boot/build-check.ts";
import { handoverVerdict, parseBuildPage } from "../src/lib/boot/build-swap.ts";

const KEY = hexToBytes("0303030303030303030303030303030303030303030303030303030303030303");
const OWNER = bytesToHex(keccak_256(secp256k1.getPublicKey(KEY, false).subarray(1)).subarray(12));
const TOPIC = bytesToHex(keccak_256(utf8ToBytes("build-check-test")));
const ref = (i: number) => bytesToHex(keccak_256(utf8ToBytes(`site-${i}`)));
const feedAt = (index: number): BuildFeed => ({ owner: OWNER, topic: TOPIC, index });

function signUpdate(index: number): Uint8Array {
  const identifier = feedUpdateIdentifier(TOPIC, index);
  const ts = new Uint8Array(8);
  new DataView(ts.buffer).setBigUint64(0, BigInt(1_700_000_000 + index));
  const payload = concatBytes(ts, hexToBytes(ref(index)));
  const span = encodeSpan(payload.length);
  const inner = keccak_256(concatBytes(identifier, calculateCacAddress(span, payload)));
  const digest = keccak_256(concatBytes(utf8ToBytes("\x19Ethereum Signed Message:\n32"), inner));
  const rec = secp256k1.sign(digest, KEY, { prehash: false, format: "recovered" });
  const sig = new Uint8Array(65);
  sig.set(rec.subarray(1), 0);
  sig[64] = rec[0]! + 27;
  return concatBytes(identifier, sig, span, payload);
}

function source(indices: number[], delayMs = 0): ChunkSource {
  const held = new Map(indices.map((i) => [feedUpdateAddress(OWNER, TOPIC, i), signUpdate(i)]));
  return (address, signal) =>
    new Promise<ChunkRead>((resolve) => {
      const answer = (): ChunkRead => (held.has(address) ? { kind: "found", bytes: held.get(address)! } : { kind: "absent" });
      if (!delayMs) return resolve(answer());
      const t = setTimeout(() => resolve(answer()), delayMs);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve({ kind: "unknown", reason: "timeout" });
      });
    });
}

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const opts = (feed: BuildFeed, sources: ChunkSource[], storage: Storage | null, over: Partial<{ graceMs: number; holdAfterHitMs: number; probeTimeoutMs: number }> = {}) => ({
  feed,
  sources,
  storage,
  graceMs: 300,
  holdAfterHitMs: 2_000,
  probeTimeoutMs: 1_000,
  ...over,
});

// ---- the baked meta ----

test("woco-feed meta round-trips, and anything malformed is no feed", () => {
  const f = feedAt(241);
  assert.deepEqual(parseBuildFeed(formatBuildFeed(f)), f);
  for (const bad of [null, "", "v1 xyz", `v2 ${OWNER} ${TOPIC} 1`, `v1 ${OWNER} ${TOPIC} -1`, `v1 ${OWNER.toUpperCase()} ${TOPIC} 1`]) {
    assert.equal(parseBuildFeed(bad), null, String(bad));
  }
});

// ---- where to ask ----

test("eth.limo serves the page at /: only our gateway is asked", () => {
  const s = pageSources({ origin: "https://woco.eth.limo", pathname: "/" }, "https://gw");
  assert.deepEqual(s.pageBases, ["https://gw"]);
  assert.equal(s.ownNode, false);
});

test("our gateway's own /bzz page is not asked twice", () => {
  const s = pageSources({ origin: "https://gw", pathname: "/bzz/abc/" }, "https://gw");
  assert.deepEqual(s.pageBases, ["https://gw"]);
  assert.equal(s.ownNode, false);
});

test("a page served by someone's own Bee asks that node first, then our gateway", () => {
  const s = pageSources({ origin: "http://localhost:1633", pathname: "/bzz/abc/" }, "https://gw");
  assert.deepEqual(s.pageBases, ["http://localhost:1633", "https://gw"]);
  assert.equal(s.ownNode, true);
  assert.equal(s.sources.length, 2);
});

// ---- the device's memory ----

test("high-water: an index only, never lowered, junk and broken storage ignored", () => {
  const st = memoryStorage();
  const f = feedAt(1);
  writeHighWater(st, f, 9);
  writeHighWater(st, f, 5);
  assert.equal(readHighWater(st, f), 9);
  assert.equal(st.getItem(`woco:feed-hw:${OWNER}:${TOPIC}`), "9", "no reference is stored");
  for (const junk of ["{not json", "-3", "1e5", JSON.stringify({ index: 9, ref: ref(9) })]) {
    st.setItem(`woco:feed-hw:${OWNER}:${TOPIC}`, junk);
    assert.equal(readHighWater(st, f), null, junk);
  }
  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } as unknown as Storage;
  assert.equal(readHighWater(throwing, f), null);
  writeHighWater(throwing, f, 3);
});

test("high-water is per feed: a new feed starts clean", () => {
  const st = memoryStorage();
  writeHighWater(st, feedAt(0), 50);
  assert.equal(readHighWater(st, { ...feedAt(0), topic: "ab".repeat(32) }), null);
});

// ---- the decision ----

test("current build: decided as soon as the walk finds nothing", async () => {
  const t0 = Date.now();
  const d = await checkBuild(opts(feedAt(10), [source([8, 9, 10])], memoryStorage(), { graceMs: 5_000 }));
  assert.deepEqual(d, { kind: "current" });
  assert.ok(Date.now() - t0 < 1_000, "did not sit out the grace period");
});

test("stale page: the newest verified build is chosen and remembered", async () => {
  const st = memoryStorage();
  const d = await checkBuild(opts(feedAt(224), [source(Array.from({ length: 20 }, (_, i) => 224 + i))], st));
  assert.equal(d.kind, "newer");
  assert.equal(d.kind === "newer" && d.point.index, 243);
  assert.equal(d.kind === "newer" && d.point.ref, ref(243));
  assert.equal(readHighWater(st, feedAt(224)), 243);
});

test("slow sources: the page starts on time, and the NEXT visit is corrected from memory", async () => {
  const st = memoryStorage();
  const t0 = Date.now();
  const first = await checkBuild(opts(feedAt(10), [source([11, 12], 400)], st, { graceMs: 100, probeTimeoutMs: 1_000 }));
  assert.deepEqual(first, { kind: "current" });
  assert.ok(Date.now() - t0 < 350, "held only for the grace period");
  await new Promise((r) => setTimeout(r, 1_500));
  assert.equal(readHighWater(st, feedAt(10)), 12, "the walk finished in the background");
  // Next visit, same stale page: the remembered index is re-verified straight away.
  const next = await checkBuild(opts(feedAt(10), [source([12])], st, { graceMs: 300 }));
  assert.equal(next.kind === "newer" && next.point.index, 12);
  assert.equal(next.kind === "newer" && next.point.ref, ref(12));
});

test("a remembered index is a hint: it never loads anything that is not verified now", async () => {
  const st = memoryStorage();
  writeHighWater(st, feedAt(0), 12);
  const unreachable: ChunkSource = async () => ({ kind: "unknown", reason: "offline" });
  assert.deepEqual(await checkBuild(opts(feedAt(10), [unreachable], st)), { kind: "current" });
});

test("a planted, too-high index cannot stop the ordinary walk", async () => {
  const st = memoryStorage();
  writeHighWater(st, feedAt(0), 999_999);
  const d = await checkBuild(opts(feedAt(10), [source([10, 11])], st));
  assert.equal(d.kind === "newer" && d.point.index, 11);
});

test("a remembered index far ahead of a stale page is re-verified and used", async () => {
  const st = memoryStorage();
  writeHighWater(st, feedAt(0), 300);
  const d = await checkBuild(opts(feedAt(10), [source([10, 300])], st));
  assert.equal(d.kind === "newer" && d.point.index, 300, "out of the ordinary walk's reach, so only the hint finds it");
  assert.equal(d.kind === "newer" && d.point.ref, ref(300));
});

test("never asks for an update at or below its own build", async () => {
  const asked: number[] = [];
  const byAddress = new Map(Array.from({ length: 2_000 }, (_, i) => [feedUpdateAddress(OWNER, TOPIC, i), i]));
  const counting: ChunkSource = async (address) => {
    asked.push(byAddress.get(address) ?? -1);
    return { kind: "absent" };
  };
  const st = memoryStorage();
  writeHighWater(st, feedAt(0), 5);
  await checkBuild(opts(feedAt(10), [counting], st));
  assert.ok(asked.length > 0);
  assert.ok(asked.every((i) => i > 10), `asked for ${asked.filter((i) => i <= 10)}`);
});

test("memory older than this build is ignored", async () => {
  const st = memoryStorage();
  writeHighWater(st, feedAt(0), 5);
  assert.deepEqual(await checkBuild(opts(feedAt(10), [source([5, 6, 7, 8, 9, 10])], st)), { kind: "current" });
});

test("no storage at all: still checks, still decides", async () => {
  const d = await checkBuild(opts(feedAt(3), [source([3, 4])], null));
  assert.equal(d.kind === "newer" && d.point.index, 4);
});

test("every source failing: this build runs", async () => {
  const down: ChunkSource = async () => ({ kind: "unknown", reason: "HTTP 503" });
  assert.deepEqual(await checkBuild(opts(feedAt(3), [down], memoryStorage())), { kind: "current" });
});

// ---- the handover page ----

const BUILT = readFileSync(new URL("./fixtures/built-index.html", import.meta.url), "utf-8");

test("parses a built entry page: base, policy, entry and links, all absolute", () => {
  const page = parseBuildPage(BUILT, "https://gw/bzz/siteref/");
  assert.ok(page);
  assert.deepEqual(page.feed, { owner: "f8af4904c6e4f08ce5f7deab7f01221280b23a80", topic: "aef7b3bb8b50eff1516536370de7ab15de8e24592a35d2abd9977d00ebb650b2", index: 242 });
  assert.equal(page.base, "https://gateway.woco-net.com/bzz/82a4682f0a90fdfb4b88514e36555acea390e0856dbb2a01eb9ca0a8de803a27/");
  assert.match(page.entry, new RegExp(`^${page.base}assets/main-[\\w-]+\\.js$`));
  assert.ok(page.csp?.startsWith("default-src 'self'; base-uri 'self' https://gateway.woco-net.com;"), "entities decoded");
  const preloads = page.links.filter((l) => l.rel === "modulepreload");
  assert.ok(preloads.length >= 3 && preloads.every((l) => l.href.startsWith(`${page.base}assets/`) && l.cors));
  const styles = page.links.filter((l) => l.rel === "preload" && l.as === "style");
  assert.ok(styles.length >= 1 && styles.every((l) => l.cors), "style preloads carry crossorigin, matching Vite's stylesheet");
  assert.ok(page.links.some((l) => l.href.startsWith("https://fonts.googleapis.com/") && !l.cors), "absolute links kept as they are");
});

test("a page that is not one of our builds is refused", () => {
  assert.equal(parseBuildPage(BUILT.replace(/<meta name="woco-feed"[^>]*>/, ""), "https://gw/"), null);
  assert.equal(parseBuildPage(BUILT.replace(/<script type="module"[^>]*><\/script>/, ""), "https://gw/"), null);
  assert.equal(parseBuildPage("<html><body>404</body></html>", "https://gw/"), null);
});

test("no <base href>: relative URLs resolve against where the page came from", () => {
  const page = parseBuildPage(BUILT.replace(/<base [^>]*>/, ""), "http://localhost:1633/bzz/siteref/");
  assert.match(page?.entry ?? "", /^http:\/\/localhost:1633\/bzz\/siteref\/assets\/main-[\w-]+\.js$/);
});

test("handover rules: same feed and same policy goes; another policy reloads; anything else stays put", () => {
  const page = parseBuildPage(BUILT, "https://gw/bzz/siteref/")!;
  const current = { ...page.feed, index: 241 };
  const elsewhere = "https://gateway.woco-net.com/bzz/" + "ab".repeat(32) + "/";
  assert.equal(handoverVerdict(page, current, page.csp, elsewhere), "go");
  assert.equal(handoverVerdict(page, current, page.csp + " ", elsewhere), "reload");
  assert.equal(handoverVerdict(page, current, null, elsewhere), "reload");
  assert.equal(handoverVerdict(null, current, page.csp, elsewhere), "failed");
  assert.equal(handoverVerdict(page, { ...current, owner: "11".repeat(20) }, page.csp, elsewhere), "failed");
  assert.equal(handoverVerdict(page, { ...current, topic: "22".repeat(32) }, page.csp, elsewhere), "failed");
});

test("the same code redeployed (same assets base) is started here, never imported again", () => {
  // Importing an entry URL this page already ran returns the cached module: nothing mounts.
  const page = parseBuildPage(BUILT, "https://gw/bzz/siteref/")!;
  const current = { ...page.feed, index: 241 };
  assert.equal(handoverVerdict(page, current, page.csp, page.base), "same");
  assert.equal(handoverVerdict(page, current, "different csp", page.base), "same", "even before the policy rule");
});

// ---- wiring the property depends on ----

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf-8");

test("index.html starts boot.ts, not the app", () => {
  assert.match(read("../index.html"), /<script type="module" src="\/src\/boot\.ts"><\/script>/);
  assert.doesNotMatch(read("../index.html"), /src="\/src\/main\.ts"/);
});

test("boot.ts reaches the app only through dynamic import - a handover must run no old app code", () => {
  const boot = read("../src/boot.ts");
  assert.doesNotMatch(boot, /^\s*import\s+[^(]*['"]\.\/main['"]/m, "static import of ./main");
  assert.match(boot, /import\('\.\/main'\)/);
  for (const f of ["../src/lib/boot/build-check.ts", "../src/lib/boot/build-swap.ts"]) {
    assert.doesNotMatch(read(f), /from ["'](\.\.\/)+(main|App\.svelte|lib\/auth)/, `${f} must not pull in the app`);
  }
});

test("the build preloads the app's chunks, or the check would cost a round trip", () => {
  assert.match(read("../vite.config.ts"), /preloadApp\(\)/);
  assert.match(read("../vite-plugins/preload-app.ts"), /rel: "preload", as: "style", crossorigin: true/);
});

test("a slow handover reloads once, then waits - it never falls back beside a loading build", () => {
  const swap = read("../src/lib/boot/build-swap.ts");
  assert.match(swap, /if \(outcome === "late"\) return "reload";/);
  assert.match(swap, /opts\.patient\s*\?\s*new Promise<never>\(\(\) => \{\}\)/, "patient = no timer (setTimeout(Infinity) fires at once)");
  assert.doesNotMatch(swap.replace(/\/\/.*$/gm, ""), /setTimeout\([^)]*Infinity/, "code, not the comment that explains why");
  const boot = read("../src/boot.ts");
  assert.match(boot, /\{ patient: reloaded \}/);
  assert.match(boot, /if \(handover\) return \(handover\.ready = import\('\.\/main'\)\)/);
});
