/**
 * The door scanner at `scan.<parent>`: the gateway answers that one name with the
 * scanner feed's latest immutable build, and nothing else ever (ens-gateway/ccip.ts
 * SCANNER_LABEL, lib/scanner/latest-build.ts); `/api/health` `scanner` goes red
 * when that build stops serving the files a door phone needs (lib/scanner/health.ts).
 *
 * MUTATIONS (each turns this file red):
 *  - drop the scan branch in the handler -> "scan is answered with the scanner's build";
 *  - sign "0x" or the app when no build is known -> "an unknown build is refused";
 *  - special-case `door`/`scanner` -> "door and scanner are ordinary names";
 *  - let a feed failure clear the last good build -> "a failed read keeps the last good build";
 *  - walk backwards / trust the lookup over the head -> "never goes backwards";
 *  - accept any payload as a build -> "an update that is not a scanner build";
 *  - drop the content-type check -> "bee's error document is not the file";
 *  - check only named files, not every precache entry -> "one lost lazy chunk is red";
 *  - drop a critical file -> "a missing critical file is red";
 *  - drop the scanner section or its probe from index.ts -> wiring tests;
 *  - in the upload script, accept an unreadable or taken index, skip the
 *    `index + 1` check, retry without bound, write at bee's lookup instead of
 *    the first free index, or guess past an unreadable one -> "the scanner upload" tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Topic } from "@ethersphere/bee-js";
import { feedUpdateAddress as sharedFeedUpdateAddress } from "@woco/shared";
import { AbiCoder, Interface, Wallet, concat, getBytes, hexlify, namehash, recoverAddress, toUtf8Bytes } from "ethers";
import {
  createCcipHandler,
  makeSignatureHash,
  type CcipHandlerConfig,
  type ContenthashAnswer,
} from "../src/lib/ens-gateway/ccip.js";
import { ResponseMemo } from "../src/lib/ens-gateway/memo.js";
import { encodeSwarmContenthash } from "../src/lib/sub-ens/swarm-contenthash.js";
import {
  ScannerBuildSource,
  scannerRefFromUpdate,
  type ScannerFeedReader,
} from "../src/lib/scanner/latest-build.js";
import {
  criticalScannerFiles,
  evaluateScanner,
  probeScanner,
  type BuildFileRead,
  type FetchBuildFile,
} from "../src/lib/scanner/health.js";
import type { VerifiedSocRead } from "../src/lib/swarm/soc-read.js";
import { alarmGate } from "../src/lib/health/alarm-gate.js";

const ABI = AbiCoder.defaultAbiCoder();
const h = (c: string) => c.repeat(64);
const APEX = h("a");
const MANIFEST = h("b"); // a feed manifest the server deployed
const BUILT = h("c"); // what it baked there
const SCANNER = h("5");
const NEWER = h("6");
const swarm = (hash: string) => hexlify(encodeSwarmContenthash(hash));

// ---------------------------------------------------------------------------
// The gateway
// ---------------------------------------------------------------------------

const SIGNER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SIGNER = new Wallet(SIGNER_PK).address;
const RESOLVER = "0x1111111111111111111111111111111111111111";
const REGISTRY = "0xC38e08CB5a21B083F63149ea7597Ea8D05017cf8";
const NOW = 1_800_000_000;
const CONFIG: CcipHandlerConfig = {
  signerPrivateKey: SIGNER_PK,
  allowedSenders: [RESOLVER],
  chainId: 421614,
  registryAddresses: [REGISTRY.toLowerCase()],
  parentName: "woco.eth",
  ttlSeconds: 600,
};
const STUFFED = new Interface([
  "function stuffedResolveCall(bytes name, bytes data, uint64 targetChainId, address targetRegistryAddress) view returns (bytes)",
]);
const RECORDS = new Interface([
  "function contenthash(bytes32 node) view returns (bytes)",
  "function addr(bytes32 node) view returns (address)",
]);

function rawDns(labels: string[]): string {
  const parts = labels.map((l) => {
    const b = toUtf8Bytes(l);
    return concat([new Uint8Array([b.length]), b]);
  });
  return hexlify(concat([...parts, new Uint8Array([0])]));
}

function contenthashRequest(name: string): string {
  const inner = RECORDS.encodeFunctionData("contenthash", [namehash(name)]);
  return STUFFED.encodeFunctionData("stuffedResolveCall", [rawDns(name.split(".")), inner, 421614, REGISTRY]);
}

/** A gateway whose L2 holds `l2` for every name and whose scanner build is `build()`. */
function gateway(opts: { l2?: string; l2Fails?: boolean; build: () => Promise<string | null>; memo?: ResponseMemo<{ data: string }> }) {
  const answers: ContenthashAnswer[] = [];
  let l2Reads = 0;
  let buildReads = 0;
  const handler = createCcipHandler(CONFIG, {
    readL2: async () => {
      l2Reads++;
      if (opts.l2Fails) throw new Error("execution reverted");
      return opts.l2 ?? ABI.encode(["bytes"], ["0x"]);
    },
    now: () => NOW,
    memo: opts.memo,
    logError: () => {},
    contenthash: {
      apexHash: () => APEX,
      lookupBuilt: (m) => (m === MANIFEST ? BUILT : null),
      scannerBuild: async () => {
        buildReads++;
        return opts.build();
      },
      onAnswer: (a) => answers.push(a),
    },
  });
  return { handler, answers, l2Reads: () => l2Reads, buildReads: () => buildReads };
}

function signedContenthash(out: { status: number; body: unknown }, data: string): string {
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const [result, expires, sig] = ABI.decode(["bytes", "uint64", "bytes"], (out.body as { data: string }).data);
  const hash = makeSignatureHash(RESOLVER, expires as bigint, getBytes(data), result as string);
  assert.equal(recoverAddress(hash, sig as string), SIGNER, "signed by the gateway, over what it answered");
  return ABI.decode(["bytes"], result as string)[0] as string;
}

test("scan is answered with the scanner's build, signed, without reading the L2", async () => {
  // A pointer on the L2 - even a manifest the server deployed - must not matter.
  const g = gateway({ l2: ABI.encode(["bytes"], [swarm(MANIFEST)]), build: async () => SCANNER });
  const data = contenthashRequest("scan.woco.eth");
  assert.equal(signedContenthash(await g.handler(RESOLVER, data), data), swarm(SCANNER));
  assert.equal(g.l2Reads(), 0, "the L2 is not consulted");
  assert.deepEqual(g.answers, ["scan"]);
});

test("scan answers while unminted: the L2 is never asked, so it cannot fail the lookup", async () => {
  const g = gateway({ l2Fails: true, build: async () => SCANNER });
  const data = contenthashRequest("scan.woco.eth");
  assert.equal(signedContenthash(await g.handler(RESOLVER, data), data), swarm(SCANNER));
});

test("a newer scanner build is what the next answer carries", async () => {
  let build = SCANNER;
  const g = gateway({ build: async () => build });
  const data = contenthashRequest("scan.woco.eth");
  assert.equal(signedContenthash(await g.handler(RESOLVER, data), data), swarm(SCANNER));
  build = NEWER;
  assert.equal(signedContenthash(await g.handler(RESOLVER, data), data), swarm(NEWER));
});

test("an unknown build is refused, unsigned and unmemoised - never the app, never empty", async () => {
  const memo = new ResponseMemo<{ data: string }>(30_000);
  for (const build of [async () => null, async () => { throw new Error("bee down"); }, async () => "not-a-hash"]) {
    const g = gateway({ build, memo });
    const out = await g.handler(RESOLVER, contenthashRequest("scan.woco.eth"));
    assert.equal(out.status, 503);
    assert.ok(!("data" in out.body), "nothing signed");
    assert.equal(out.cacheable, false);
    assert.equal(g.l2Reads(), 0, "and no fallback to the L2 pointer");
    assert.deepEqual(g.answers, []);
  }
  assert.equal(memo.size(), 0);
});

test("other records of scan are the L2's, as for any name", async () => {
  const l2 = ABI.encode(["address"], ["0x00000000000000000000000000000000000000ff"]);
  const g = gateway({ l2, build: async () => SCANNER });
  const inner = RECORDS.encodeFunctionData("addr", [namehash("scan.woco.eth")]);
  const data = STUFFED.encodeFunctionData("stuffedResolveCall", [rawDns(["scan", "woco", "eth"]), inner, 421614, REGISTRY]);
  const out = await g.handler(RESOLVER, data);
  assert.equal(out.status, 200);
  assert.equal(ABI.decode(["bytes", "uint64", "bytes"], (out.body as { data: string }).data)[0], l2);
  assert.equal(g.buildReads(), 0);
});

test("door and scanner are ordinary names: the WoCo-built rule, never the scanner's build", async () => {
  for (const name of ["door.woco.eth", "scanner.woco.eth", "scans.woco.eth", "xscan.woco.eth"]) {
    // A holder pointer -> the app; no record -> nothing.
    const pointed = gateway({ l2: ABI.encode(["bytes"], [swarm(h("d"))]), build: async () => SCANNER });
    const data = contenthashRequest(name);
    assert.equal(signedContenthash(await pointed.handler(RESOLVER, data), data), swarm(APEX), name);
    assert.deepEqual(pointed.answers, ["foreign"], name);
    const empty = gateway({ build: async () => SCANNER });
    assert.equal(signedContenthash(await empty.handler(RESOLVER, data), data), "0x", name);
    assert.equal(pointed.buildReads() + empty.buildReads(), 0, `${name} never asks for the scanner's build`);
  }
});

test("scan below another label is only depth: nothing, and no scanner build", async () => {
  for (const name of ["scan.alice.woco.eth", "x.scan.woco.eth"]) {
    const g = gateway({ build: async () => SCANNER });
    const data = contenthashRequest(name);
    assert.equal(signedContenthash(await g.handler(RESOLVER, data), data), "0x", name);
    assert.deepEqual(g.answers, ["depth"], name);
    assert.equal(g.buildReads(), 0, name);
  }
});

// ---------------------------------------------------------------------------
// The latest build, from the feed
// ---------------------------------------------------------------------------

const update = (ref: string): Uint8Array => {
  const out = new Uint8Array(40);
  out.set([0, 0, 0, 0, 0x68, 0, 0, 0]); // timestamp
  out.set(getBytes("0x" + ref), 8);
  return out;
};
const found = (payload: Uint8Array): VerifiedSocRead => ({
  status: "found",
  soc: { owner: "f8".repeat(20), identifier: "00".repeat(32), signature: "", span: "", payload, source: "wocoBee" },
});

/** A feed with updates at 0..n-1, where `faults` answers instead for chosen indexes. */
function feed(refs: string[], opts: { lookup?: bigint | null; faults?: Map<bigint, VerifiedSocRead> } = {}) {
  const reads: bigint[] = [];
  let lookups = 0;
  const reader: ScannerFeedReader = {
    lookup: async () => {
      lookups++;
      return opts.lookup === undefined ? BigInt(Math.max(refs.length - 1, 0)) : opts.lookup;
    },
    readAt: async (i) => {
      reads.push(i);
      const fault = opts.faults?.get(i);
      if (fault) return fault;
      const ref = refs[Number(i)];
      return ref ? found(update(ref)) : { status: "absent" };
    },
  };
  return { reader, reads, refs, lookups: () => lookups };
}

const quiet = { log: () => {} };

test("an update's collection is the 32 bytes after its timestamp; anything else is not a build", () => {
  assert.equal(scannerRefFromUpdate(update(SCANNER)), SCANNER);
  assert.equal(scannerRefFromUpdate(update(h("0"))), null, "a zero reference");
  assert.equal(scannerRefFromUpdate(new Uint8Array(32).fill(0x11)), null, "a bare reference");
  assert.equal(scannerRefFromUpdate(new Uint8Array(4096).fill(0x11)), null, "a data page");
  assert.equal(scannerRefFromUpdate(new Uint8Array(41).fill(0x11)), null, "a trailing byte");
});

test("the head is found by chunk reads from bee's lookup, which is only a lower bound", async () => {
  const f = feed([h("1"), h("2"), h("3"), SCANNER], { lookup: 1n });
  const src = new ScannerBuildSource(f.reader, quiet);
  assert.equal(await src.current(), SCANNER);
  assert.deepEqual(f.reads, [1n, 2n, 3n, 4n], "walked forward to the first absent index");
  assert.equal(src.state().build?.index, 3n);
});

test("a failed read keeps the last good build, says so, and never answers another", async () => {
  let t = 0;
  const faults = new Map<bigint, VerifiedSocRead>();
  const f = feed([h("1"), SCANNER], { faults });
  const src = new ScannerBuildSource(f.reader, { ...quiet, now: () => t });
  assert.equal(await src.current(), SCANNER);
  faults.set(2n, { status: "unavailable", reason: "bee HTTP 500" });
  t += 60_000;
  const state = await src.refresh();
  assert.equal(state.build?.ref, SCANNER);
  assert.match(state.error ?? "", /could not read feed update 2/);
  assert.equal(await src.current(), SCANNER);
  // And a later good read clears the error.
  faults.clear();
  assert.equal((await src.refresh()).error, null);
});

test("never goes backwards: once a build is seen, a short lookup cannot bring an older one back", async () => {
  const f = feed([h("1"), h("2"), SCANNER]);
  const src = new ScannerBuildSource(f.reader, quiet);
  await src.refresh();
  assert.equal(src.state().build?.index, 2n);
  // The next read starts past the head, not at whatever bee's lookup now says.
  f.reads.length = 0;
  await src.refresh();
  assert.deepEqual(f.reads, [3n]);
  assert.equal(f.lookups(), 1, "the lookup is only a starting point at boot");
  assert.equal(src.state().build?.ref, SCANNER);
});

test("a newer update is picked up on the next read", async () => {
  const refs = [h("1"), SCANNER];
  const f = feed(refs);
  const src = new ScannerBuildSource(f.reader, quiet);
  assert.equal(await src.current(), SCANNER);
  refs.push(NEWER);
  assert.equal((await src.refresh()).build?.ref, NEWER);
});

test("an update that is not a scanner build is an error, and the last good build stays", async () => {
  const faults = new Map<bigint, VerifiedSocRead>([[2n, found(new Uint8Array(4096).fill(0x11))]]);
  const f = feed([h("1"), SCANNER], { faults });
  const src = new ScannerBuildSource(f.reader, quiet);
  const state = await src.refresh();
  assert.equal(state.build?.ref, SCANNER);
  assert.match(state.error ?? "", /not a scanner build/);
});

test("with nothing known, a failed read is null for the gateway - which refuses", async () => {
  const empty = new ScannerBuildSource(feed([], { lookup: null }).reader, quiet);
  assert.equal(await empty.current(), null);
  assert.match(empty.state().error ?? "", /has no update/);
  const faults = new Map<bigint, VerifiedSocRead>([[0n, { status: "unavailable", reason: "bee unreachable" }]]);
  const down = new ScannerBuildSource(feed([SCANNER], { lookup: null, faults }).reader, quiet);
  assert.equal(await down.current(), null);
  assert.match(down.state().error ?? "", /could not read feed update 0/);
});

test("memoised: a known build is answered at once, re-read behind it after the ttl", async () => {
  let t = 0;
  const refs = [SCANNER];
  const f = feed(refs);
  const src = new ScannerBuildSource(f.reader, { ...quiet, now: () => t, ttlMs: 60_000 });
  assert.equal(await src.current(), SCANNER);
  const after = f.reads.length;
  t += 59_000;
  assert.equal(await src.current(), SCANNER);
  assert.equal(f.reads.length, after, "no read inside the ttl");
  refs.push(NEWER);
  t += 1_000;
  assert.equal(await src.current(), SCANNER, "the stale answer is served, not waited on");
  await src.refresh();
  assert.equal(await src.current(), NEWER);
});

test("concurrent reads share one walk", async () => {
  const f = feed([h("1"), SCANNER], { lookup: 0n });
  const src = new ScannerBuildSource(f.reader, quiet);
  await Promise.all([src.refresh(), src.refresh(), src.current()]);
  assert.deepEqual(f.reads, [0n, 1n, 2n]);
});

// ---------------------------------------------------------------------------
// /api/health scanner
// ---------------------------------------------------------------------------

const INDEX_HTML = `<!doctype html><html><head>
    <script type="module" crossorigin src="./assets/scanner-t7rIg_L-.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/scanner-V-3hAdeZ.css">
  <link rel="manifest" href="./manifest.webmanifest"></head><body><div id="app"></div></body></html>`;
/** Shaped like a real dist-scanner/sw.js (2026-10-15 build). */
const PRECACHE = [
  "logo.png",
  "index.html",
  "assets/xwing-BfkzvsSh.js",
  "assets/workbox-window.prod.es5-BBnX5xw4.js",
  "assets/secp256k1-DTskgwZV.js",
  "assets/sealed-box-BQM-Aun_.js",
  "assets/scanner-V-3hAdeZ.css",
  "assets/scanner-t7rIg_L-.js",
  "assets/qr-scanner-worker.min-D85Z9gVD.js",
  "assets/door-entries-key-B5pAZrRF.js",
  "assets/__vite-browser-external-BIHI7g3E.js",
  "manifest.webmanifest",
];
const swWith = (urls: string[]) =>
  'if(!self.define){}define(["./workbox-0bb07689"],function(e){"use strict";self.skipWaiting(),e.clientsClaim(),' +
  `e.precacheAndRoute([${urls.map((u) => `{url:"${u}",revision:null}`).join(",")}],{}),e.cleanupOutdatedCaches()});`;
const SW_JS = swWith(PRECACHE);
const CRITICAL = [
  "index.html",
  "sw.js",
  "workbox-0bb07689.js",
  ...PRECACHE.filter((u) => /\.(js|css)$/.test(u)),
];

function bzz(overrides: Record<string, BuildFileRead> = {}) {
  const asked: string[] = [];
  const fetchFile: FetchBuildFile = async (ref, path) => {
    asked.push(`${ref}/${path}`);
    if (overrides[path]) return overrides[path];
    if (path === "index.html") return { ok: true, body: toUtf8Bytes(INDEX_HTML), contentType: "text/html; charset=utf-8" };
    if (path === "sw.js") return { ok: true, body: toUtf8Bytes(SW_JS), contentType: "text/javascript; charset=utf-8" };
    if (path.endsWith(".js")) return { ok: true, body: new Uint8Array(10), contentType: "text/javascript; charset=utf-8" };
    if (path.endsWith(".css")) return { ok: true, body: new Uint8Array(10), contentType: "text/css; charset=utf-8" };
    return { ok: false, reason: "HTTP 404" };
  };
  return { fetchFile, asked };
}

const sourceWith = (refs: string[], opts: Parameters<typeof feed>[1] = {}) => new ScannerBuildSource(feed(refs, opts).reader, quiet);

test("the critical files are the workbox runtime and every script, stylesheet and page sw.js precaches", () => {
  assert.deepEqual(criticalScannerFiles(INDEX_HTML, SW_JS), { files: CRITICAL.slice(2) });
  // A precached page other than index.html is checked too; images and the manifest are not.
  const withPage = criticalScannerFiles(INDEX_HTML, swWith([...PRECACHE, "offline.html"]));
  assert.ok("files" in withPage && withPage.files.includes("offline.html"));
  assert.ok("files" in withPage && !withPage.files.some((f) => f.endsWith(".png") || f.endsWith(".webmanifest")));
});

test("a build that cannot name its critical files is an error, not a pass", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["<html></html>", SW_JS, /names no assets\/scanner-\*\.js entry/],
    [INDEX_HTML, SW_JS.replace('define(["./workbox-0bb07689"]', "define([]"), /no workbox runtime/],
    [INDEX_HTML, swWith(PRECACHE.filter((u) => !u.startsWith("assets/qr-scanner-worker"))), /no assets\/qr-scanner-worker/],
    [INDEX_HTML, swWith(PRECACHE.filter((u) => u !== "assets/scanner-t7rIg_L-.js")), /does not precache the entry script/],
    [INDEX_HTML, swWith([...PRECACHE, "../etc/passwd.js"]), /not a plain relative path/],
    [INDEX_HTML, swWith([...PRECACHE, "https://evil.example/x.js"]), /not a plain relative path/],
  ];
  for (const [html, sw, why] of cases) {
    const r = criticalScannerFiles(html, sw);
    assert.ok("error" in r && why.test(r.error), JSON.stringify(r));
  }
});

test("one lost lazy chunk is red: workbox installs all or nothing", async () => {
  const r = await probeScanner(sourceWith([SCANNER]), bzz({ "assets/sealed-box-BQM-Aun_.js": { ok: false, reason: "HTTP 404" } }).fetchFile);
  assert.equal(evaluateScanner(r).ok, false);
  assert.deepEqual(r.missing, [{ path: "assets/sealed-box-BQM-Aun_.js", reason: "HTTP 404" }]);
});

test("a build that serves every critical file is green, and each was fetched from that build", async () => {
  const files = bzz();
  const r = await probeScanner(sourceWith([h("1"), SCANNER]), files.fetchFile);
  assert.deepEqual(evaluateScanner(r), { ok: true });
  assert.deepEqual(r.files, CRITICAL);
  assert.deepEqual(files.asked, CRITICAL.map((p) => `${SCANNER}/${p}`));
  assert.equal(r.feedIndex, 1n);
});

for (const path of CRITICAL) {
  test(`a missing critical file is red: ${path}`, async () => {
    const r = await probeScanner(sourceWith([SCANNER]), bzz({ [path]: { ok: false, reason: "HTTP 404" } }).fetchFile);
    const v = evaluateScanner(r);
    assert.equal(v.ok, false);
    assert.ok(r.missing.some((m) => m.path === path), JSON.stringify(r.missing));
  });
}

test("bee's error document is not the file: a script served as HTML is missing", async () => {
  // A path absent from the manifest gets index.html with a 200 (Swarm-Error-Document).
  const asHtml: BuildFileRead = { ok: true, body: toUtf8Bytes(INDEX_HTML), contentType: "text/html; charset=utf-8" };
  for (const path of ["sw.js", "workbox-0bb07689.js", "assets/qr-scanner-worker.min-D85Z9gVD.js", "assets/scanner-V-3hAdeZ.css"]) {
    const r = await probeScanner(sourceWith([SCANNER]), bzz({ [path]: asHtml }).fetchFile);
    assert.equal(evaluateScanner(r).ok, false, path);
  }
});

test("a feed that cannot be read is red - with or without a last good build", async () => {
  const none = await probeScanner(sourceWith([], { lookup: null }), bzz().fetchFile);
  assert.equal(evaluateScanner(none).ok, false);
  assert.equal(none.build, null);

  const faults = new Map<bigint, VerifiedSocRead>();
  const f = feed([SCANNER], { faults });
  const src = new ScannerBuildSource(f.reader, quiet);
  await src.refresh();
  faults.set(1n, { status: "unavailable", reason: "bee HTTP 503" });
  const r = await probeScanner(src, bzz().fetchFile);
  assert.equal(r.build, SCANNER, "still checks the build the name is answered with");
  assert.equal(evaluateScanner(r).ok, false);
});

test("a build whose sw.js names no workbox runtime is red", async () => {
  const sw: BuildFileRead = { ok: true, body: toUtf8Bytes("self.skipWaiting()"), contentType: "text/javascript" };
  const r = await probeScanner(sourceWith([SCANNER]), bzz({ "sw.js": sw }).fetchFile);
  assert.equal(evaluateScanner(r).ok, false);
});

test("before the first probe the section is unknown, which never pages", () => {
  assert.equal(evaluateScanner(null).ok, null);
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("the gateway route answers scan from the live scanner build and counts it", () => {
  const route = source("../src/routes/ens-gateway.ts");
  assert.match(route, /scannerBuild: \(\) => scannerBuild\.current\(\),/);
  assert.match(route, /const contenthashAnswers: Record<ContenthashAnswer, number> = \{[^}]*\bscan: 0\b[^}]*\}/);
});

test("health reports the scanner section, and its probe runs from boot", () => {
  const index = source("../src/index.ts");
  assert.match(index, /\n {4}scanner: scannerHealth\(\),\n/);
  assert.match(index, /\nstartScannerProbe\(\);\n/);
});

test("a red scanner section pages /api/health/alarms, by name or in the default watch", () => {
  const report = { ok: true, scanner: { ok: false, reason: "not served from our bee: sw.js" } };
  assert.equal(alarmGate(report, "scanner").status, 503);
  assert.equal(alarmGate(report, undefined).status, 503);
  assert.equal(alarmGate({ ok: true, scanner: { ok: null } }, "scanner").status, 200);
});

test("every frontend deploy re-stamps the scanner after the main upload", () => {
  const pkg = JSON.parse(source("../../../package.json")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.deploy, "npm run build:deploy && npm run upload:swarm && npm run deploy:scanner");
  assert.equal(pkg.scripts["deploy:scanner"], "npm run build:scanner && npm run upload:scanner");
});

test("the server reads the topic the scanner deploy writes", async () => {
  const { SCANNER_FEED_TOPIC } = await import("../src/lib/scanner/latest-build.js");
  assert.match(source("../../../scripts/upload-scanner-to-swarm.cjs"), new RegExp(`const FEED_TOPIC = '${SCANNER_FEED_TOPIC}';`));
});

// ---------------------------------------------------------------------------
// The scanner upload: a lost feed update must fail the deploy
// ---------------------------------------------------------------------------

const upload = createRequire(import.meta.url)("../../../scripts/upload-scanner-to-swarm.cjs") as {
  confirmFeedHead: (
    index: number,
    expectedRef: string,
    readAt: (i: number) => Promise<string | null>,
    opts?: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> },
  ) => Promise<void>;
  feedUpdateAddress: (topicHex: string, index: number, ownerHex: string) => string;
  firstFreeIndex: (start: number, readAt: (i: number) => Promise<string | null>, maxWalk?: number) => Promise<number>;
  FORWARD_WALK: number;
};

/** A feed as bee reads it: `held[i]` per index, `null`/absent = 404, a function = what that read does. */
function bee(held: Record<number, string | null | (() => string | null)>) {
  const reads: number[] = [];
  const readAt = async (i: number) => {
    reads.push(i);
    const v = held[i];
    return typeof v === "function" ? v() : (v ?? null);
  };
  return { readAt, reads };
}
const noWait = { attempts: 4, delayMs: 0, sleep: async () => {} };
const down = () => {
  throw new Error("bee HTTP 500");
};

test("the scanner upload: our build at the written index and nothing after it is confirmed", async () => {
  const b = bee({ 6: h("1"), 7: SCANNER });
  await upload.confirmFeedHead(7, SCANNER, b.readAt, noWait);
  assert.deepEqual(b.reads, [7, 8]);
});

test("the scanner upload: an update still arriving is waited for, within the bound", async () => {
  let n = 0;
  const b = bee({ 7: () => (++n < 3 ? null : SCANNER) });
  await upload.confirmFeedHead(7, SCANNER, b.readAt, noWait);
  assert.deepEqual(b.reads, [7, 7, 7, 8]);
});

test("the scanner upload: an index another build holds fails at once - the update was lost", async () => {
  const b = bee({ 7: h("1") });
  await assert.rejects(upload.confirmFeedHead(7, SCANNER, b.readAt, noWait), /index 7 holds 1{64}, not this build/);
  assert.deepEqual(b.reads, [7], "a SOC cannot change, so no retry");
});

test("the scanner upload: an update that never reads back fails after the bound, absent or unreadable", async () => {
  for (const held of [{}, { 7: down }]) {
    const b = bee(held);
    await assert.rejects(upload.confirmFeedHead(7, SCANNER, b.readAt, noWait), /update 7 could not be read back after 4 tries/);
    assert.deepEqual(b.reads, [7, 7, 7, 7]);
  }
});

test("the scanner upload: a newer update after ours means the feed does not resolve to this build", async () => {
  const b = bee({ 7: SCANNER, 8: h("1") });
  await assert.rejects(upload.confirmFeedHead(7, SCANNER, b.readAt, noWait), /update 8 \(1{64}\) is newer/);
});

test("the scanner upload: an index + 1 that cannot be checked is not confirmed", async () => {
  const b = bee({ 7: SCANNER, 8: down });
  await assert.rejects(upload.confirmFeedHead(7, SCANNER, b.readAt, noWait), /update 8 could not be checked/);
  assert.deepEqual(b.reads, [7, 8, 8, 8, 8]);
});

test("the scanner upload whitelists and reads the address the update is really stored at", () => {
  const owner = "f8af4904c6e4f08ce5f7deab7f01221280b23a80";
  const topic = Topic.fromString("woco-scanner-v1").toHex();
  for (const i of [0, 7, 1000]) {
    assert.equal(upload.feedUpdateAddress(topic, i, owner), sharedFeedUpdateAddress(owner, topic, i), `index ${i}`);
  }
});

test("the scanner upload writes at the first free index from bee's lookup, not at the lookup", async () => {
  const free = bee({});
  assert.equal(await upload.firstFreeIndex(7, free.readAt), 7);
  assert.deepEqual(free.reads, [7]);
  // The lookup landed two short; whatever is stored there - even not a build - is taken.
  const short = bee({ 7: h("1"), 8: "" });
  assert.equal(await upload.firstFreeIndex(7, short.readAt), 9);
  assert.deepEqual(short.reads, [7, 8, 9]);
});

test("the scanner upload refuses to write when it cannot tell, or the head is past the walk", async () => {
  const b = bee({ 7: h("1"), 8: down });
  await assert.rejects(upload.firstFreeIndex(7, b.readAt), /Cannot tell whether scanner feed index 8 is taken[^]*Nothing was written/);
  assert.deepEqual(b.reads, [7, 8]);
  const full = bee(Object.fromEntries(Array.from({ length: 20 }, (_, k) => [7 + k, h("1")])));
  await assert.rejects(upload.firstFreeIndex(7, full.readAt, 4), /More than 4 scanner feed updates past bee's lookup at 7/);
  assert.deepEqual(full.reads, [7, 8, 9, 10]);
});

test("the scanner upload whitelists every index it can read before writing, then confirms - and a failure exits non-zero", () => {
  const src = source("../../../scripts/upload-scanner-to-swarm.cjs");
  const whitelist = src.indexOf("const reachable = Array.from({ length: FORWARD_WALK + 1 }, (_, k) => lookupIdx + k);");
  const refused = src.indexOf("if (wl.status !== 200) {", whitelist);
  const walk = src.indexOf("const nextIdx = await firstFreeIndex(lookupIdx, readAt);");
  const write = src.indexOf("await writer.uploadReference(POSTAGE_BATCH_ID, new Reference(siteRef), { index: nextIdx });");
  const confirm = src.indexOf("await confirmFeedHead(nextIdx, siteRef, readAt);");
  const saved = src.indexOf("await fs.promises.writeFile(INFO_STATE");
  assert.ok(
    whitelist > 0 && refused > whitelist && walk > refused && write > walk && confirm > write && saved > confirm,
    "whitelist -> refuse -> walk -> write -> confirm -> save",
  );
  assert.match(src.slice(refused, walk), /if \(e\?\.status === 404\) return null;\s*throw e;/, "only a 404 is absent");
  assert.match(src, /catch \(err\) \{\s*console\.error\('Upload failed:'[^]*?process\.exit\(1\);/);
  assert.ok(!src.includes("verify still cold"), "the old lookup-based verify that never failed is gone");
  // The window reaches the last index the walk can return, and the one after it that confirm reads.
  assert.ok(upload.FORWARD_WALK >= 2);
});

test("the scanner feed is read under its deploy key, never the server's own platform key", () => {
  const src = readFileSync(new URL("../src/lib/scanner/latest-build.ts", import.meta.url), "utf8");
  const pinned = src.match(/export const SCANNER_FEED_OWNER = "([0-9a-f]{40})";/);
  assert.ok(pinned, "SCANNER_FEED_OWNER is a pinned 40-hex lowercase address");
  assert.doesNotMatch(src, /import[^;]*getPlatformOwner/);
  assert.doesNotMatch(src, /getPlatformOwner\(\)\./);
  // The live reader looks up and reads under the pinned owner, in both places.
  assert.match(src, /\/feeds\/\$\{SCANNER_FEED_OWNER\}\//);
  assert.match(src, /readFeedUpdate\(SCANNER_FEED_OWNER,/);
});

test("the scanner upload refuses a key that is not the pinned scanner feed owner", () => {
  const script = readFileSync(new URL("../../../scripts/upload-scanner-to-swarm.cjs", import.meta.url), "utf8");
  assert.match(script, /SCANNER_FEED_OWNER = "\(\[0-9a-f\]\{40\}\)"/);
  assert.match(script, /is not the scanner feed owner the server pins/);
  // The check runs before anything is uploaded.
  assert.ok(script.indexOf("is not the scanner feed owner") < script.indexOf("Creating tar from"));
});
