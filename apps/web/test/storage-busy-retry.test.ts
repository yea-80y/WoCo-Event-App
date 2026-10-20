/**
 * A new site's first save can be refused for about a minute (#943, server
 * `STORAGE_BUSY` with `retryAfterMs`). The builder says so and sends the same
 * request ONCE more after the wait, by itself; a screen that goes away sends
 * nothing more. Only the server request is repeated - never the signing before it.
 */

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ApiResponse } from "@woco/shared";
import {
  __storageBusyTestHooks,
  isStorageBusy,
  retryOnceIfStorageBusy,
  storageBusyWaitMs,
} from "../src/lib/api/storage-busy.js";

const BUSY = { ok: false, error: "Storage needs about a minute", code: "STORAGE_BUSY", retryAfterMs: 65_000, status: 503 };
const waits: number[] = [];

beforeEach(() => {
  waits.length = 0;
  __storageBusyTestHooks.setSleep(async (ms, signal) => {
    waits.push(ms);
    if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
  });
});
after(() => __storageBusyTestHooks.setSleep(null));

function replies(...answers: ApiResponse<unknown>[]) {
  let sent = 0;
  const send = async () => answers[Math.min(sent++, answers.length - 1)]!;
  return { send, sent: () => sent };
}

test("busy, then ok: told the wait, waits the server's retryAfterMs, sends once more", async () => {
  const r = replies(BUSY, { ok: true, data: { siteId: "s" } });
  const told: number[] = [];
  const res = await retryOnceIfStorageBusy(r.send, { onWait: (ms) => told.push(ms) });
  assert.deepEqual(res, { ok: true, data: { siteId: "s" } });
  assert.equal(r.sent(), 2);
  assert.deepEqual(waits, [65_000]);
  assert.deepEqual(told, [65_000]);
});

test("busy twice: the second answer is returned for the caller to show - one retry only", async () => {
  const r = replies(BUSY, BUSY, { ok: true });
  const res = await retryOnceIfStorageBusy(r.send);
  assert.equal(r.sent(), 2);
  assert.equal(res.code, "STORAGE_BUSY");
});

test("success and every other refusal are returned as they are, with no wait", async () => {
  for (const answer of [
    { ok: true },
    { ok: false, error: "Not the site owner", status: 403 },
    { ok: false, error: "Could not verify site ownership right now", status: 503 },
    { ok: false, error: "Storage is temporarily unavailable", code: "STORAGE_UNAVAILABLE", status: 503 },
  ]) {
    const r = replies(answer);
    assert.deepEqual(await retryOnceIfStorageBusy(r.send), answer);
    assert.equal(r.sent(), 1);
  }
  assert.deepEqual(waits, []);
});

test("the screen went away during the wait: nothing more is sent", async () => {
  const r = replies(BUSY, { ok: true });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(retryOnceIfStorageBusy(r.send, { signal: abort.signal }), { name: "AbortError" });
  assert.equal(r.sent(), 1);
});

test("the real wait is cancelled by the signal, not run out", async () => {
  __storageBusyTestHooks.setSleep(null);
  const r = replies({ ...BUSY, retryAfterMs: 60_000 }, { ok: true });
  const abort = new AbortController();
  const started = Date.now();
  const pending = retryOnceIfStorageBusy(r.send, { signal: abort.signal, onWait: () => setTimeout(() => abort.abort(), 20) });
  await assert.rejects(pending, { name: "AbortError" });
  assert.ok(Date.now() - started < 5_000);
  assert.equal(r.sent(), 1);
});

test("the wait is the server's, bounded; a missing one is the default", () => {
  assert.equal(storageBusyWaitMs({ retryAfterMs: 65_000 }), 65_000);
  assert.equal(storageBusyWaitMs({}), 65_000);
  assert.equal(storageBusyWaitMs({ retryAfterMs: "soon" }), 65_000);
  assert.equal(storageBusyWaitMs({ retryAfterMs: 5 }), 1_000);
  assert.equal(storageBusyWaitMs({ retryAfterMs: 10 * 60_000 }), 120_000);
  assert.equal(isStorageBusy(BUSY), true);
  assert.equal(isStorageBusy({ ok: true, code: "STORAGE_BUSY" }), false);
});

// ---------------------------------------------------------------------------
// Wiring, pinned at source: running these means a live publish.
// ---------------------------------------------------------------------------

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf-8");
function fn(file: string, name: string): string {
  const s = src(file);
  const start = s.indexOf(`export async function ${name}(`);
  assert.ok(start > 0, `${name} not found`);
  const next = s.indexOf("\nexport ", start + 10);
  return s.slice(start, next > 0 ? next : undefined);
}

test("publishSite repeats the server request only - the config SOC is signed once, before it", () => {
  const b = fn("../src/lib/api/sites.ts", "publishSite");
  const signs = b.indexOf("await writeContentFeed(");
  const retried = b.indexOf("retryOnceIfStorageBusy(");
  assert.ok(signs > 0 && retried > signs);
  assert.equal(b.match(/retryOnceIfStorageBusy\(\s*\(\) => authPost/g)?.length, 2, "both publish paths, the POST alone");
  assert.ok(!/retryOnceIfStorageBusy\([^;]*writeContentFeed/s.test(b));
});

test("deploySite and deployEventPage retry the deploy request, then sign what it answered", () => {
  for (const name of ["deploySite", "deployEventPage"]) {
    const b = fn("../src/lib/api/sites.ts", name);
    const retried = b.indexOf("retryOnceIfStorageBusy(");
    const sign = b.indexOf("signAndUploadSoc(");
    assert.ok(retried > 0 && sign > retried, name);
    assert.match(b, /retryOnceIfStorageBusy\(\s*\(\) =>\s*authPost/, name);
  }
});

test("the builders say what is happening, and cancel the wait when they go away", () => {
  const site = src("../src/lib/creator/builder/MultiSiteBuilder.svelte");
  assert.match(site, /Saving your site… \(this can take about a minute the first time\)/);
  assert.match(site, /onDestroy\(\(\) => publishAbort\?\.abort\(\)\)/);
  assert.match(site, /await publishSite\(.*, feedSigner, gatewayUrl, retry\);/);
  assert.match(site, /await deploySite\(.*, feedSigner, retry\);/);
  const page = src("../src/lib/creator/SiteBuilder.svelte");
  assert.match(page, /onDestroy\(\(\) => deployAbort\?\.abort\(\)\)/);
  assert.match(page, /signal: abort\.signal/);
});
