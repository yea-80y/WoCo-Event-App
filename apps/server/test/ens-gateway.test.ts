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
import { createEnsGatewayRoutes } from "../src/routes/ens-gateway.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Throwaway key — test-only, never used anywhere else. */
const SIGNER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SIGNER_ADDRESS = new Wallet(SIGNER_PK).address;

const RESOLVER = "0x1111111111111111111111111111111111111111";
const OTHER_RESOLVER = "0x2222222222222222222222222222222222222222";
const REGISTRY = "0x41Fb196Ae7D65E06880A240c8d1B91245Fb84807";
const OTHER_REGISTRY = "0x3333333333333333333333333333333333333333";
const CHAIN_ID = 421614;
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
