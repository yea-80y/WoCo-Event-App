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
import { subEnsWebUrl } from "@woco/shared";
import { warmSubEnsWebCert } from "../src/lib/sub-ens/cert-warmup.js";

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
  const start = chain.indexOf("export async function updateSubEnsContenthash");
  assert.ok(start > 0, "updateSubEnsContenthash not found");
  const next = chain.indexOf("\nexport ", start + 10);
  const body = chain.slice(start, next > 0 ? next : undefined);

  const waitIdx = body.indexOf("tx.wait(1)");
  const warmIdx = body.indexOf("warmSubEnsWebCert(label)");
  assert.ok(waitIdx > 0, "the receipt must still be awaited");
  assert.ok(warmIdx > 0, "the contenthash update must warm the name's certificate");
  assert.ok(warmIdx > waitIdx, "the warm-up must come after the receipt, never before");
});
