/**
 * `/api/health/alarms` (#672): the health report as one status code, so an
 * uptime monitor can page on it. `/api/health` always answers 200, so before
 * this no alarm on it reached anyone. Each rule is pinned on its own.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { alarmGate } from "../src/lib/health/alarm-gate.js";

/** Shaped like the live report on 2026-09-25: two known reds, one unknown. */
function report() {
  return {
    ok: true,
    build: { commit: "057e1d1c", clean: true },
    checkoutProvenance: { ok: true, foreign: 0, stuck: 0 },
    ticketMinting: {
      ok: true,
      checks: { sponsorAuthorised: { ok: true }, mintAllowance: { ok: true }, mintRamp: { ok: true } },
    },
    postage: { ok: false, etherna: { ok: false, checks: { ttl: { ok: false, reason: "expires in 3.8d" } } } },
    subEns: { parent: { ok: false, daysRemaining: 111 }, minting: { ok: true } },
    paymaster: { ok: null },
    ensGateway: { resolvers: [{ address: "0xd9", boundChainId: 1 }, { address: "0x17", boundChainId: null }] },
  };
}

const withRed = (mut: (r: ReturnType<typeof report>) => void) => {
  const r = report();
  mut(r);
  return r;
};

test("everything watched: any ok:false anywhere is a 503 that names its path", () => {
  const { status, body } = alarmGate(report(), undefined);
  assert.equal(status, 503);
  assert.deepEqual(body, {
    ok: false,
    watched: "all",
    red: ["postage", "postage.etherna", "postage.etherna.checks.ttl", "subEns.parent"],
    unknown: ["paymaster"],
  });
});

test("an unreadable probe (ok:null) is listed but never pages", () => {
  const { status, body } = alarmGate(report(), "paymaster,checkoutProvenance");
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, watched: ["paymaster", "checkoutProvenance"], red: [], unknown: ["paymaster"] });
});

test("the report's own top-level ok is a constant, not a verdict", () => {
  const r = { ok: false, ticketMinting: { ok: true } };
  assert.equal(alarmGate(r, undefined).status, 200);
});

test("watching chosen sections leaves a known, accepted red out", () => {
  const picks = "ticketMinting,checkoutProvenance,subEns.minting";
  assert.equal(alarmGate(report(), picks).status, 200);
  const red = withRed((r) => (r.ticketMinting.checks.mintRamp.ok = false));
  const { status, body } = alarmGate(red, picks);
  assert.equal(status, 503);
  assert.deepEqual((body as { red: string[] }).red, ["ticketMinting.checks.mintRamp"]);
});

test("a red nested below a green section still pages", () => {
  const red = withRed((r) => (r.subEns.minting.ok = false));
  assert.equal(alarmGate(red, "subEns.minting").status, 503);
  // ...and a green parent does not hide a red child when the parent is picked.
  assert.equal(alarmGate(withRed((r) => (r.ticketMinting.checks.sponsorAuthorised.ok = false)), "ticketMinting").status, 503);
});

test("arrays are walked, so a red inside a list is found", () => {
  const r = { ok: true, list: { items: [{ ok: true }, { ok: false }] } };
  assert.deepEqual((alarmGate(r, "list").body as { red: string[] }).red, ["list.items.1"]);
});

test("overlapping picks report each red once", () => {
  const { body } = alarmGate(report(), "subEns,subEns.parent");
  assert.deepEqual((body as { red: string[] }).red, ["subEns.parent"]);
});

test("a section that does not exist is a 400, never an empty watch that is always green", () => {
  for (const bad of ["ticketminting", "subEns.nope", "build.commit"]) {
    const { status, body } = alarmGate(report(), bad);
    assert.equal(status, 400, bad);
    assert.equal(body.ok, false, bad);
  }
});

test("names outside [A-Za-z0-9_] and the top-level ok are refused, and bad input is not echoed", () => {
  for (const bad of ["<script>", "ticketMinting..checks", "a b", "ok"]) {
    const { status, body } = alarmGate(report(), bad);
    assert.equal(status, 400, bad);
    assert.doesNotMatch((body as { error: string }).error, /script/, bad);
  }
});

test("inherited keys never resolve as sections", () => {
  for (const bad of ["constructor", "toString", "subEns.hasOwnProperty", "__proto__", "__proto__.x"]) {
    assert.equal(alarmGate(report(), bad).status, 400, bad);
  }
});

test("the number of picks is bounded", () => {
  const many = Array.from({ length: 51 }, () => "ticketMinting").join(",");
  assert.equal(alarmGate(report(), many).status, 400);
  const fifty = Array.from({ length: 50 }, () => "ticketMinting").join(",");
  assert.equal(alarmGate(report(), fifty).status, 200);
});

test("empty picks and stray commas mean 'watch everything'", () => {
  assert.equal((alarmGate(report(), "").body as { watched: unknown }).watched, "all");
  assert.equal((alarmGate(report(), " , ").body as { watched: unknown }).watched, "all");
});

// ── Wiring (text checks: importing index.ts starts the server) ────────────────

test("/api/health and /api/health/alarms serve the same report", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
  assert.match(src, /app\.get\("\/api\/health", \(c\) => c\.json\(healthReport\(\)\)\);/);
  const route = src.slice(src.indexOf('app.get("/api/health/alarms"'));
  assert.ok(route.length > 0, "the alarms route is missing");
  const body = route.slice(0, route.indexOf("});"));
  assert.match(body, /alarmGate\(healthReport\(\), c\.req\.query\("sections"\)\)/);
  assert.match(body, /no-store/);
  assert.match(body, /c\.json\(body, status\)/);
});
