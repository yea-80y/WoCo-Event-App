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
import {
  ETH_LIMO_DOH_URL,
  warmSubEnsWebCert,
  warmSubEnsWebCertWhenResolvable,
} from "../src/lib/sub-ens/cert-warmup.js";
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
  assert.match(
    body.slice(warmIdx),
    /^warmSubEnsWebCertWhenResolvable\(\s*label,\s*\{\s*contenthash:\s*hexlify\(contenthash\),\s*swarmHash\s*\},\s*publicContenthashQueryUrl\(/,
  );
  // The ungated knock is what bought eth.limo's negative on 2026-09-21 (#557).
  assert.ok(!/warmSubEnsWebCert\(label\)/.test(body), "the relay must not knock ungated");
});

// ---------------------------------------------------------------------------
// Knock only once eth.limo can resolve the new pointer (#557)
// ---------------------------------------------------------------------------

const ABI = AbiCoder.defaultAbiCoder();
const QUERY_URL = "https://api.example/api/ens-gateway/v1/0x1111111111111111111111111111111111111111/0xdead";
const NEW_REF = "ab".repeat(32);
const OLD_REF = "cd".repeat(32);
const NEW = { contenthash: "0xe40101fa011b20" + NEW_REF, swarmHash: NEW_REF };
const OLD_HASH = "0xe40101fa011b20" + OLD_REF;
const HOST = subEnsWebUrl("punkpub");

/** The body the gateway answers with: `(bytes result, uint64 expires, bytes sig)`, result = `abi.encode(bytes)`. */
function gatewayBody(contenthash: string): string {
  const result = ABI.encode(["bytes"], [contenthash]);
  return JSON.stringify({ data: ABI.encode(["bytes", "uint64", "bytes"], [result, 1n, "0x" + "00".repeat(65)]) });
}

/** eth.limo's DoH answer, in the shape `dns.eth.limo` returned on 2026-09-21. */
function dohBody(ref: string | null, quoted = false): string {
  const data = ref ? (quoted ? `"dnslink=/bzz/${ref}"` : `dnslink=/bzz/${ref}`) : null;
  return JSON.stringify({
    Status: "0",
    Question: [{ name: "punkpub.woco.eth", type: 16 }],
    Answer: data ? [{ name: "punkpub.woco.eth", data, type: 16, ttl: 300 }] : [],
  });
}

type Answer = () => Response;
const gatewayServing = (hash: string): Answer => () => new Response(gatewayBody(hash), { status: 200 });
const ethLimoHolding = (ref: string | null, quoted = false): Answer => () =>
  new Response(dohBody(ref, quoted), { status: 200 });

/**
 * A fake network: the gateway query and eth.limo's DoH each answer from their
 * own list in turn (the last repeats); anything else is the name's web address,
 * answering the HEAD. Time only moves when the code sleeps, so the windows run
 * instantly.
 */
function fakeNetwork(gateway: Answer[], ethLimo: Answer[] = [ethLimoHolding(NEW_REF)]) {
  const calls: Call[] = [];
  let gw = 0;
  let doh = 0;
  let clock = 0;
  const fn = (async (url: unknown, init: unknown) => {
    const u = String(url);
    calls.push({ url: u, init: (init ?? {}) as RequestInit });
    if (u === QUERY_URL) return gateway[Math.min(gw++, gateway.length - 1)]();
    if (u.startsWith(ETH_LIMO_DOH_URL)) return ethLimo[Math.min(doh++, ethLimo.length - 1)]();
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
    ethLimoWindowMs: 6 * 60_000,
  };
  /** Each call as G (gateway), D (eth.limo DoH) or H (the knock), in order. */
  const trace = () =>
    calls.map((c) => (c.url === QUERY_URL ? "G" : c.url.startsWith(ETH_LIMO_DOH_URL) ? "D" : "H")).join("");
  return { deps, calls, trace };
}

test("gateway first, then eth.limo, then exactly one knock", async () => {
  const { deps, calls, trace } = fakeNetwork(
    [gatewayServing(OLD_HASH), gatewayServing(OLD_HASH), gatewayServing(NEW.contenthash)],
    [ethLimoHolding(null), ethLimoHolding(NEW_REF)],
  );
  const status = await warmSubEnsWebCertWhenResolvable("punkpub", NEW, QUERY_URL, { ...deps, log: () => {} });

  assert.equal(status, 200);
  // eth.limo is not asked while our gateway still says "unset": asking then is
  // how its 300 s negative gets made.
  assert.equal(trace(), "GGGDDH");
  const head = calls.at(-1)!;
  assert.equal(head.url, HOST);
  assert.equal(head.init.method, "HEAD");
  assert.equal(head.init.redirect, "manual");
});

test("eth.limo is asked by name, for TXT, as DNS JSON", async () => {
  const { deps, calls } = fakeNetwork([gatewayServing(NEW.contenthash)]);
  await warmSubEnsWebCertWhenResolvable("punkpub", NEW, QUERY_URL, { ...deps, log: () => {} });
  const doh = calls.find((c) => c.url.startsWith(ETH_LIMO_DOH_URL))!;
  const u = new URL(doh.url);
  assert.equal(u.origin + u.pathname, ETH_LIMO_DOH_URL);
  assert.equal(u.searchParams.get("name"), subEnsName("punkpub"));
  assert.equal(u.searchParams.get("type"), "TXT");
  assert.equal(new Headers(doh.init.headers).get("accept"), "application/dns-json");
});

test("the gateway never serving it: eth.limo is never asked and nothing knocks", async () => {
  const { deps, calls } = fakeNetwork([gatewayServing(OLD_HASH)]);
  const lines: string[] = [];
  const status = await warmSubEnsWebCertWhenResolvable("punkpub", NEW, QUERY_URL, {
    ...deps,
    log: (l) => lines.push(l),
  });

  assert.equal(status, null);
  assert.ok(calls.every((c) => c.url === QUERY_URL), "only the gateway may be asked");
  // Bounded: one poll at t=0 and one per interval up to the window, no more.
  assert.equal(calls.length, 5 * 60 / 15 + 1);
  assert.match(lines.at(-1) ?? "", /cert warm-up skipped .*public gateway did not serve/);
});

test("eth.limo never resolving it: no knock, and the wait is bounded", async () => {
  const { deps, calls, trace } = fakeNetwork([gatewayServing(NEW.contenthash)], [ethLimoHolding(OLD_REF)]);
  const lines: string[] = [];
  const status = await warmSubEnsWebCertWhenResolvable("punkpub", NEW, QUERY_URL, {
    ...deps,
    log: (l) => lines.push(l),
  });

  assert.equal(status, null);
  assert.ok(!trace().includes("H"), "a knock now spends an ask to cache the negative");
  assert.equal(calls.filter((c) => c.url.startsWith(ETH_LIMO_DOH_URL)).length, 6 * 60 / 15 + 1);
  assert.match(lines.at(-1) ?? "", /cert warm-up skipped .*eth\.limo did not resolve/);
});

test("the matches ignore hex case and a 0x on the reference, and accept a quoted TXT", async () => {
  const { deps, trace } = fakeNetwork(
    [gatewayServing(NEW.contenthash)],
    [ethLimoHolding(NEW_REF.toUpperCase(), true)],
  );
  await warmSubEnsWebCertWhenResolvable(
    "punkpub",
    { contenthash: NEW.contenthash.toUpperCase().replace("0X", "0x"), swarmHash: "0x" + NEW_REF.toUpperCase() },
    QUERY_URL,
    { ...deps, log: () => {} },
  );
  assert.equal(trace(), "GDH");
});

test("errors and junk count as not yet, at both gates", async () => {
  const { deps, trace } = fakeNetwork(
    [
      () => response(502),
      () => new Response("not json", { status: 200 }),
      () => new Response(JSON.stringify({ message: "refused" }), { status: 200 }),
      () => new Response(JSON.stringify({ data: "0x1234" }), { status: 200 }),
      () => {
        throw new Error("ECONNRESET");
      },
      gatewayServing(NEW.contenthash),
    ],
    [
      () => response(503),
      () => new Response("not json", { status: 200 }),
      () => new Response(JSON.stringify({ Answer: [{ data: 42 }, { data: "dnslink=/ipfs/bafy" }] }), { status: 200 }),
      () => new Response(JSON.stringify({ Answer: [{ data: `dnslink=/bzz/${NEW_REF}/extra` }] }), { status: 200 }),
      () => {
        throw new Error("ETIMEDOUT");
      },
      ethLimoHolding(NEW_REF),
    ],
  );
  const status = await warmSubEnsWebCertWhenResolvable("punkpub", NEW, QUERY_URL, { ...deps, log: () => {} });
  assert.equal(status, 200);
  assert.equal(trace(), "GGGGGGDDDDDDH");
});

test("no public gateway URL: nothing is fetched", async () => {
  const { deps, calls } = fakeNetwork([gatewayServing(NEW.contenthash)]);
  const lines: string[] = [];
  const status = await warmSubEnsWebCertWhenResolvable("punkpub", NEW, null, {
    ...deps,
    log: (l) => lines.push(l),
  });
  assert.equal(status, null);
  assert.equal(calls.length, 0);
  assert.match(lines[0], /cert warm-up skipped .*no public gateway URL/);
});

test("the gated warm-up refuses a bad label before any request", async () => {
  const { deps, calls } = fakeNetwork([gatewayServing(NEW.contenthash)]);
  const status = await warmSubEnsWebCertWhenResolvable("evil.com/x", NEW, QUERY_URL, { ...deps, log: () => {} });
  assert.equal(status, null);
  assert.equal(calls.length, 0);
});

test("a refused handshake logs its TLS cause, so an alert reads apart from a dead network", async () => {
  const { fn } = fakeFetch(async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR" } });
  });
  const lines: string[] = [];
  await warmSubEnsWebCert("punkpub", { fetch: fn, log: (l) => lines.push(l) });
  assert.match(lines[0], /failed: fetch failed \(ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR\)$/);
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

/** An L1Resolver v2 entry carries its chain (`0x…:1`); the URL's sender is the bare address. */
test("publicContenthashQueryUrl: a chain-bound resolver entry sends its bare address", () => {
  const url = publicContenthashQueryUrl(subEnsName("punkpub"), 42161, REGISTRY, {
    PUBLIC_API_BASE: "https://api.example",
    ENS_GATEWAY_RESOLVER_ADDRESSES: `${RESOLVER}:1,0x2222222222222222222222222222222222222222`,
  });
  assert.ok(url);
  assert.match(url, new RegExp(`/api/ens-gateway/v1/${RESOLVER}/0x`));
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
    { readL2: async () => ABI.encode(["bytes"], [NEW.contenthash]), now: () => 1_800_000_000 },
  );

  const calls: string[] = [];
  const fn = (async (u: unknown) => {
    calls.push(String(u));
    if (String(u).startsWith(ETH_LIMO_DOH_URL)) return ethLimoHolding(NEW_REF)();
    if (String(u) !== url) return response(200);
    const out = await gateway(sender, data);
    return new Response(JSON.stringify(out.body), { status: out.status });
  }) as unknown as typeof fetch;

  // A fake clock, so a regression here fails at once instead of spinning
  // through a real five-minute window.
  let clock = 0;
  const status = await warmSubEnsWebCertWhenResolvable("punkpub", NEW, url, {
    fetch: fn,
    log: () => {},
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(status, 200);
  assert.equal(calls.length, 3);
  assert.equal(calls[0], url);
  assert.ok(calls[1].startsWith(ETH_LIMO_DOH_URL));
  assert.equal(calls[2], HOST);
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
  const ret = src.search(/return c\.json\(\{\s*ok: true,/);
  assert.ok(ret > 0);
  assert.ok(call.index < ret, "whitelisted before the deploy answers");
  // Fire-and-forget: a whitelist failure must not fail a deploy that has landed.
  assert.match(src.slice(call.index - 20, call.index), /void\s+$/);
  assert.match(src.slice(call.index, call.index + 200), /\.catch\(/);
});
