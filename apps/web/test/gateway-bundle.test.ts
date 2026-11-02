/**
 * The bundled read, client side (#965): the strict parser for POST /bytes-bundle
 * (order-box.ts `parseBundle`) and the fetcher's fallback rules
 * (gateway-fetcher.ts).
 *
 * The rules: a body is used only if it answers exactly the roots asked, in order,
 * with every blob accounted for - else nothing in it is used; each "ok" blob must
 * still hash to its root; a gateway without the endpoint (404/405, or a body that
 * is not a bundle) drops the page to one read per root without losing any; one
 * whose bundles keep failing before any worked does too; 429 is a pause, never a
 * fallback.
 *
 * MUTATION: accept items out of order, an extra or missing item, trailing bytes,
 * a `len` on a refused item, an unknown status or version; skip the per-blob hash;
 * fall back on a 5xx before the give-up count or after a bundle worked; treat 429
 * as unsupported; send without no-store; and a case below goes red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesTreeRoot } from "@woco/shared/swarm/bytes-tree";
import { BUNDLE_MAX_ROOTS, bundleBodyLimit, parseBundle } from "../src/lib/creator/dashboard/order-box.js";
import { BUNDLE_GIVE_UP, gatewayOrderFetcher } from "../src/lib/creator/dashboard/gateway-fetcher.js";
import type { FetchResult } from "../src/lib/creator/dashboard/detail-queue.js";

const enc = new TextEncoder();
const order = (tag: string) => {
  const bytes = enc.encode(JSON.stringify({ v: 2, enc: `enc-${tag}`, ct: `ct-${tag}` }));
  return { bytes, root: bytesTreeRoot(bytes) };
};
type Item = { root: string; status: string; len?: number };
/** Exactly what the proxy's encodeBundle writes. */
function bundle(items: Item[], blobs: Uint8Array[], header: Record<string, unknown> = {}): Uint8Array {
  const h = enc.encode(JSON.stringify({ v: 1, items, ...header }));
  const out = new Uint8Array(4 + h.length + blobs.reduce((n, b) => n + b.length, 0));
  new DataView(out.buffer).setUint32(0, h.length);
  out.set(h, 4);
  let off = 4 + h.length;
  for (const b of blobs) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

const A = order("a");
const B = order("b");
const C = order("c");

test("parse: every status maps onto the queue's rules; ok blobs open", () => {
  const roots = [A.root, B.root, "11".repeat(32), "22".repeat(32), "33".repeat(32)];
  const body = bundle(
    [
      { root: A.root, status: "ok", len: A.bytes.length },
      { root: B.root, status: "ok", len: B.bytes.length },
      { root: roots[2], status: "not-found" },
      { root: roots[3], status: "not-whitelisted" },
      { root: roots[4], status: "too-large" },
    ],
    [A.bytes, B.bytes],
  );
  const out = parseBundle(roots, body)!;
  assert.deepEqual([...out.values()].map((r) => r.kind), ["ok", "ok", "missing", "unavailable", "unreadable"]);
  assert.deepEqual((out.get(A.root) as { box: unknown }).box, { v: 2, enc: "enc-a", ct: "ct-a" });
});

test("parse: a blob under another root is refused for that root only (and retried)", () => {
  const body = bundle([{ root: A.root, status: "ok", len: B.bytes.length }, { root: C.root, status: "ok", len: C.bytes.length }], [B.bytes, C.bytes]);
  const out = parseBundle([A.root, C.root], body)!;
  assert.equal(out.get(A.root)!.kind, "unavailable");
  assert.equal(out.get(C.root)!.kind, "ok");
});

test("parse: anything that is not exactly an answer to what was asked is used not at all", () => {
  const ok = (o: typeof A): Item => ({ root: o.root, status: "ok", len: o.bytes.length });
  const roots = [A.root, B.root];
  const cases: Array<[string, Uint8Array]> = [
    ["out of order", bundle([ok(B), ok(A)], [B.bytes, A.bytes])],
    ["missing item", bundle([ok(A)], [A.bytes])],
    ["extra item", bundle([ok(A), ok(B), ok(C)], [A.bytes, B.bytes, C.bytes])],
    ["trailing bytes", bundle([ok(A), ok(B)], [A.bytes, B.bytes, enc.encode("x")])],
    ["short blob", bundle([ok(A), { ...ok(B), len: B.bytes.length + 5 }], [A.bytes, B.bytes])],
    ["len on a refusal", bundle([ok(A), { root: B.root, status: "not-found", len: 0 }], [A.bytes])],
    ["unknown status", bundle([ok(A), { root: B.root, status: "maybe" }], [A.bytes])],
    ["wrong version", bundle([ok(A), ok(B)], [A.bytes, B.bytes], { v: 2 })],
    ["not a bundle", enc.encode("<html>Cannot POST</html>")],
    ["too short", new Uint8Array(3)],
  ];
  for (const [name, body] of cases) assert.equal(parseBundle(roots, body), null, name);
});

test("parse: the body limit fits a full bundle of the largest orders", () => {
  assert.ok(bundleBodyLimit(BUNDLE_MAX_ROOTS) > BUNDLE_MAX_ROOTS * 16 * 1024);
});

// ── the fetcher ─────────────────────────────────────────────────────────────

type Call = { url: string; init: RequestInit };
function fetcher(respond: (call: Call, n: number) => Response | Promise<Response>, one: (root: string) => FetchResult = () => ({ kind: "missing" })) {
  const calls: Call[] = [];
  const singles: string[] = [];
  const f = gatewayOrderFetcher({
    gateway: "https://gw.example",
    fetchImpl: (async (url: string, init: RequestInit) => {
      const call = { url, init };
      calls.push(call);
      return respond(call, calls.length);
    }) as unknown as typeof fetch,
    fetchOne: async (root) => {
      singles.push(root);
      return one(root);
    },
    now: () => 0,
  });
  return { f, calls, singles };
}
const okBundle = (roots: typeof A[]) =>
  new Response(bundle(roots.map((o) => ({ root: o.root, status: "ok", len: o.bytes.length })), roots.map((o) => o.bytes)) as unknown as BodyInit);

test("a bundle is one POST, never stored, and its items come back per root", async () => {
  const { f, calls } = fetcher(() => okBundle([A, B]));
  assert.equal(f.maxBatch(), BUNDLE_MAX_ROOTS);
  const out = await f.fetchBatch([A.root, B.root]);
  assert.equal(out.kind, "items");
  assert.equal(calls[0].url, "https://gw.example/bytes-bundle");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.cache, "no-store");
  assert.deepEqual(JSON.parse(calls[0].init.body as string), { v: 1, roots: [A.root, B.root] });
});

test("no endpoint (404 or 405): unsupported, then one GET per root; a bundle already sent comes back", async () => {
  for (const status of [404, 405]) {
    const { f, calls, singles } = fetcher(() => new Response("Cannot POST", { status }));
    assert.deepEqual(await f.fetchBatch([A.root, B.root]), { kind: "unsupported" });
    assert.equal(f.maxBatch(), 1);
    assert.deepEqual(await f.fetchBatch([A.root, B.root]), { kind: "unsupported" }, "a bundle formed before the switch");
    const one = await f.fetchBatch([A.root]);
    assert.equal(one.kind, "items");
    assert.deepEqual(singles, [A.root]);
    assert.equal(calls.length, 1, "no second probe on this page");
  }
});

test("a 200 that is not a bundle (an old proxy's fallback page, a CDN) means unsupported", async () => {
  const { f } = fetcher(() => new Response("<html></html>"));
  assert.deepEqual(await f.fetchBatch([A.root]), { kind: "unsupported" });
  assert.equal(f.maxBatch(), 1);
});

test("a body declaring more than a bundle can be is refused unread", async () => {
  const { f } = fetcher(() => new Response("x", { headers: { "content-length": String(bundleBodyLimit(1) + 1) } }));
  assert.deepEqual(await f.fetchBatch([A.root]), { kind: "unsupported" });
});

test("bundles failing before any worked: retried, then one at a time after the give-up count", async () => {
  const { f } = fetcher(() => new Response("bad gateway", { status: 502 }));
  for (let i = 1; i < BUNDLE_GIVE_UP; i++) {
    assert.equal((await f.fetchBatch([A.root])).kind, "unavailable");
    assert.equal(f.maxBatch(), BUNDLE_MAX_ROOTS, `still bundling after ${i}`);
  }
  assert.equal((await f.fetchBatch([A.root])).kind, "unavailable");
  assert.equal(f.maxBatch(), 1);
});

test("once a bundle has worked, failures never drop the page to single reads", async () => {
  const { f } = fetcher((_c, n) => (n === 1 ? okBundle([A]) : Promise.reject(new Error("offline"))));
  await f.fetchBatch([A.root]);
  for (let i = 0; i < BUNDLE_GIVE_UP + 2; i++) assert.equal((await f.fetchBatch([A.root])).kind, "unavailable");
  assert.equal(f.maxBatch(), BUNDLE_MAX_ROOTS);
});

test("429 is a pause with the gateway's wait and budget, never a fallback", async () => {
  const { f } = fetcher(
    () => new Response("slow down", { status: 429, headers: { "retry-after": "7", "ratelimit-limit": "120", "ratelimit-remaining": "0", "ratelimit-reset": "30" } }),
  );
  const out = await f.fetchBatch([A.root]);
  assert.deepEqual(out, { kind: "limited", retryAfterMs: 7_000, budget: { limit: 120, remaining: 0, resetMs: 30_000 } });
  assert.equal(f.maxBatch(), BUNDLE_MAX_ROOTS);
});

test("single reads pass a 429 through as a pause", async () => {
  const { f } = fetcher(
    () => new Response("", { status: 404 }),
    () => ({ kind: "limited", retryAfterMs: 2_000 }),
  );
  await f.fetchBatch([A.root, B.root]);
  assert.deepEqual(await f.fetchBatch([A.root]), { kind: "limited", retryAfterMs: 2_000, budget: undefined });
});
