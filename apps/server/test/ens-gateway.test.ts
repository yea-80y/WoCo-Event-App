/**
 * The ENS CCIP-Read gateway (#419).
 *
 * The gateway's signing key IS resolution for every `*.woco.eth` name: Durin's
 * L1Resolver accepts any `result` whose signature recovers to `signer()`. So the
 * tests that matter are the refusals — each one is a path that would otherwise
 * end in a signature.
 *
 * Imports the pure logic and the ROUTER FACTORY only. `index.ts` boots the whole
 * server on import (see security-headers.test.ts), so it is never touched here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  AbiCoder,
  Interface,
  Wallet,
  concat,
  dnsEncode,
  getAddress,
  getBytes,
  keccak256,
  namehash,
  recoverAddress,
  toBeHex,
} from "ethers";

import {
  createCcipHandler,
  decodeInnerNode,
  dnsDecodeName,
  makeSignatureHash,
  INNER_SELECTOR_ALLOWLIST,
  type CcipHandlerConfig,
} from "../src/lib/ens-gateway/ccip.js";
import { loadEnsGatewayConfig } from "../src/lib/ens-gateway/config.js";
import { createL2Reader, redactRpcUrl } from "../src/lib/ens-gateway/l2-reader.js";
import { ResponseMemo, memoTtlMsFor } from "../src/lib/ens-gateway/memo.js";
import { createEnsGatewayRoutes, ENS_GATEWAY_RATE_WINDOWS } from "../src/routes/ens-gateway.js";
import { SlidingWindowLimiter } from "../src/lib/http/rate-limit.js";
import { getSubEnsChainId } from "../src/lib/chain/sub-ens-contract.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Throwaway key — test-only, never used anywhere else. */
const SIGNER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SIGNER_ADDRESS = new Wallet(SIGNER_PK).address;

const RESOLVER = "0x1111111111111111111111111111111111111111";
const OTHER_RESOLVER = "0x2222222222222222222222222222222222222222";
const REGISTRY = "0xC38e08CB5a21B083F63149ea7597Ea8D05017cf8";
const OTHER_REGISTRY = "0x3333333333333333333333333333333333333333";
const CHAIN_ID = 421614;
/** What the loader itself will compute, so the env-var name in config tests matches. */
const DEFAULT_CHAIN = getSubEnsChainId();
const TTL = 600;
const NOW = 1_800_000_000;

const CONFIG: CcipHandlerConfig = {
  signerPrivateKey: SIGNER_PK,
  allowedSenders: [RESOLVER.toLowerCase()],
  chainId: CHAIN_ID,
  registryAddress: REGISTRY,
  parentName: "woco.eth",
  ttlSeconds: TTL,
};

/** Whatever the fake L2 hands back — an ABI-encoded address, as `addr(bytes32)` would return. */
const L2_RESULT = AbiCoder.defaultAbiCoder().encode(
  ["address"],
  ["0x00000000000000000000000000000000000000ff"],
);

const STUFFED = new Interface([
  "function stuffedResolveCall(bytes name, bytes data, uint64 targetChainId, address targetRegistryAddress) view returns (bytes)",
]);

const RECORDS = new Interface([
  "function addr(bytes32 node) view returns (address)",
  "function addr(bytes32 node, uint256 coinType) view returns (bytes)",
  "function text(bytes32 node, string key) view returns (string)",
  "function contenthash(bytes32 node) view returns (bytes)",
  "function ABI(bytes32 node, uint256 contentTypes) view returns (uint256, bytes)",
  "function name(bytes32 node) view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function resolve(bytes name, bytes data) view returns (bytes)",
]);

function addrCall(node: string): string {
  return RECORDS.encodeFunctionData("addr(bytes32)", [node]);
}

interface StuffOpts {
  name?: string;
  dnsName?: string;
  inner?: string;
  chainId?: number;
  registry?: string;
}

/** Build the exact calldata the L1 resolver would put in `OffchainLookup.callData`. */
function stuff(opts: StuffOpts = {}): string {
  const name = opts.name ?? "alice.woco.eth";
  const dns = opts.dnsName ?? dnsEncode(name);
  const inner = opts.inner ?? addrCall(namehash(name));
  return STUFFED.encodeFunctionData("stuffedResolveCall", [
    dns,
    inner,
    opts.chainId ?? CHAIN_ID,
    opts.registry ?? REGISTRY,
  ]);
}

function handler(overrides: Partial<CcipHandlerConfig> = {}, readL2?: () => Promise<string>) {
  return createCcipHandler(
    { ...CONFIG, ...overrides },
    { readL2: readL2 ?? (async () => L2_RESULT), now: () => NOW },
  );
}

function decodeResponse(data: string): { result: string; expires: bigint; sig: string } {
  const [result, expires, sig] = AbiCoder.defaultAbiCoder().decode(
    ["bytes", "uint64", "bytes"],
    data,
  );
  return { result, expires, sig };
}

// ---------------------------------------------------------------------------
// (a) Happy path
// ---------------------------------------------------------------------------

test("happy path: signs the L2 result and recovers to the configured signer", async () => {
  const calldata = stuff();
  const out = await handler()(RESOLVER, calldata);

  assert.equal(out.status, 200);
  assert.equal(out.cacheable, true);
  assert.ok("data" in out.body);

  const { result, expires, sig } = decodeResponse((out.body as { data: string }).data);
  assert.equal(result, L2_RESULT);
  assert.ok(expires > BigInt(NOW), "expires must be in the future");
  assert.ok(expires <= BigInt(NOW + TTL), "expires must not exceed now + ttl");

  // The formula is written out inline, straight from SignatureVerifier.sol:19-27,
  // so a wrong makeSignatureHash cannot pass its own test.
  const hash = keccak256(
    concat([
      "0x1900",
      RESOLVER,
      toBeHex(expires, 8),
      keccak256(getBytes(calldata)),
      keccak256(result),
    ]),
  );
  assert.equal(recoverAddress(hash, sig), SIGNER_ADDRESS);
});

// ---------------------------------------------------------------------------
// (b) Independent hash vector
// ---------------------------------------------------------------------------

test("makeSignatureHash matches an independently computed cast vector", () => {
  // TARGET=0x1111111111111111111111111111111111111111 EXPIRES=1893456000
  //   REQ=$(cast keccak 0xdeadbeef); RES=$(cast keccak 0xc0ffee)
  //   cast keccak "$(cast abi-encode --packed \
  //     'f(bytes2,address,uint64,bytes32,bytes32)' 0x1900 $TARGET $EXPIRES $REQ $RES)"
  //   → 0x5be1331ecc2784cb820d61aa6a646697c0432be473b576405787413a98f75b3b
  const expected = "0x5be1331ecc2784cb820d61aa6a646697c0432be473b576405787413a98f75b3b";
  assert.equal(
    makeSignatureHash(
      "0x1111111111111111111111111111111111111111",
      1_893_456_000n,
      getBytes("0xdeadbeef"),
      "0xc0ffee",
    ),
    expected,
  );
});

// ---------------------------------------------------------------------------
// (c) Sender pin
// ---------------------------------------------------------------------------

test("sender not on the allowlist is refused unsigned", async () => {
  const out = await handler()(OTHER_RESOLVER, stuff());
  assert.equal(out.status, 403);
  assert.equal(out.cacheable, false);
  assert.ok(!("data" in out.body));
  assert.match((out.body as { message: string }).message, /sender not served/);
});

// ---------------------------------------------------------------------------
// (d) Chain + registry pins
// ---------------------------------------------------------------------------

test("wrong target chain is refused", async () => {
  const out = await handler()(RESOLVER, stuff({ chainId: 8453 }));
  assert.equal(out.status, 403);
  assert.ok(!("data" in out.body));
  assert.match((out.body as { message: string }).message, /registry not served/);
});

test("wrong target registry is refused", async () => {
  const out = await handler()(RESOLVER, stuff({ registry: OTHER_REGISTRY }));
  assert.equal(out.status, 403);
  assert.ok(!("data" in out.body));
  assert.match((out.body as { message: string }).message, /registry not served/);
});

// ---------------------------------------------------------------------------
// (e) Which names are served
// ---------------------------------------------------------------------------

test("the apex woco.eth is structurally excluded", async () => {
  const out = await handler()(RESOLVER, stuff({ name: "woco.eth" }));
  assert.equal(out.status, 403);
  assert.match((out.body as { message: string }).message, /apex is not served/);
});

for (const name of ["x.evil.eth", "woco.eth.evil.eth", "xwoco.eth"]) {
  test(`name outside the parent is refused: ${name}`, async () => {
    const out = await handler()(RESOLVER, stuff({ name }));
    assert.equal(out.status, 403);
    assert.ok(!("data" in out.body));
    assert.match((out.body as { message: string }).message, /only names under woco\.eth/);
  });
}

test("nested names under the parent ARE served", async () => {
  const out = await handler()(RESOLVER, stuff({ name: "a.b.woco.eth" }));
  assert.equal(out.status, 200);
  assert.ok("data" in out.body);
});

// ---------------------------------------------------------------------------
// (f) Inner selector allowlist
// ---------------------------------------------------------------------------

test("every allowed record selector resolves", async () => {
  const node = namehash("alice.woco.eth");
  const calls = [
    RECORDS.encodeFunctionData("addr(bytes32)", [node]),
    RECORDS.encodeFunctionData("addr(bytes32,uint256)", [node, 60]),
    RECORDS.encodeFunctionData("text", [node, "url"]),
    RECORDS.encodeFunctionData("contenthash", [node]),
    RECORDS.encodeFunctionData("ABI", [node, 1]),
  ];
  assert.equal(INNER_SELECTOR_ALLOWLIST.size, calls.length);
  for (const inner of calls) {
    const out = await handler()(RESOLVER, stuff({ inner }));
    assert.equal(out.status, 200, `expected 200 for ${inner.slice(0, 10)}`);
  }
});

test("name(bytes32) is refused even carrying the correct node", async () => {
  // The single most load-bearing allowlist case: it takes `bytes32 node` first,
  // so the node check cannot catch it. Only the allowlist can.
  const inner = RECORDS.encodeFunctionData("name", [namehash("alice.woco.eth")]);
  const out = await handler()(RESOLVER, stuff({ inner }));
  assert.equal(out.status, 400);
  assert.ok(!("data" in out.body));
  assert.match((out.body as { message: string }).message, /not served by this gateway/);
});

test("ownerOf(uint256) is refused", async () => {
  const inner = RECORDS.encodeFunctionData("ownerOf", [1]);
  const out = await handler()(RESOLVER, stuff({ inner }));
  assert.equal(out.status, 400);
  assert.ok(!("data" in out.body));
});

test("a nested resolve(bytes,bytes) is refused", async () => {
  const inner = RECORDS.encodeFunctionData("resolve", [
    dnsEncode("alice.woco.eth"),
    addrCall(namehash("alice.woco.eth")),
  ]);
  const out = await handler()(RESOLVER, stuff({ inner }));
  assert.equal(out.status, 400);
  assert.ok(!("data" in out.body));
});

test("decodeInnerNode returns the first head word for an allowed selector", () => {
  const node = namehash("alice.woco.eth");
  assert.equal(decodeInnerNode(addrCall(node)), node.toLowerCase());
  assert.throws(() => decodeInnerNode(RECORDS.encodeFunctionData("name", [node])));
});

// ---------------------------------------------------------------------------
// (g) node == namehash(name)
// ---------------------------------------------------------------------------

test("inner node for a DIFFERENT name is refused", async () => {
  // Without this the DNS name is decorative: the L2 answers about `node`, so an
  // attacker passes a served name and reads any node they like.
  const inner = addrCall(namehash("bob.woco.eth"));
  const out = await handler()(RESOLVER, stuff({ name: "alice.woco.eth", inner }));
  assert.equal(out.status, 400);
  assert.ok(!("data" in out.body));
  assert.match((out.body as { message: string }).message, /node does not match name/);
});

test("inner node for a name OUTSIDE the parent is refused too", async () => {
  const inner = addrCall(namehash("victim.eth"));
  const out = await handler()(RESOLVER, stuff({ name: "alice.woco.eth", inner }));
  assert.equal(out.status, 400);
  assert.ok(!("data" in out.body));
});

// ---------------------------------------------------------------------------
// (h) Malformed input
// ---------------------------------------------------------------------------

test("odd-length hex data is refused", async () => {
  const out = await handler()(RESOLVER, "0x123");
  assert.equal(out.status, 400);
});

test("non-hex data is refused", async () => {
  const out = await handler()(RESOLVER, "not-hex");
  assert.equal(out.status, 400);
});

test("a malformed sender is refused before anything else", async () => {
  const out = await handler()("0xnope", stuff());
  assert.equal(out.status, 400);
});

test("oversized calldata is refused", async () => {
  const out = await handler()(RESOLVER, `0x21759430${"ab".repeat(5000)}`);
  assert.equal(out.status, 400);
});

test("wrong outer selector is refused", async () => {
  const wrong = `0xdeadbeef${stuff().slice(10)}`;
  const out = await handler()(RESOLVER, wrong);
  assert.equal(out.status, 400);
  assert.match((out.body as { message: string }).message, /stuffedResolveCall/);
});

test("truncated outer calldata is refused", async () => {
  const out = await handler()(RESOLVER, stuff().slice(0, 60));
  assert.equal(out.status, 400);
});

test("a DNS name with no terminator is refused", async () => {
  // 0x05 "alice" with the 0x00 chopped off.
  const bad = `0x${dnsEncode("alice.woco.eth").slice(2, -2)}`;
  const out = await handler()(RESOLVER, stuff({ dnsName: bad }));
  assert.equal(out.status, 400);
  assert.match((out.body as { message: string }).message, /could not decode name/);
});

test("a DNS name that is just a terminator (empty label) is refused", async () => {
  const out = await handler()(RESOLVER, stuff({ dnsName: "0x00" }));
  assert.equal(out.status, 400);
  assert.match((out.body as { message: string }).message, /could not decode name/);
});

test("a DNS name with trailing bytes after the terminator is refused", async () => {
  const out = await handler()(RESOLVER, stuff({ dnsName: `${dnsEncode("alice.woco.eth")}ffff` }));
  assert.equal(out.status, 400);
});

test("dnsDecodeName is strict about overrun, terminator, size and emptiness", () => {
  assert.equal(dnsDecodeName(getBytes(dnsEncode("alice.woco.eth"))), "alice.woco.eth");
  assert.throws(() => dnsDecodeName(new Uint8Array([])), /empty input/);
  assert.throws(() => dnsDecodeName(new Uint8Array([0x00])), /empty label/);
  assert.throws(() => dnsDecodeName(new Uint8Array([0x05, 0x61, 0x62])), /overruns/);
  assert.throws(() => dnsDecodeName(new Uint8Array([0x01, 0x61])), /missing 0x00 terminator/);
  assert.throws(
    () => dnsDecodeName(new Uint8Array([0x01, 0x61, 0x00, 0x01, 0x62, 0x00])),
    /trailing bytes/,
  );
  assert.throws(() => dnsDecodeName(new Uint8Array(256).fill(0x01)), /255-byte limit/);
});

// ---------------------------------------------------------------------------
// (j) L2 failures are never signed
// ---------------------------------------------------------------------------

test("an L2 read failure is a 502, not an empty signed answer", async () => {
  const out = await handler({}, async () => {
    throw new Error("RPC exploded");
  })(RESOLVER, stuff());
  assert.equal(out.status, 502);
  assert.equal(out.cacheable, false);
  assert.ok(!("data" in out.body), "an RPC failure must never produce a signature");
});

// ---------------------------------------------------------------------------
// (k) Config
// ---------------------------------------------------------------------------

const BASE_ENV = {
  ENS_GATEWAY_SIGNER_PRIVATE_KEY: SIGNER_PK,
  ENS_GATEWAY_RESOLVER_ADDRESSES: RESOLVER,
};

test("config: a valid env loads", () => {
  const loaded = loadEnsGatewayConfig({ ...BASE_ENV });
  assert.ok(!("disabled" in loaded), JSON.stringify(loaded));
  assert.deepEqual(loaded.allowedSenders, [RESOLVER.toLowerCase()]);
  assert.equal(loaded.parentName, "woco.eth");
  assert.equal(loaded.ttlSeconds, 600);
});

test("config: the gateway key must not be the sponsor wallet", () => {
  const loaded = loadEnsGatewayConfig({ ...BASE_ENV, WOCO_SPONSOR_PRIVATE_KEY: SIGNER_PK });
  assert.ok("disabled" in loaded);
  assert.match(loaded.disabled, /must not be the sponsor wallet/);
});

test("config: a DIFFERENT sponsor key is fine", () => {
  const other = Wallet.createRandom().privateKey;
  const loaded = loadEnsGatewayConfig({ ...BASE_ENV, WOCO_SPONSOR_PRIVATE_KEY: other });
  assert.ok(!("disabled" in loaded));
});

test("config: missing signer key disables", () => {
  const loaded = loadEnsGatewayConfig({ ENS_GATEWAY_RESOLVER_ADDRESSES: RESOLVER });
  assert.ok("disabled" in loaded);
  assert.match(loaded.disabled, /SIGNER_PRIVATE_KEY/);
});

test("config: missing resolver addresses disables", () => {
  const loaded = loadEnsGatewayConfig({ ENS_GATEWAY_SIGNER_PRIVATE_KEY: SIGNER_PK });
  assert.ok("disabled" in loaded);
  assert.match(loaded.disabled, /RESOLVER_ADDRESSES/);
});

test("config: a non-address in the resolver list disables", () => {
  const loaded = loadEnsGatewayConfig({
    ...BASE_ENV,
    ENS_GATEWAY_RESOLVER_ADDRESSES: `${RESOLVER},lolno`,
  });
  assert.ok("disabled" in loaded);
  assert.match(loaded.disabled, /non-address/);
});

for (const ttl of ["59", "3601", "0", "abc", "600.5"]) {
  test(`config: TTL out of range disables (${ttl})`, () => {
    const loaded = loadEnsGatewayConfig({ ...BASE_ENV, ENS_GATEWAY_TTL_SECONDS: ttl });
    assert.ok("disabled" in loaded, `expected ${ttl} to be refused`);
    assert.match(loaded.disabled, /TTL_SECONDS/);
  });
}

// ---------------------------------------------------------------------------
// (i) + (l) Route level
// ---------------------------------------------------------------------------

test("route: a 200 carries a short public cache header", async () => {
  const app = createEnsGatewayRoutes(handler());
  const res = await app.request(`/v1/${RESOLVER}/${stuff()}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=60");
  const body = (await res.json()) as { data: string };
  assert.ok(body.data.startsWith("0x"));
});

test("route: a 403 is never cached", async () => {
  const app = createEnsGatewayRoutes(handler());
  const res = await app.request(`/v1/${OTHER_RESOLVER}/${stuff()}`);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = (await res.json()) as Record<string, unknown>;
  assert.ok(!("data" in body));
});

test("route: a disabled gateway answers 503 on every path, uncached", async () => {
  const app = createEnsGatewayRoutes({ disabled: "no signer key" });
  for (const path of [`/v1/${RESOLVER}/${stuff()}`, "/v1/anything/0x00", "/"]) {
    const res = await app.request(path);
    assert.equal(res.status, 503, path);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = (await res.json()) as { message: string };
    assert.match(body.message, /no signer key/);
    assert.ok(!("data" in body));
  }
});

// ---------------------------------------------------------------------------
// (m) #465 §1 — two-RPC cross-check
//
// The reader is the gateway's whole notion of truth. Every case here is a way
// the signing key could be made to sign something the L2 never said.
// ---------------------------------------------------------------------------

const REGISTRY_CALL_RESULT = AbiCoder.defaultAbiCoder().encode(["bytes"], [L2_RESULT]);
const OTHER_CALL_RESULT = AbiCoder.defaultAbiCoder().encode(
  ["bytes"],
  [AbiCoder.defaultAbiCoder().encode(["address"], ["0x00000000000000000000000000000000000000aa"])],
);

const RPC_A = "https://rpc-a.example/v2/KEY_A";
const RPC_B = "https://rpc-b.example/v2/KEY_B";

/** Builds a reader over fake endpoints; `answers` maps a URL to what it returns (or throws). */
function reader(urls: string[], answers: Record<string, string | Error>, calls?: string[]) {
  return createL2Reader(CHAIN_ID, urls, {
    makeCall: (url) => async () => {
      calls?.push(url);
      const a = answers[url];
      if (a instanceof Error) throw a;
      if (a === undefined) throw new Error(`no fake answer for ${url}`);
      return a;
    },
  });
}

const NAME_BYTES = getBytes(dnsEncode("alice.woco.eth"));

test("cross-check: two agreeing endpoints produce the answer, and BOTH are read", async () => {
  const calls: string[] = [];
  const read = reader([RPC_A, RPC_B], { [RPC_A]: REGISTRY_CALL_RESULT, [RPC_B]: REGISTRY_CALL_RESULT }, calls);
  const out = await read(REGISTRY, NAME_BYTES, addrCall(namehash("alice.woco.eth")));
  assert.equal(out.toLowerCase(), L2_RESULT.toLowerCase());
  assert.deepEqual(calls.sort(), [RPC_A, RPC_B].sort(), "both endpoints must be consulted");
});

test("cross-check: DISAGREEMENT refuses — nothing is returned to be signed", async () => {
  const read = reader([RPC_A, RPC_B], { [RPC_A]: REGISTRY_CALL_RESULT, [RPC_B]: OTHER_CALL_RESULT });
  await assert.rejects(
    () => read(REGISTRY, NAME_BYTES, addrCall(namehash("alice.woco.eth"))),
    /disagree/,
    "a disagreeing pair must never resolve to one of the two answers",
  );
});

test("cross-check: the disagreement names both endpoints and both values, credentials stripped", async () => {
  const read = reader([RPC_A, RPC_B], { [RPC_A]: REGISTRY_CALL_RESULT, [RPC_B]: OTHER_CALL_RESULT });
  const err = await read(REGISTRY, NAME_BYTES, addrCall(namehash("alice.woco.eth"))).then(
    () => null,
    (e: Error) => e,
  );
  assert.ok(err, "expected a rejection");
  assert.match(err.message, /rpc-a\.example/);
  assert.match(err.message, /rpc-b\.example/);
  assert.ok(err.message.includes("ff"), "the differing values must be in the log line");
  assert.ok(!err.message.includes("KEY_A"), "an API key must never reach a log line");
  assert.ok(!err.message.includes("KEY_B"), "an API key must never reach a log line");
});

test("cross-check: one endpoint failing is a REFUSAL, not a fallback to the survivor", async () => {
  // The attack this closes: knock one provider over, then lie on the other.
  const read = reader([RPC_A, RPC_B], { [RPC_A]: new Error("boom"), [RPC_B]: OTHER_CALL_RESULT });
  await assert.rejects(
    () => read(REGISTRY, NAME_BYTES, addrCall(namehash("alice.woco.eth"))),
    /L2 read failed/,
    "a single surviving endpoint must not become the answer",
  );
});

test("cross-check: both endpoints failing still refuses", async () => {
  const read = reader([RPC_A, RPC_B], { [RPC_A]: new Error("a down"), [RPC_B]: new Error("b down") });
  await assert.rejects(() => read(REGISTRY, NAME_BYTES, addrCall(namehash("alice.woco.eth"))), /2\/2/);
});

test("cross-check: a single endpoint still works (the pre-#465 posture)", async () => {
  const read = reader([RPC_A], { [RPC_A]: REGISTRY_CALL_RESULT });
  assert.equal(
    (await read(REGISTRY, NAME_BYTES, addrCall(namehash("alice.woco.eth")))).toLowerCase(),
    L2_RESULT.toLowerCase(),
  );
});

test("cross-check: the reader refuses to be built against the same URL twice", () => {
  assert.throws(() => createL2Reader(CHAIN_ID, [RPC_A, RPC_A]), /duplicate/i);
});

test("cross-check: the ABI decoder normalises case, so two spellings are one value", async () => {
  // PINS THE PREMISE, not the guard. Comparing endpoint answers is only sound
  // if a value has ONE spelling by the time it is compared; today that holds
  // because ethers' decoder lowercases its output, which is why the explicit
  // normalisation in the reader has no reachable failure mode. If an ethers
  // upgrade ever stops normalising, THIS test breaks first and tells us the
  // reader's `toLowerCase` has become load-bearing rather than belt.
  const upper = `0x${REGISTRY_CALL_RESULT.slice(2).toUpperCase()}`;
  assert.notEqual(upper, REGISTRY_CALL_RESULT, "fixture must differ in spelling");
  const decoded = new Interface(["function resolve(bytes name, bytes data) view returns (bytes)"])
    .decodeFunctionResult("resolve", upper)[0] as string;
  assert.equal(decoded, decoded.toLowerCase(), "the decoder must emit one canonical spelling");

  const read = reader([RPC_A, RPC_B], { [RPC_A]: REGISTRY_CALL_RESULT, [RPC_B]: upper });
  const out = await read(REGISTRY, NAME_BYTES, addrCall(namehash("alice.woco.eth")));
  assert.equal(out.toLowerCase(), L2_RESULT.toLowerCase(), "case alone is not a disagreement");
});

test("redactRpcUrl keeps the origin and drops path, query and credentials", () => {
  assert.equal(redactRpcUrl("https://x.example/v2/SECRET?apikey=ALSO_SECRET"), "https://x.example");
  assert.equal(redactRpcUrl("https://user:pw@x.example/v2/SECRET"), "https://x.example");
  assert.equal(redactRpcUrl("not a url"), "<unparseable rpc url>");
});

test("config: a second endpoint on a different origin turns the cross-check on", () => {
  const loaded = loadEnsGatewayConfig({
    ...BASE_ENV,
    [`RPC_URL_${DEFAULT_CHAIN}`]: RPC_A,
    ENS_GATEWAY_RPC_URL_2: RPC_B,
  });
  assert.ok(!("disabled" in loaded), JSON.stringify(loaded));
  assert.deepEqual(loaded.rpcUrls, [RPC_A, RPC_B]);
});

test("config: a second endpoint at the SAME origin disables rather than faking a cross-check", () => {
  // Two API keys at one provider are one provider — it would agree with itself.
  const loaded = loadEnsGatewayConfig({
    ...BASE_ENV,
    [`RPC_URL_${DEFAULT_CHAIN}`]: "https://same.example/v2/KEY_ONE",
    ENS_GATEWAY_RPC_URL_2: "https://same.example/v2/KEY_TWO",
  });
  assert.ok("disabled" in loaded, "same-origin endpoints must not boot a green cross-check");
  assert.match(loaded.disabled, /shares an origin/);
});

test("config: no second endpoint is allowed, and leaves exactly one URL", () => {
  const loaded = loadEnsGatewayConfig({ ...BASE_ENV, [`RPC_URL_${DEFAULT_CHAIN}`]: RPC_A });
  assert.ok(!("disabled" in loaded), JSON.stringify(loaded));
  assert.deepEqual(loaded.rpcUrls, [RPC_A]);
});

test("config: a non-http second endpoint disables", () => {
  const loaded = loadEnsGatewayConfig({
    ...BASE_ENV,
    [`RPC_URL_${DEFAULT_CHAIN}`]: RPC_A,
    ENS_GATEWAY_RPC_URL_2: "ws://rpc-b.example",
  });
  assert.ok("disabled" in loaded);
  assert.match(loaded.disabled, /ENS_GATEWAY_RPC_URL_2 is not an http/);
});

// ---------------------------------------------------------------------------
// (n) #465 §2 — the memo
// ---------------------------------------------------------------------------

/** A handler with a memo attached, plus a counter of how often the L2 was actually read. */
function memoHandler(opts: { memo?: ResponseMemo<{ data: string }>; now?: () => number } = {}) {
  const state = { reads: 0 };
  const memo = opts.memo ?? new ResponseMemo<{ data: string }>(30_000);
  const handler = createCcipHandler(CONFIG, {
    readL2: async () => {
      state.reads += 1;
      return L2_RESULT;
    },
    now: opts.now ?? (() => NOW),
    memo,
  });
  return { handler, state, memo };
}

test("memo: a repeat of the same request costs no second L2 read and returns identical bytes", async () => {
  const { handler, state } = memoHandler();
  const calldata = stuff();
  const first = await handler(RESOLVER, calldata);
  const second = await handler(RESOLVER, calldata);
  assert.equal(state.reads, 1, "the second request must not touch the L2");
  assert.equal(second.status, 200);
  assert.equal(second.cacheable, true);
  assert.deepEqual(second.body, first.body, "a memo hit must be byte-identical, signature included");
});

test("memo: CALLDATA hex case cannot be varied to miss the memo", async () => {
  // Without lowercasing the key this is the whole bypass: the signature covers
  // the request BYTES, so a case-flipped spelling is the same request, and a
  // flood could vary it per request to put every one back on the RPC.
  const { handler, state } = memoHandler();
  const calldata = stuff();
  const first = await handler(RESOLVER, calldata);
  const upper = `0x${calldata.slice(2).toUpperCase()}`;
  assert.notEqual(upper, calldata, "fixture must actually differ in spelling");
  const out = await handler(RESOLVER, upper);
  // Status first: a refusal would leave `reads` at 1 too, and pass vacuously.
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, first.body, "the same bytes must yield the same signed answer");
  assert.equal(state.reads, 1, "a case-flipped spelling of the same request must hit the memo");
});

test("memo: SENDER case cannot be varied to miss the memo", async () => {
  // Same argument on the other half of the key: `makeSignatureHash` checksums
  // the target, so two spellings of one address are one request.
  const mixed = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";
  let reads = 0;
  const handler = createCcipHandler(
    { ...CONFIG, allowedSenders: [mixed.toLowerCase()] },
    {
      readL2: async () => {
        reads += 1;
        return L2_RESULT;
      },
      now: () => NOW,
      memo: new ResponseMemo<{ data: string }>(30_000),
    },
  );
  const calldata = stuff();
  const first = await handler(mixed, calldata);
  assert.equal(first.status, 200);
  const second = await handler(mixed.toLowerCase(), calldata);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body);
  assert.equal(reads, 1, "one address spelled two ways is one request");
});

test("a pinned sender in NON-EIP-55 mixed case is answered, not thrown", async () => {
  // Regression for a defect in #466 as merged: the raw spelling reached
  // `getAddress` at the signing step, which throws on a bad checksum — so this
  // request became an unhandled 500 AFTER paying for the L2 read, and never
  // reached the memo write. `0xAbCdEf01…` below is deliberately not valid EIP-55.
  const mixed = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";
  assert.throws(() => getAddress(mixed), /checksum/, "fixture must be a BAD checksum");
  const out = await createCcipHandler(
    { ...CONFIG, allowedSenders: [mixed.toLowerCase()] },
    { readL2: async () => L2_RESULT, now: () => NOW },
  )(mixed, stuff());
  assert.equal(out.status, 200);
});

test("the signature is identical however the sender is spelled", async () => {
  // The normalisation must not move the signed bytes: `getAddress` emits the
  // same 20 bytes for every spelling, so both must recover to the same signer
  // over the same hash.
  const lower = RESOLVER.toLowerCase();
  const checksummed = getAddress(RESOLVER);
  const calldata = stuff();
  const a = await handler()(lower, calldata);
  const b = await handler()(checksummed, calldata);
  assert.deepEqual(a.body, b.body);
  const { result, expires, sig } = decodeResponse((a.body as { data: string }).data);
  assert.equal(
    recoverAddress(makeSignatureHash(checksummed, expires, getBytes(calldata), result), sig),
    SIGNER_ADDRESS,
    "a verifier using the checksummed target must still verify",
  );
});

test("memo: the SENDER is part of the key — one resolver's answer is never served to another", async () => {
  const config = { ...CONFIG, allowedSenders: [RESOLVER.toLowerCase(), OTHER_RESOLVER.toLowerCase()] };
  let reads = 0;
  const handler = createCcipHandler(config, {
    readL2: async () => {
      reads += 1;
      return L2_RESULT;
    },
    now: () => NOW,
    memo: new ResponseMemo<{ data: string }>(30_000),
  });
  const calldata = stuff();
  const a = await handler(RESOLVER, calldata);
  const b = await handler(OTHER_RESOLVER, calldata);
  assert.equal(reads, 2, "a different sender is a different request");
  assert.notDeepEqual(a.body, b.body, "the signature is bound to the sender and must differ");
  // And the proof that matters: b's signature verifies against OTHER_RESOLVER.
  const { result, expires, sig } = decodeResponse((b.body as { data: string }).data);
  assert.equal(
    recoverAddress(makeSignatureHash(OTHER_RESOLVER, expires, getBytes(calldata), result), sig),
    SIGNER_ADDRESS,
  );
});

test("memo: a REFUSAL is never stored — a transient RPC failure is not pinned", async () => {
  let reads = 0;
  const handler = createCcipHandler(CONFIG, {
    readL2: async () => {
      reads += 1;
      if (reads === 1) throw new Error("transient");
      return L2_RESULT;
    },
    now: () => NOW,
    memo: new ResponseMemo<{ data: string }>(30_000),
    logError: () => {},
  });
  const calldata = stuff();
  assert.equal((await handler(RESOLVER, calldata)).status, 502);
  const second = await handler(RESOLVER, calldata);
  assert.equal(second.status, 200, "one bad second at a provider must not become a memo-long outage");
  assert.equal(reads, 2);
});

test("memo: an entry stops being served once it goes stale", async () => {
  let clock = NOW;
  let reads = 0;
  const handler = createCcipHandler(CONFIG, {
    readL2: async () => {
      reads += 1;
      return L2_RESULT;
    },
    now: () => clock,
    memo: new ResponseMemo<{ data: string }>(30_000),
  });
  const calldata = stuff();
  await handler(RESOLVER, calldata);
  assert.equal(reads, 1);
  clock = NOW + 29;
  await handler(RESOLVER, calldata);
  assert.equal(reads, 1, "still fresh");
  clock = NOW + 31;
  await handler(RESOLVER, calldata);
  assert.equal(reads, 2, "a stale entry must fall through to a fresh read");
});

test("memo: freshness is judged on the handler's clock, not the wall clock", async () => {
  // The two are the same instant by construction; if they ever drift, a memo hit
  // can outlive the signature it is holding.
  let clock = NOW;
  let reads = 0;
  const handler = createCcipHandler(
    { ...CONFIG, ttlSeconds: 60 },
    {
      readL2: async () => {
        reads += 1;
        return L2_RESULT;
      },
      now: () => clock,
      memo: new ResponseMemo<{ data: string }>(memoTtlMsFor(60)),
    },
  );
  const calldata = stuff();
  await handler(RESOLVER, calldata);
  clock = NOW + 31;
  await handler(RESOLVER, calldata);
  assert.equal(reads, 2, "a 60s signature must not be memoised past 30s");
});

test("memo: never serves an entry past the SIGNATURE's own deadline", () => {
  // Belt to the clamp's braces: even a memo window longer than the signature's
  // life cannot hand back something the resolver would reject.
  const memo = new ResponseMemo<{ data: string }>(10 * 60_000);
  const t0 = 1_000_000;
  memo.set("k", { data: "0xdead" }, BigInt(Math.floor(t0 / 1000) + 5), t0);
  assert.deepEqual(memo.get("k", t0 + 1_000), { data: "0xdead" }, "still valid");
  assert.equal(memo.get("k", t0 + 6_000), null, "past `expires` — must not be served");
});

test("memo: capacity is bounded and eviction is least-recently-stored", () => {
  const memo = new ResponseMemo<{ data: string }>(60_000, 3);
  const far = BigInt(Math.floor(Date.now() / 1000) + 3600);
  for (const k of ["a", "b", "c", "d"]) memo.set(k, { data: `0x${k}` }, far);
  assert.equal(memo.size(), 3, "an unbounded memo is the #163 defect on the route that bounds callers");
  assert.equal(memo.get("a"), null, "the stalest entry is the one evicted");
  assert.deepEqual(memo.get("d"), { data: "0xd" });
});

test("memo: the TTL is clamped to half the signature's life", () => {
  assert.equal(memoTtlMsFor(600), 30_000);
  assert.equal(memoTtlMsFor(60), 30_000);
  // A future TTL below the memo window must shrink the window, not outlive it.
  assert.equal(memoTtlMsFor(40), 20_000);
  assert.ok(memoTtlMsFor(10) < 10_000);
});

test("memo: a handler with NO memo behaves exactly as before", async () => {
  let reads = 0;
  const handler = createCcipHandler(CONFIG, {
    readL2: async () => {
      reads += 1;
      return L2_RESULT;
    },
    now: () => NOW,
  });
  const calldata = stuff();
  await handler(RESOLVER, calldata);
  await handler(RESOLVER, calldata);
  assert.equal(reads, 2);
});

test("memo: an unpinned sender is refused whatever the memo holds", async () => {
  const { handler } = memoHandler();
  await handler(RESOLVER, stuff());
  const out = await handler(OTHER_RESOLVER, stuff());
  assert.equal(out.status, 403);
  assert.ok(!("data" in out.body));
});

// ---------------------------------------------------------------------------
// (o) #465 §2 — the per-IP limiter
// ---------------------------------------------------------------------------

const IP_A = { "cf-connecting-ip": "203.0.113.7" };
const IP_B = { "cf-connecting-ip": "198.51.100.9" };

test("rate limit: a caller over the burst window gets 429, uncached", async () => {
  const limiter = new SlidingWindowLimiter([{ limit: 2, windowMs: 10_000 }]);
  const app = createEnsGatewayRoutes(handler(), { limiter });
  const url = `/v1/${RESOLVER}/${stuff()}`;
  for (let i = 0; i < 2; i++) {
    assert.equal((await app.request(url, { headers: IP_A })).status, 200, `request ${i}`);
  }
  const refused = await app.request(url, { headers: IP_A });
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("cache-control"), "no-store");
  const body = (await refused.json()) as Record<string, unknown>;
  assert.ok(!("data" in body), "a refused request must never carry a signature");
});

test("rate limit: buckets are per IP — one flooder does not take everyone down", async () => {
  const limiter = new SlidingWindowLimiter([{ limit: 1, windowMs: 10_000 }]);
  const app = createEnsGatewayRoutes(handler(), { limiter });
  const url = `/v1/${RESOLVER}/${stuff()}`;
  assert.equal((await app.request(url, { headers: IP_A })).status, 200);
  assert.equal((await app.request(url, { headers: IP_A })).status, 429);
  assert.equal((await app.request(url, { headers: IP_B })).status, 200, "a second caller is unaffected");
});

test("rate limit: applies to the DISABLED gateway too", async () => {
  const limiter = new SlidingWindowLimiter([{ limit: 1, windowMs: 10_000 }]);
  const app = createEnsGatewayRoutes({ disabled: "no signer key" }, { limiter });
  assert.equal((await app.request("/v1/x/0x00", { headers: IP_A })).status, 503);
  assert.equal((await app.request("/v1/x/0x00", { headers: IP_A })).status, 429);
});

test("rate limit: the limiter runs BEFORE the handler, so a refused request costs no L2 read", async () => {
  let reads = 0;
  const counting = createCcipHandler(CONFIG, {
    readL2: async () => {
      reads += 1;
      return L2_RESULT;
    },
    now: () => NOW,
  });
  const limiter = new SlidingWindowLimiter([{ limit: 1, windowMs: 10_000 }]);
  const app = createEnsGatewayRoutes(counting, { limiter });
  const url = `/v1/${RESOLVER}/${stuff()}`;
  await app.request(url, { headers: IP_A });
  await app.request(url, { headers: IP_A });
  assert.equal(reads, 1, "the 429 must be decided without reaching the L2");
});

test("rate limit: the shipped windows allow a real page load and cap a sustained flood", () => {
  // A guard on the NUMBERS, not the mechanism: shared resolution front-ends
  // (.limo and friends) put many users behind one address, so a limit sized for
  // one human here would stop every *.woco.eth name resolving for all of them.
  const limiter = new SlidingWindowLimiter(ENS_GATEWAY_RATE_WINDOWS);
  const t = Date.now();
  for (let i = 0; i < 60; i++) {
    assert.ok(limiter.allow("ip:x", t), `a 60-record burst must pass (${i})`);
  }
  let allowed = 0;
  for (let i = 0; i < 5_000; i++) if (limiter.allow("ip:x", t + 30_000)) allowed++;
  assert.ok(allowed < 600, `a sustained flood must be capped, allowed ${allowed}`);
});

// ---------------------------------------------------------------------------
// (p) #465 §3 — refusal logging is injectable, so the suite stays readable
// ---------------------------------------------------------------------------

test("an L2 failure logs through the injected logger and not to the console", async () => {
  const logged: string[] = [];
  const out = await createCcipHandler(CONFIG, {
    readL2: async () => {
      throw new Error("RPC exploded");
    },
    now: () => NOW,
    logError: (message, err) => logged.push(`${message} ${(err as Error).message}`),
  })(RESOLVER, stuff());
  assert.equal(out.status, 502);
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /alice\.woco\.eth/);
  assert.match(logged[0]!, /RPC exploded/);
});

test("the 502 body never carries the read failure's detail", async () => {
  const out = await createCcipHandler(CONFIG, {
    readL2: async () => {
      throw new Error("disagree: https://rpc-a.example => 0xaaa | https://rpc-b.example => 0xbbb");
    },
    now: () => NOW,
    logError: () => {},
  })(RESOLVER, stuff());
  assert.equal(out.status, 502);
  assert.equal(JSON.stringify(out.body).includes("rpc-a.example"), false);
});
