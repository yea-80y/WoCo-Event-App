/**
 * The certificate warm-up is a single deliberate request, and "single" is the
 * whole safety property.
 *
 * eth.limo issues a subname's certificate during the first TLS handshake and
 * rate-limits the ask per hostname (~10 per 15 minutes), so a retry — the
 * obvious "fix" when the first attempt fails, which it will while the handshake
 * is exactly what is being warmed — is how a name gets locked out of issuance
 * for the window. These tests pin the call count and the ordering against the
 * contenthash receipt; the network side is injected because there is nothing to
 * warm in a test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AbiCoder, Interface, dnsEncode, namehash } from "ethers";
import { subEnsName, subEnsWebUrl } from "@woco/shared";
import { warmSubEnsWebCert, warmSubEnsWebCertWhenResolvable } from "../src/lib/sub-ens/cert-warmup.js";
import { publicContenthashQueryUrl } from "../src/lib/ens-gateway/public-url.js";
import { createCcipHandler } from "../src/lib/ens-gateway/ccip.js";

interface Call {
  url: string;
  init: RequestInit;
}

/** A fake fetch that records what it was asked for and answers however told. */
function fakeFetch(answer: () => Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return answer();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function response(status: number): Response {
  return new Response(null, { status });
}

test("the request is a HEAD to the name's own web address, bounded and unredirected", async () => {
  const { fn, calls } = fakeFetch(async () => response(200));
  const lines: string[] = [];
  await warmSubEnsWebCert("punkpub", { fetch: fn, log: (l) => lines.push(l) });

  assert.equal(calls.length, 1);
  // Built from the shared helper, never a suffix spelled out here — the point of
  // the warm-up is to warm the address the organiser is actually handed.
  assert.equal(calls[0].url, subEnsWebUrl("punkpub"));
  assert.equal(calls[0].init.method, "HEAD");
  // A redirect would be a second hostname's handshake, spending someone else's ask.
  assert.equal(calls[0].init.redirect, "manual");
  assert.ok(calls[0].init.signal instanceof AbortSignal, "the attempt must be time-bounded");
});

test("a refused handshake is swallowed and never retried", async () => {
  const { fn, calls } = fakeFetch(async () => {
    throw new Error("write EPROTO tlsv1 alert internal error");
  });
  const lines: string[] = [];
  const status = await warmSubEnsWebCert("punkpub", { fetch: fn, log: (l) => lines.push(l) });

  assert.equal(status, null);
  assert.equal(calls.length, 1, "a retry would spend a second ask on a hostname that just failed");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /cert warm-up .*failed: write EPROTO/);
});

test("a non-2xx answer is reported, not retried", async () => {
  const { fn, calls } = fakeFetch(async () => response(404));
  const lines: string[] = [];
  const status = await warmSubEnsWebCert("punkpub", { fetch: fn, log: (l) => lines.push(l) });

  assert.equal(status, 404);
  assert.equal(calls.length, 1);
  assert.match(lines[0], /cert warm-up .* → 404/);
});

test("a served name reports its status", async () => {
  const { fn, calls } = fakeFetch(async () => response(200));
  const status = await warmSubEnsWebCert("punkpub", { fetch: fn, log: () => {} });
  assert.equal(status, 200);
  assert.equal(calls.length, 1);
});

test("a label that could not be a name is refused before any request", async () => {
  const { fn, calls } = fakeFetch(async () => response(200));
  const lines: string[] = [];
  const status = await warmSubEnsWebCert("evil.com/x", { fetch: fn, log: (l) => lines.push(l) });

  assert.equal(status, null);
  // Zero, not one: the label decides the host, so a bad label is not a failed
  // warm-up, it is a request that must never leave.
  assert.equal(calls.length, 0);
  assert.match(lines[0], /cert warm-up refused label/);
});

// ---------------------------------------------------------------------------
// The wiring
// ---------------------------------------------------------------------------

function sourceOf(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
}

test("the warm-up runs only after the contenthash receipt", () => {
  // Before the receipt it would ask eth.limo about a name with no contenthash,
  // and that negative answer is cached for 300 s — the opposite of warming.
  const chain = sourceOf("../src/lib/chain/sub-ens-contract.ts");
  const start = chain.indexOf("export async function relaySignedContenthash");
  assert.ok(start > 0, "relaySignedContenthash not found");
  const next = chain.indexOf("\nexport ", start + 10);
  const body = chain.slice(start, next > 0 ? next : undefined);

  const waitIdx = body.indexOf("tx.wait(1)");
  const warmIdx = body.indexOf("warmSubEnsWebCertWhenResolvable(");
  assert.ok(waitIdx > 0, "the receipt must still be awaited");
  assert.ok(warmIdx > 0, "the contenthash update must warm the name's certificate");
  assert.ok(warmIdx > waitIdx, "the warm-up must come after the receipt, never before");
  // Gated on what the public gateway serves, and on the contenthash just written.
  assert.match(body.slice(warmIdx), /^warmSubEnsWebCertWhenResolvable\(\s*label,\s*hexlify\(contenthash\),\s*publicContenthashQueryUrl\(/);
  // The ungated knock is what bought eth.limo's negative on 2026-09-21 (#557).
  assert.ok(!/warmSubEnsWebCert\(label\)/.test(body), "the relay must not knock ungated");
});

// ---------------------------------------------------------------------------
// Knock only once the public gateway serves the new pointer (#557)
// ---------------------------------------------------------------------------

const ABI = AbiCoder.defaultAbiCoder();
const QUERY_URL = "https://api.example/api/ens-gateway/v1/0x1111111111111111111111111111111111111111/0xdead";
const NEW_HASH = "0xe40101fa011b20" + "ab".repeat(32);
const OLD_HASH = "0xe40101fa011b20" + "cd".repeat(32);

/** The body the gateway answers with: `(bytes result, uint64 expires, bytes sig)`, result = `abi.encode(bytes)`. */
function gatewayBody(contenthash: string): string {
  const result = ABI.encode(["bytes"], [contenthash]);
  return JSON.stringify({ data: ABI.encode(["bytes", "uint64", "bytes"], [result, 1n, "0x" + "00".repeat(65)]) });
}

/**
 * A fake network: the gateway query answers from `served` in turn (the last one
 * repeats), the name's web address answers the HEAD. Time only moves when the
 * code sleeps, so a five-minute window runs instantly.
 */
function fakeNetwork(served: Array<() => Response>) {
  const calls: Call[] = [];
  let polls = 0;
  let clock = 0;
  const fn = (async (url: unknown, init: unknown) => {
    const u = String(url);
    calls.push({ url: u, init: (init ?? {}) as RequestInit });
    if (u === QUERY_URL) return served[Math.min(polls++, served.length - 1)]();
    return response(200);
  }) as unknown as typeof fetch;
  const deps = {
    fetch: fn,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    intervalMs: 15_000,
    windowMs: 5 * 60_000,
  };
  return { deps, calls };
}

const serving = (hash: string) => () => new Response(gatewayBody(hash), { status: 200 });

test("no knock until the gateway serves the new contenthash, then exactly one", async () => {
  const { deps, calls } = fakeNetwork([serving(OLD_HASH), serving(OLD_HASH), serving(NEW_HASH)]);
  const status = await warmSubEnsWebCertWhenResolvable("punkpub", NEW_HASH, QUERY_URL, { ...deps, log: () => {} });

  assert.equal(status, 200);
  assert.deepEqual(
    calls.map((c) => c.url),
    [QUERY_URL, QUERY_URL, QUERY_URL, subEnsWebUrl("punkpub")],
    "three polls, the knock only after the third saw the new pointer",
  );
  const head = calls[3].init;
  assert.equal(head.method, "HEAD");
  assert.equal(head.redirect, "manual");
});

test("the match ignores hex case", async () => {
  const { deps, calls } = fakeNetwork([serving(NEW_HASH)]);
  await warmSubEnsWebCertWhenResolvable("punkpub", NEW_HASH.toUpperCase().replace("0X", "0x"), QUERY_URL, {
    ...deps,
    log: () => {},
  });
  assert.equal(calls.filter((c) => c.url === subEnsWebUrl("punkpub")).length, 1);
});

test("never served within the window: no knock at all", async () => {
  const { deps, calls } = fakeNetwork([serving(OLD_HASH)]);
  const lines: string[] = [];
  const status = await warmSubEnsWebCertWhenResolvable("punkpub", NEW_HASH, QUERY_URL, {
    ...deps,
    log: (l) => lines.push(l),
  });

  assert.equal(status, null);
  // A handshake while eth.limo would still be told "no contenthash" caches the
  // negative for 300 s: the exact failure this exists to avoid.
  assert.equal(calls.filter((c) => c.url !== QUERY_URL).length, 0);
  // Bounded: one poll at t=0 and one per interval up to the window, no more.
  assert.equal(calls.length, 5 * 60 / 15 + 1);
  assert.match(lines.at(-1) ?? "", /cert warm-up skipped .*did not serve the new contenthash/);
});

test("gateway errors and junk answers count as not yet", async () => {
  const { deps, calls } = fakeNetwork([
    () => response(502),
    () => new Response("not json", { status: 200 }),
    () => new Response(JSON.stringify({ message: "refused" }), { status: 200 }),
    () => new Response(JSON.stringify({ data: "0x1234" }), { status: 200 }),
    serving(NEW_HASH),
  ]);
  const status = await warmSubEnsWebCertWhenResolvable("punkpub", NEW_HASH, QUERY_URL, { ...deps, log: () => {} });

  assert.equal(status, 200);
  assert.equal(calls.filter((c) => c.url === QUERY_URL).length, 5);
  assert.equal(calls.filter((c) => c.url === subEnsWebUrl("punkpub")).length, 1);
});

test("a thrown poll counts as not yet, and never becomes a knock", async () => {
  const { deps, calls } = fakeNetwork([
    () => {
      throw new Error("ECONNRESET");
    },
    serving(NEW_HASH),
  ]);
  const status = await warmSubEnsWebCertWhenResolvable("punkpub", NEW_HASH, QUERY_URL, { ...deps, log: () => {} });
  assert.equal(status, 200);
  assert.equal(calls.filter((c) => c.url === subEnsWebUrl("punkpub")).length, 1);
});

test("no public gateway URL: nothing is fetched", async () => {
  const { deps, calls } = fakeNetwork([serving(NEW_HASH)]);
  const lines: string[] = [];
  const status = await warmSubEnsWebCertWhenResolvable("punkpub", NEW_HASH, null, {
    ...deps,
    log: (l) => lines.push(l),
  });
  assert.equal(status, null);
  assert.equal(calls.length, 0);
  assert.match(lines[0], /cert warm-up skipped .*no public gateway URL/);
});

test("the gated warm-up refuses a bad label before any request", async () => {
  const { deps, calls } = fakeNetwork([serving(NEW_HASH)]);
  const status = await warmSubEnsWebCertWhenResolvable("evil.com/x", NEW_HASH, QUERY_URL, { ...deps, log: () => {} });
  assert.equal(status, null);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// The query is the one an outside resolver makes, and the real gateway answers it
// ---------------------------------------------------------------------------

const RESOLVER = "0x1111111111111111111111111111111111111111";
const REGISTRY = "0x4c2265470e0134C0a2df6902ebcb5397a40102a8";
const STUFFED = new Interface([
  "function stuffedResolveCall(bytes name, bytes data, uint64 targetChainId, address targetRegistryAddress)",
]);
const RECORDS = new Interface(["function contenthash(bytes32 node) view returns (bytes)"]);

test("publicContenthashQueryUrl: null unless both the base and a resolver are configured", () => {
  const name = subEnsName("punkpub");
  assert.equal(publicContenthashQueryUrl(name, 42161, REGISTRY, {}), null);
  assert.equal(publicContenthashQueryUrl(name, 42161, REGISTRY, { PUBLIC_API_BASE: "https://api.example" }), null);
  assert.equal(publicContenthashQueryUrl(name, 42161, REGISTRY, { ENS_GATEWAY_RESOLVER_ADDRESSES: RESOLVER }), null);
  assert.equal(
    publicContenthashQueryUrl(name, 42161, REGISTRY, { PUBLIC_API_BASE: "  ", ENS_GATEWAY_RESOLVER_ADDRESSES: RESOLVER }),
    null,
  );
});

test("publicContenthashQueryUrl: the L1Resolver's own request for the name's contenthash", () => {
  const name = subEnsName("punkpub");
  const url = publicContenthashQueryUrl(name, 42161, REGISTRY, {
    PUBLIC_API_BASE: "https://api.example/",
    ENS_GATEWAY_RESOLVER_ADDRESSES: ` ,${RESOLVER}, 0x2222222222222222222222222222222222222222`,
  });
  assert.ok(url);
  const m = /^https:\/\/api\.example\/api\/ens-gateway\/v1\/(0x[0-9a-fA-F]{40})\/(0x[0-9a-f]+)$/.exec(url);
  assert.ok(m, `unexpected shape: ${url}`);
  assert.equal(m[1], RESOLVER, "the first configured resolver is the sender");

  const [dns, inner, chainId, registry] = STUFFED.decodeFunctionData("stuffedResolveCall", m[2]);
  assert.equal(dns, dnsEncode(name));
  assert.equal(inner, RECORDS.encodeFunctionData("contenthash", [namehash(name)]));
  assert.equal(chainId, 42161n);
  assert.equal(String(registry).toLowerCase(), REGISTRY.toLowerCase());
});

test("round trip: the real gateway handler's answer to that query is what releases the knock", async () => {
  // If the query and the gateway ever drift apart, the warm-up would poll into
  // refusals and silently never knock. So the answer here comes from the real
  // handler, not a hand-built body.
  const name = subEnsName("punkpub");
  const url = publicContenthashQueryUrl(name, 42161, REGISTRY, {
    PUBLIC_API_BASE: "https://api.example",
    ENS_GATEWAY_RESOLVER_ADDRESSES: RESOLVER,
  });
  assert.ok(url);
  const [sender, data] = url.split("/").slice(-2);
  const gateway = createCcipHandler(
    {
      signerPrivateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      allowedSenders: [RESOLVER.toLowerCase()],
      chainId: 42161,
      registryAddresses: [REGISTRY.toLowerCase()],
      parentName: "woco.eth",
      ttlSeconds: 600,
    },
    { readL2: async () => ABI.encode(["bytes"], [NEW_HASH]), now: () => 1_800_000_000 },
  );

  const calls: string[] = [];
  const fn = (async (u: unknown) => {
    calls.push(String(u));
    if (String(u) !== url) return response(200);
    const out = await gateway(sender, data);
    return new Response(JSON.stringify(out.body), { status: out.status });
  }) as unknown as typeof fetch;

  // A fake clock, so a regression here fails at once instead of spinning
  // through a real five-minute window.
  let clock = 0;
  const status = await warmSubEnsWebCertWhenResolvable("punkpub", NEW_HASH, url, {
    fetch: fn,
    log: () => {},
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(status, 200);
  assert.deepEqual(calls, [url, subEnsWebUrl("punkpub")]);
});

// ---------------------------------------------------------------------------
// The other two #613 fixes, pinned at source
// ---------------------------------------------------------------------------

test("Etherna site uploads are non-deferred", () => {
  // Deferred, Etherna's node pushes a 5 MB site out in the background: 326 s to
  // open from a second node, against 171 s non-deferred (2026-09-21, #613).
  const src = sourceOf("../src/lib/etherna/upload.ts");
  const start = src.indexOf("export async function uploadCollectionToEtherna");
  assert.ok(start > 0, "uploadCollectionToEtherna not found");
  const next = src.indexOf("\nexport ", start + 10);
  const body = src.slice(start, next > 0 ? next : undefined);
  assert.match(body, /"Swarm-Deferred-Upload":\s*"false"/);
});

test("an event-page deploy whitelists its page and feed on our gateway", () => {
  // Without it our gateway refuses the organiser's own page (403), exactly as a
  // site deploy would have been refused before sites.ts whitelisted its hashes.
  const src = sourceOf("../src/routes/site.ts");
  const call = /whitelistHashes\(\s*\[\s*contentHash,\s*feedManifestHash\s*\]/.exec(src);
  assert.ok(call, "the deploy must whitelist contentHash and feedManifestHash");
  const ret = src.indexOf("data: { contentHash, feedManifestHash }");
  assert.ok(ret > 0);
  assert.ok(call.index < ret, "whitelisted before the deploy answers");
  // Fire-and-forget: a whitelist failure must not fail a deploy that has landed.
  assert.match(src.slice(call.index - 20, call.index), /void\s+$/);
  assert.match(src.slice(call.index, call.index + 200), /\.catch\(/);
});
