/**
 * Bundles checked off the page's thread (#1061 fix 3, bundle-verifier.ts; Fable
 * consult 2026-11-03). The worker runs `parseBundle` unchanged; the page checks that a
 * reply answers ITS request and falls back to parsing itself on any trouble - never
 * skipping the check, never rejecting, never answering null for its own trouble.
 *
 * MUTATION: transfer the body instead of cloning it, accept a reply for an id not
 * waiting (or twice), accept the wrong number of results, a "limited" or unknown kind,
 * or an "ok" box that is not the v2 shape, keep using a worker after it failed, reject
 * or answer null on a failure, or key results from the reply instead of the page's own
 * roots, and a case below goes red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bytesTreeRoot } from "@woco/shared/swarm/bytes-tree";
import {
  BundleVerifier,
  answerVerifyRequest,
  resultsFromReply,
  type VerifierPort,
  type VerifyRequest,
} from "../src/lib/creator/dashboard/bundle-verifier.js";
import { parseBundle } from "../src/lib/creator/dashboard/order-box.js";
import { gatewayOrderFetcher } from "../src/lib/creator/dashboard/gateway-fetcher.js";
import type { FetchResult } from "../src/lib/creator/dashboard/detail-queue.js";

const enc = new TextEncoder();
const hexOf = (s: string) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
const sealedLike = (tag: string) => ({ v: 2, enc: hexOf(tag).padEnd(2240, "0"), ct: hexOf(tag).padEnd(32, "0") });
const order = (tag: string) => {
  const bytes = enc.encode(JSON.stringify(sealedLike(tag)));
  return { bytes, root: bytesTreeRoot(bytes) };
};
/** Exactly what the proxy's encodeBundle writes. */
function bundle(items: Array<{ root: string; status: string; len?: number }>, blobs: Uint8Array[]): Uint8Array {
  const h = enc.encode(JSON.stringify({ v: 1, items }));
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
const MISSING = "11".repeat(32);
const ROOTS = [A.root, B.root, MISSING];
const BODY = () =>
  bundle(
    [
      { root: A.root, status: "ok", len: A.bytes.length },
      { root: B.root, status: "ok", len: B.bytes.length },
      { root: MISSING, status: "not-found" },
    ],
    [A.bytes, B.bytes],
  );
const flush = () => new Promise<void>((r) => setImmediate(r));

/** A fake Worker running the real worker core; `tamper` rewrites its reply. */
function fakePort(opts: { hold?: boolean; tamper?: (reply: unknown) => unknown; throwOnPost?: boolean } = {}) {
  const posted: unknown[][] = [];
  let terminated = 0;
  const held: Array<() => void> = [];
  const port: VerifierPort = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(...args: unknown[]) {
      if (opts.throwOnPost) throw new DOMException("could not be cloned", "DataCloneError");
      posted.push(args);
      // As a real port: the message is COPIED.
      const copy = structuredClone(args[0]) as VerifyRequest;
      const run = () => {
        const reply = answerVerifyRequest(copy);
        const sent = opts.tamper ? opts.tamper(structuredClone(reply)) : reply;
        if (sent !== undefined) port.onmessage?.({ data: structuredClone(sent) });
      };
      if (opts.hold) held.push(run);
      else queueMicrotask(run);
    },
    terminate: () => void terminated++,
  } as VerifierPort;
  return { port, posted, terminated: () => terminated, release: () => held.splice(0).forEach((f) => f()) };
}
function verifierWith(make: () => ReturnType<typeof fakePort>, timeoutMs?: number) {
  const made: Array<ReturnType<typeof fakePort>> = [];
  const v = new BundleVerifier(() => {
    const f = make();
    made.push(f);
    return f.port;
  }, timeoutMs);
  return { v, made };
}

test("the worker answers exactly what the page would, keyed by the page's own roots", async () => {
  const { v, made } = verifierWith(() => fakePort());
  const out = await v.parse(ROOTS, BODY());
  assert.deepEqual(out, parseBundle(ROOTS, BODY()));
  assert.deepEqual([...out!.keys()], ROOTS);
  assert.equal(made.length, 1);
  assert.equal(made[0].posted.length, 1);
});

test("the body is cloned, never transferred: the page keeps its bytes for a fallback", async () => {
  const { v, made } = verifierWith(() => fakePort());
  const body = BODY();
  const size = body.byteLength;
  await v.parse(ROOTS, body);
  assert.equal(made[0].posted[0].length, 1, "no transfer list");
  assert.equal(body.byteLength, size, "not detached");
});

test("a body that is not an answer is the worker's verdict: null, as the page would say", async () => {
  const { v } = verifierWith(() => fakePort());
  assert.equal(await v.parse([A.root], BODY()), null);
});

for (const [why, tamper] of [
  ["one result too few", (r: unknown) => ({ ...(r as object), results: (r as { results: unknown[] }).results.slice(1) })],
  ["one result too many", (r: unknown) => ({ ...(r as object), results: [...(r as { results: unknown[] }).results, { kind: "missing" }] })],
  ["a 'limited' result (it would pause the whole queue)", (r: unknown) => ({ ...(r as object), results: (r as { results: unknown[] }).results.map(() => ({ kind: "limited" })) })],
  ["an unknown kind", (r: unknown) => ({ ...(r as object), results: (r as { results: unknown[] }).results.map(() => ({ kind: "fine" })) })],
  ["an ok box that is not the v2 shape", (r: unknown) => ({ ...(r as object), results: [{ kind: "ok", box: { v: 2, enc: "e", ct: "c" } }, ...(r as { results: unknown[] }).results.slice(1)] })],
  ["an ok box carrying an extra field", (r: unknown) => ({ ...(r as object), results: [{ kind: "ok", box: { ...sealedLike("a"), name: "x" } }, ...(r as { results: unknown[] }).results.slice(1)] })],
  ["results that are not a list", (r: unknown) => ({ ...(r as object), results: "ok" })],
  ["an id it is not waiting on", (r: unknown) => ({ ...(r as object), id: 999 })],
  ["no id at all", (r: unknown) => ({ results: (r as { results: unknown }).results })],
] as const) {
  test(`a reply with ${why} is not used: the page parses, and never uses that worker again`, async () => {
    const { v, made } = verifierWith(() => fakePort({ tamper }), 200);
    const out = await v.parse(ROOTS, BODY());
    assert.deepEqual(out, parseBundle(ROOTS, BODY()), "the page's own answer");
    assert.equal(made[0].terminated(), 1);
    assert.deepEqual(await v.parse(ROOTS, BODY()), parseBundle(ROOTS, BODY()));
    assert.equal(made.length, 1, "no new worker");
    assert.equal(made[0].posted.length, 1, "nothing more sent to the old one");
  });
}

test("the same id answered twice: the second is not trusted, and the worker is dropped", async () => {
  let port!: VerifierPort;
  const v = new BundleVerifier(() => {
    port = { onmessage: null, onerror: null, onmessageerror: null, postMessage: () => {}, terminate: () => {} } as VerifierPort;
    return port;
  });
  const first = v.parse(ROOTS, BODY());
  const answer = answerVerifyRequest({ id: 1, roots: ROOTS, body: BODY() });
  port.onmessage!({ data: answer });
  assert.deepEqual(await first, parseBundle(ROOTS, BODY()));
  const onmessage = port.onmessage;
  port.onmessage!({ data: answer });
  assert.equal(port.onmessage, null, "the repeat dropped the worker");
  assert.notEqual(onmessage, null);
});

test("a worker that cannot start: the page parses, and does not try again", async () => {
  let tries = 0;
  const v = new BundleVerifier(() => {
    tries++;
    throw new Error("refused");
  });
  assert.deepEqual(await v.parse(ROOTS, BODY()), parseBundle(ROOTS, BODY()));
  assert.deepEqual(await v.parse(ROOTS, BODY()), parseBundle(ROOTS, BODY()));
  assert.equal(tries, 1);
});

test("a job the worker cannot take, an error or a message error: the page parses what was waiting", async () => {
  for (const kind of ["post", "error", "messageerror"] as const) {
    const { v, made } = verifierWith(() => fakePort({ hold: true, throwOnPost: kind === "post" }));
    const waiting = v.parse(ROOTS, BODY());
    if (kind === "error") made[0].port.onerror!(new Event("error"));
    if (kind === "messageerror") made[0].port.onmessageerror!(new Event("messageerror"));
    assert.deepEqual(await waiting, parseBundle(ROOTS, BODY()), kind);
    assert.equal(made[0].terminated(), 1, kind);
  }
});

test("a worker that stops answering is given up on; its late answer changes nothing", async () => {
  const { v, made } = verifierWith(() => fakePort({ hold: true }), 20);
  assert.deepEqual(await v.parse(ROOTS, BODY()), parseBundle(ROOTS, BODY()));
  assert.equal(made[0].terminated(), 1);
  made[0].release(); // the late reply: its handler is gone
  await flush();
  assert.deepEqual(await v.parse(ROOTS, BODY()), parseBundle(ROOTS, BODY()));
  assert.equal(made.length, 1);
});

test("dispose ends the worker; what was waiting is parsed on the page; later bundles too", async () => {
  const { v, made } = verifierWith(() => fakePort({ hold: true }));
  const waiting = v.parse(ROOTS, BODY());
  v.dispose();
  assert.deepEqual(await waiting, parseBundle(ROOTS, BODY()));
  assert.equal(made[0].terminated(), 1);
  assert.deepEqual(await v.parse(ROOTS, BODY()), parseBundle(ROOTS, BODY()));
  assert.equal(made.length, 1);
});

test("parse never rejects and never answers null for its own trouble", async () => {
  const { v } = verifierWith(() => fakePort({ tamper: () => ({ id: 1, results: [] }) }), 50);
  const out = await v.parse(ROOTS, BODY());
  assert.ok(out instanceof Map, "the page's answer, not null");
});

test("the worker core ignores anything that is not a request", () => {
  for (const junk of [null, 1, "x", {}, { id: 1, roots: "r", body: new Uint8Array(1) }, { id: 1, roots: [1], body: new Uint8Array(1) }, { id: 1, roots: [], body: [1, 2] }]) {
    assert.equal(answerVerifyRequest(junk), null, JSON.stringify(junk));
  }
});

test("resultsFromReply: null is a verdict; anything malformed is undefined", () => {
  assert.equal(resultsFromReply(ROOTS, null), null);
  assert.equal(resultsFromReply(ROOTS, undefined), undefined);
  assert.equal(resultsFromReply(ROOTS, [{ kind: "missing" }]), undefined);
  const ok = resultsFromReply([A.root], [{ kind: "ok", box: sealedLike("a"), budget: { limit: 1 } }]) as Map<string, FetchResult>;
  assert.deepEqual(ok.get(A.root), { kind: "ok", box: sealedLike("a") }, "only the fields the page expects survive");
});

test("the fetcher hands bundles to `parse` and waits for its verdict", async () => {
  const seen: string[][] = [];
  const f = gatewayOrderFetcher({
    gateway: "https://gw",
    fetchImpl: async () => new Response(BODY(), { status: 200 }),
    fetchOne: async () => ({ kind: "unavailable" }),
    parse: async (roots, body) => {
      seen.push([...roots]);
      return parseBundle(roots, body);
    },
  });
  const out = await f.fetchBatch(ROOTS);
  assert.deepEqual(seen, [ROOTS]);
  assert.equal(out.kind, "items");
  assert.equal((out as { items: Map<string, FetchResult> }).items.get(A.root)!.kind, "ok");
});

// ── wiring (source scan) ────────────────────────────────────────────────────

const SRC = (p: string) => readFileSync(new URL(`../src/lib/creator/dashboard/${p}`, import.meta.url), "utf-8");

test("the verify worker holds no keys and imports nothing that does", () => {
  const worker = SRC("bundle-verify.worker.ts");
  const verifier = SRC("bundle-verifier.ts");
  assert.deepEqual([...worker.matchAll(/from "([^"]+)"/g)].map((m) => m[1]), ["./bundle-verifier.js"]);
  assert.deepEqual(
    [...verifier.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort(),
    ["./detail-queue.js", "./order-box.js", "@woco/shared/crypto/sealed-box-shape"],
  );
  assert.doesNotMatch(worker + verifier, /keyring|order-keys|secretKey|indexedDB|localStorage/);
});

test("bundles go through the verifier; a single read is still checked on the page", () => {
  const live = SRC("browser-orders-live.ts");
  assert.match(live, /parse: \(roots, body\) => verifier\.parse\(roots, body\),/);
  assert.match(live, /^import bundleVerifyWorkerUrl from "\.\/bundle-verify\.worker\.ts\?worker&url";$/m);
  assert.match(live, /return startModuleWorker\(bundleVerifyWorkerUrl\) as unknown as VerifierPort;/);
  assert.match(live, /return \{ \.\.\.boxFromBytes\(root, bytes\), budget \};/);
});

test("the dashboard ends the verifier when the page goes, or moves to another event", () => {
  const dash = SRC("Dashboard.svelte");
  assert.match(dash, /browserOrders\?\.queue\.stop\(\);\s*browserOrders\?\.verifier\.dispose\(\);\s*\/\/[^\n]*\n\s*const verifier = liveBundleVerifier\(\);/);
  assert.match(dash, /rebuildTimer = null;\s*browserOrders\?\.verifier\.dispose\(\);\s*\}\);/);
  assert.match(dash, /\.\.\.liveGatewayFetcher\(verifier\),/);
});
