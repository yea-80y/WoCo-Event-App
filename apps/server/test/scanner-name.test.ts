/**
 * The door scanner at `scan.<parent>`: the gateway answers that one name with the
 * scanner feed's latest immutable build, and nothing else ever (ens-gateway/ccip.ts
 * SCANNER_LABEL, lib/scanner/latest-build.ts).
 *
 * MUTATIONS (each turns this file red):
 *  - drop the scan branch in the handler -> "scan is answered with the scanner's build";
 *  - sign "0x" or the app when no build is known -> "an unknown build is refused";
 *  - special-case `door`/`scanner` -> "door and scanner are ordinary names";
 *  - let a feed failure clear the last good build -> "a failed read keeps the last good build";
 *  - walk backwards / trust the lookup over the head -> "never goes backwards";
 *  - accept any payload as a build -> "an update that is not a scanner build".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
import type { VerifiedSocRead } from "../src/lib/swarm/soc-read.js";

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
  assert.equal(scannerRefFromUpdate(new Uint8Array(32)), null, "a bare reference");
  assert.equal(scannerRefFromUpdate(new Uint8Array(4096)), null, "a data page");
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
  const faults = new Map<bigint, VerifiedSocRead>([[2n, found(new Uint8Array(4096))]]);
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
// Wiring
// ---------------------------------------------------------------------------

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("the gateway route answers scan from the live scanner build and counts it", () => {
  const route = source("../src/routes/ens-gateway.ts");
  assert.match(route, /scannerBuild: \(\) => scannerBuild\.current\(\),/);
  assert.match(route, /const contenthashAnswers: Record<ContenthashAnswer, number> = \{[^}]*\bscan: 0\b[^}]*\}/);
});

test("the server reads the topic the scanner deploy writes", async () => {
  const { SCANNER_FEED_TOPIC } = await import("../src/lib/scanner/latest-build.js");
  assert.match(source("../../../scripts/upload-scanner-to-swarm.cjs"), new RegExp(`const FEED_TOPIC = '${SCANNER_FEED_TOPIC}';`));
});
