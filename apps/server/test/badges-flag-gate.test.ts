/**
 * Badges, drops and badge-gated ticket sales are OFF for launch
 * (FEATURES.badgesAllowed). The client hides the entry points; these are the
 * server halves, which an old client or a direct API call meets instead.
 *
 * The flag is read at request time and not mocked: the claim is what this build
 * serves, not the gate's shape.
 *
 * MUTATION: delete `badgeGate` from the POST route, or the gated-series check in
 * createEventV2, and a case below goes red; flip the flag to true and they all do.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EMAIL_HASH_SECRET = "test-secret-badges-gate";

let app: import("hono").Hono;
let FEATURES: typeof import("@woco/shared").FEATURES;
let createEventV2: typeof import("../src/lib/event/service.js").createEventV2;

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-badges-gate-test-")));
  const { Hono } = await import("hono");
  const { objectsRouter } = await import("../src/routes/objects.js");
  ({ createEventV2 } = await import("../src/lib/event/service.js"));
  ({ FEATURES } = await import("@woco/shared"));
  app = new Hono();
  app.route("/api/objects", objectsRouter);
});

test("the flag is off for launch", () => {
  assert.equal(FEATURES.badgesAllowed, false);
});

test("POST /api/objects answers 'off' before auth, never 401", async () => {
  const res = await app.request("/api/objects", {
    method: "POST",
    body: JSON.stringify({ kind: "badge" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { ok: boolean; error?: string };
  assert.equal(body.ok, false);
  assert.equal(body.error, "Badges and collectibles are not available yet");
});

test("the Objects tab's own reads are NOT gated - it still lists tickets", async () => {
  // Unauthenticated, so requireAuth answers. Anything but the badge gate's 403
  // proves the gate is scoped to creation.
  const res = await app.request("/api/objects/mine");
  assert.notEqual(res.status, 403);
});

function createWith(series: unknown[]) {
  return createEventV2({
    eventId: "e1",
    title: "T",
    startDate: "2026-10-01T18:00:00Z",
    creatorAddress: "0x" + "11".repeat(20),
    imageData: "",
    series,
  } as unknown as Parameters<typeof createEventV2>[0]);
}

test("event create refuses a badge-gated series before choosing storage or reading chain", async () => {
  const gate = { mode: "any", gates: [] };
  await assert.rejects(
    createWith([{ seriesId: "s-open-0001", totalSupply: 1 }, { seriesId: "s-gated-0001", totalSupply: 1, gate }]),
    /Series s-gated-0001: badge-gated tickets are not available yet/,
  );
});

test("an ungated event gets past the badge check", async () => {
  // It fails later, on its own missing storage config - which it only reaches
  // once the badge check has let it through.
  const saved = process.env.ETHERNA_PLATFORM_BATCH;
  delete process.env.ETHERNA_PLATFORM_BATCH;
  try {
    await assert.rejects(
      createWith([{ seriesId: "s-open-0001", totalSupply: 1 }]),
      (err: Error) => !/badge-gated/.test(err.message),
    );
  } finally {
    if (saved !== undefined) process.env.ETHERNA_PLATFORM_BATCH = saved;
  }
});
