/**
 * The WoCo-built rule: a sub-name may only ever show a collection WoCo itself built,
 * or the app (ens-gateway/ccip.ts `contenthashPolicy`, sub-ens/name-targets.ts).
 *
 * Why it is a security rule: the passkey RP ID is `woco.eth.limo`, and a browser
 * whose Public Suffix List predates 2026-09-01 (Chrome 152 measured on 2026-10-09)
 * lets any page under it ask for the user's passkey - whose PRF output IS the
 * account. The holder controls the pointer and the feed behind it, so the gateway,
 * the only road to a signature for `*.woco.eth`, must never sign what they wrote.
 *
 * MUTATIONS (each turns this file red):
 *  - drop the ledger membership check (serve any Swarm hash as built) -> "an unknown
 *    Swarm feed shows the app";
 *  - sign the raw L2 bytes (skip the substitution) -> "the gateway signs the built
 *    collection";
 *  - drop the codec check -> "another codec carrying a known hash";
 *  - drop the depth check in the policy -> "two labels deep"; drop the handler's
 *    early depth answer -> "never reads the L2";
 *  - fall back to EMPTY instead of the app -> "an unknown Swarm feed shows the app".
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbiCoder, Interface, Wallet, concat, getBytes, hexlify, namehash, recoverAddress, toUtf8Bytes } from "ethers";
import {
  contenthashPolicy,
  createCcipHandler,
  makeSignatureHash,
  type CcipHandlerConfig,
  type ContenthashAnswer,
} from "../src/lib/ens-gateway/ccip.js";
import { encodeSwarmContenthash } from "../src/lib/sub-ens/swarm-contenthash.js";

const originalCwd = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "woco-name-targets-"));
// The store captures `join(process.cwd(), ".data")` at load: chdir before importing it.
process.chdir(dir);
const store = await import("../src/lib/sub-ens/name-targets.js");
process.chdir(originalCwd);
after(() => rmSync(dir, { recursive: true, force: true }));
const FILE = join(dir, ".data", "name-targets.json");

const ABI = AbiCoder.defaultAbiCoder();
const h = (c: string) => c.repeat(64);
const APEX = h("a");
const MANIFEST = h("b"); // a feed manifest the server deployed
const BUILT = h("c"); // what it baked there
const STRANGER = h("d"); // a Swarm hash nobody deployed
const OWNER = "0x" + "1".repeat(40);
const swarm = (hash: string) => hexlify(encodeSwarmContenthash(hash));
const built = (m: string) => (m === MANIFEST ? BUILT : null);

// ---------------------------------------------------------------------------
// The rule, pure
// ---------------------------------------------------------------------------

test("a deployed feed manifest shows the collection the server built, not the feed", () => {
  const r = contenthashPolicy({ depth: 1, l2Contenthash: swarm(MANIFEST), apexHash: APEX, lookupBuilt: built });
  assert.equal(r.answer, "built");
  assert.equal(r.contenthash, swarm(BUILT));
});

test("an unknown Swarm feed shows the app - never the holder's pointer, never nothing", () => {
  const r = contenthashPolicy({ depth: 1, l2Contenthash: swarm(STRANGER), apexHash: APEX, lookupBuilt: built });
  assert.equal(r.answer, "foreign");
  assert.equal(r.contenthash, swarm(APEX));
});

test("another codec carrying a known hash is still not WoCo's: the app", () => {
  // An IPFS-style prefix in front of the very bytes of a deployed manifest.
  const ipfsLike = "0xe301017012" + "20" + MANIFEST;
  const r = contenthashPolicy({ depth: 1, l2Contenthash: ipfsLike, apexHash: APEX, lookupBuilt: built });
  assert.equal(r.answer, "foreign");
  assert.equal(r.contenthash, swarm(APEX));
  // A Swarm prefix with a trailing byte is not a Swarm record either.
  const long = swarm(MANIFEST) + "00";
  assert.equal(contenthashPolicy({ depth: 1, l2Contenthash: long, apexHash: APEX, lookupBuilt: built }).answer, "foreign");
});

test("the app stays the app; no record stays no record", () => {
  assert.deepEqual(contenthashPolicy({ depth: 1, l2Contenthash: swarm(APEX), apexHash: APEX, lookupBuilt: built }), {
    contenthash: swarm(APEX),
    answer: "apex",
  });
  assert.deepEqual(contenthashPolicy({ depth: 1, l2Contenthash: "0x", apexHash: APEX, lookupBuilt: built }), {
    contenthash: "0x",
    answer: "empty",
  });
});

test("two labels deep shows nothing, even when its record names a deployed manifest", () => {
  const r = contenthashPolicy({ depth: 2, l2Contenthash: swarm(MANIFEST), apexHash: APEX, lookupBuilt: built });
  assert.deepEqual(r, { contenthash: "0x", answer: "depth" });
});

test("with no app configured, everything that would show the app shows nothing", () => {
  for (const l2 of [swarm(STRANGER), swarm(APEX)]) {
    const r = contenthashPolicy({ depth: 1, l2Contenthash: l2, apexHash: null, lookupBuilt: built });
    assert.equal(r.contenthash, "0x", l2);
  }
  // A deployed site still shows its build.
  assert.equal(contenthashPolicy({ depth: 1, l2Contenthash: swarm(MANIFEST), apexHash: null, lookupBuilt: built }).contenthash, swarm(BUILT));
});

// ---------------------------------------------------------------------------
// The rule, in the gateway
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

/** DNS wire format built by hand: ethers' dnsEncode normalises, which would hide the cases that matter. */
function rawDns(labels: string[]): string {
  const parts = labels.map((l) => {
    const b = toUtf8Bytes(l);
    return concat([new Uint8Array([b.length]), b]);
  });
  return hexlify(concat([...parts, new Uint8Array([0])]));
}

function request(labels: string[], inner: string): string {
  return STUFFED.encodeFunctionData("stuffedResolveCall", [rawDns(labels), inner, 421614, REGISTRY]);
}

function gateway(l2: string, onRead?: () => void) {
  const answers: ContenthashAnswer[] = [];
  const handler = createCcipHandler(CONFIG, {
    readL2: async () => {
      onRead?.();
      return l2;
    },
    now: () => NOW,
    contenthash: { apexHash: () => APEX, lookupBuilt: built, onAnswer: (a) => answers.push(a) },
  });
  return { handler, answers };
}

function decode(data: string): { result: string; expires: bigint; sig: string } {
  const [result, expires, sig] = ABI.decode(["bytes", "uint64", "bytes"], data);
  return { result: result as string, expires: expires as bigint, sig: sig as string };
}

test("the gateway signs the built collection, and the signature covers what it substituted", async () => {
  const name = "alice.woco.eth";
  const data = request(["alice", "woco", "eth"], RECORDS.encodeFunctionData("contenthash", [namehash(name)]));
  const { handler, answers } = gateway(ABI.encode(["bytes"], [swarm(MANIFEST)]));
  const out = await handler(RESOLVER, data);
  assert.equal(out.status, 200);
  const { result, expires, sig } = decode((out.body as { data: string }).data);
  assert.equal(ABI.decode(["bytes"], result)[0], swarm(BUILT), "the holder's feed manifest is never what is signed");
  const hash = makeSignatureHash(RESOLVER, expires, getBytes(data), result);
  assert.equal(recoverAddress(hash, sig), SIGNER, "the signature is over the substituted bytes");
  assert.deepEqual(answers, ["built"]);
});

test("a holder's own page is answered with the app, signed", async () => {
  const name = "alice.woco.eth";
  const data = request(["alice", "woco", "eth"], RECORDS.encodeFunctionData("contenthash", [namehash(name)]));
  const { handler, answers } = gateway(ABI.encode(["bytes"], [swarm(STRANGER)]));
  const out = await handler(RESOLVER, data);
  assert.equal(out.status, 200);
  assert.equal(ABI.decode(["bytes"], decode((out.body as { data: string }).data).result)[0], swarm(APEX));
  assert.deepEqual(answers, ["foreign"]);
});

test("a name two labels deep never reads the L2 and shows nothing - however its dots are spelled", async () => {
  const deep = namehash("x.alice.woco.eth");
  // Plain labels: signed empty. A dot INSIDE one wire label, and a FULL-WIDTH dot
  // (which ENS normalisation forbids): each either signs empty or is refused -
  // never a read, never a non-empty answer.
  for (const labels of [["x", "alice", "woco", "eth"], ["x.alice", "woco", "eth"], ["x\uFF0Ealice", "woco", "eth"]]) {
    let reads = 0;
    const { handler } = gateway(ABI.encode(["bytes"], [swarm(MANIFEST)]), () => reads++);
    const out = await handler(RESOLVER, request(labels, RECORDS.encodeFunctionData("contenthash", [deep])));
    const label = JSON.stringify(labels);
    assert.equal(reads, 0, `${label}: never reads the L2`);
    if (out.status === 200) {
      assert.equal(ABI.decode(["bytes"], decode((out.body as { data: string }).data).result)[0], "0x", label);
    } else {
      assert.equal(out.status, 400, label);
      assert.ok(!("data" in out.body), `${label}: refused, nothing signed`);
    }
  }
  const plain = gateway(ABI.encode(["bytes"], [swarm(MANIFEST)]));
  const out = await plain.handler(RESOLVER, request(["x", "alice", "woco", "eth"], RECORDS.encodeFunctionData("contenthash", [deep])));
  assert.equal(out.status, 200, "the ordinary spelling is answered, with nothing");
  assert.deepEqual(plain.answers, ["depth"]);
});

test("records other than contenthash are signed as the L2 holds them", async () => {
  const name = "alice.woco.eth";
  const l2 = ABI.encode(["address"], ["0x00000000000000000000000000000000000000ff"]);
  const { handler, answers } = gateway(l2);
  const out = await handler(RESOLVER, request(["alice", "woco", "eth"], RECORDS.encodeFunctionData("addr", [namehash(name)])));
  assert.equal(out.status, 200);
  assert.equal(decode((out.body as { data: string }).data).result, l2);
  assert.deepEqual(answers, []);
});

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

test("a deploy's record is served, survives a restart, and malformed input is refused", () => {
  store.__resetNameTargetsForTest();
  assert.equal(store.recordNameTarget(MANIFEST, { kind: "site", id: "site-1", owner: OWNER, latestRef: BUILT }), true);
  assert.equal(store.lookupNameTarget(MANIFEST), BUILT);
  assert.equal(store.lookupNameTarget("0x" + MANIFEST.toUpperCase()), BUILT, "0x and case do not matter");
  store.__resetNameTargetsForTest();
  assert.equal(store.lookupNameTarget(MANIFEST), BUILT, "reloaded from disk");
  // An empty or absent manifest writes nothing.
  for (const bad of ["", "0x", "zz"]) {
    assert.equal(store.recordNameTarget(bad, { kind: "event", id: "e", owner: OWNER, latestRef: BUILT }), false, bad);
  }
  assert.equal(store.recordNameTarget(STRANGER, { kind: "event", id: "e", owner: OWNER, latestRef: "nope" }), false);
  assert.equal(store.lookupNameTarget(STRANGER), null);
  assert.equal(store.nameTargetsHealth().ok, true);
});

test("an unreadable ledger serves nothing (every name shows the app), alarms, and is never overwritten", () => {
  mkdirSync(join(dir, ".data"), { recursive: true });
  writeFileSync(FILE, "{ not json");
  store.__resetNameTargetsForTest();
  assert.equal(store.lookupNameTarget(MANIFEST), null);
  const health = store.nameTargetsHealth();
  assert.equal(health.ok, false);
  assert.equal(health.unreadable, true);
  assert.equal(store.recordNameTarget(MANIFEST, { kind: "site", id: "site-1", owner: OWNER, latestRef: BUILT }), false);
  assert.equal(readFileSync(FILE, "utf-8"), "{ not json", "the operator's file is left exactly as it was");
  // And through the rule: an unreadable ledger means the app, not the holder's feed.
  const r = contenthashPolicy({ depth: 1, l2Contenthash: swarm(MANIFEST), apexHash: APEX, lookupBuilt: store.lookupNameTarget });
  assert.equal(r.contenthash, swarm(APEX));
  writeFileSync(FILE, "{}");
  store.__resetNameTargetsForTest();
});

// ---------------------------------------------------------------------------
// The deploy routes write it
// ---------------------------------------------------------------------------

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("both deploy routes record what they baked, and only when there is a feed manifest", () => {
  const sites = source("../src/routes/sites.ts");
  assert.match(
    sites,
    /if \(feedManifestHash\) \{\s*recordNameTarget\(feedManifestHash, \{ kind: "site", id: siteId, owner: parentAddress, latestRef: contentHash \}\);/,
  );
  const page = source("../src/routes/site.ts");
  const clientFeed = page.indexOf("if (body.clientFeed === true) {");
  const rec = page.indexOf('recordNameTarget(feedManifestHash, { kind: "event", id: eventId, owner: parentAddress, latestRef: contentHash });');
  const assigned = page.indexOf("feedManifestHash = prep.feedManifestHash;");
  assert.ok(clientFeed > 0 && assigned > clientFeed && rec > assigned, "inside the feed branch, after the manifest is known");
  assert.ok(page.indexOf("}", rec) < page.indexOf("let subEns", clientFeed), "and only there");
});

test("the gateway route wires the rule to the real apex and ledger", () => {
  const route = source("../src/routes/ens-gateway.ts");
  assert.match(route, /contenthash: \{\s*apexHash: getApexContenthash,\s*lookupBuilt: lookupNameTarget,/);
});
