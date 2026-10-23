/**
 * A log line when a health check turns red and when it turns green (2026-10-22:
 * a 10-minute page that no log could name). Leaves only, one line per change,
 * never one per minute while a check stays red.
 *
 * MUTATION: log every red path (not only leaves), log on every call, or drop the
 * green line, and a case below goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createAlarmLog, redLeaves } from "../src/lib/health/alarm-log.js";

function report(over: { provenance?: boolean; ttl?: boolean; util?: boolean } = {}) {
  const ttl = over.ttl ?? true;
  const util = over.util ?? true;
  return {
    ok: true,
    checkoutProvenance: { ok: over.provenance ?? true, stuck: over.provenance === false ? 2 : 0 },
    postage: {
      ok: ttl && util,
      bee: { ok: ttl && util, checks: { ttl: { ok: ttl }, utilization: { ok: util } } },
    },
    paymaster: { ok: null },
  };
}

test("only the checks themselves are named, never the sections above them", () => {
  assert.deepEqual(redLeaves(report({ ttl: false, util: false })), [
    "postage.bee.checks.ttl",
    "postage.bee.checks.utilization",
  ]);
  assert.deepEqual(redLeaves(report({ provenance: false })), ["checkoutProvenance"]);
  assert.deepEqual(redLeaves(report()), []);
});

test("the first call logs where things stand", () => {
  const lines: string[] = [];
  createAlarmLog((l) => lines.push(l))(report({ ttl: false }), 0);
  assert.deepEqual(lines, ["[alarm] red at start: postage.bee.checks.ttl"]);

  const green: string[] = [];
  createAlarmLog((l) => green.push(l))(report(), 0);
  assert.deepEqual(green, ["[alarm] all green at start"]);
});

test("a check turning red logs once, and turning green logs how long it was red", () => {
  const lines: string[] = [];
  const note = createAlarmLog((l) => lines.push(l));
  note(report(), 0);
  note(report({ provenance: false }), 60_000);
  note(report({ provenance: false }), 120_000);
  note(report({ provenance: false }), 180_000);
  note(report(), 12 * 60_000);
  assert.deepEqual(lines, [
    "[alarm] all green at start",
    "[alarm] RED checkoutProvenance",
    "[alarm] GREEN checkoutProvenance after 11 min",
  ]);
});

test("a check already red at start still logs when it clears", () => {
  const lines: string[] = [];
  const note = createAlarmLog((l) => lines.push(l));
  note(report({ util: false }), 0);
  note(report(), 5 * 60_000);
  assert.deepEqual(lines, [
    "[alarm] red at start: postage.bee.checks.utilization",
    "[alarm] GREEN postage.bee.checks.utilization after 5 min",
  ]);
});

test("an unreadable probe (ok: null) is never logged", () => {
  const lines: string[] = [];
  const note = createAlarmLog((l) => lines.push(l));
  note(report(), 0);
  note({ ...report(), paymaster: { ok: null } }, 60_000);
  assert.deepEqual(lines, ["[alarm] all green at start"]);
});

test("the server feeds the watcher the same report the monitor reads", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(src, /noteAlarms\(healthReport\(\)\)/);
  assert.match(src, /setInterval\(watchAlarms, 60_000\)/);
});
