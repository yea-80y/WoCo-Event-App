/**
 * `/api/health` `signInWindow` (lib/health/sign-in-window.ts): the two eth.limo
 * headers that decide whether the app can still open the passkey window and hear
 * it answer.
 *
 * MUTATIONS (each turns this file red):
 *  - let a COOP other than unsafe-none pass -> "a COOP that severs the opener is red";
 *  - drop the parameter split -> "unsafe-none with a report-to is not a change";
 *  - accept any X-Frame-Options, or an absent one -> "an X-Frame-Options change is red";
 *  - check only the first copy of a repeated header -> "every copy must say SAMEORIGIN";
 *  - let a non-2xx through -> "a host that does not answer 2xx is red";
 *  - turn an unreachable host into red or green -> "an unreachable host is unknown";
 *  - probe a different or a single origin -> "both origins are probed";
 *  - drop the section or its probe from index.ts -> the wiring test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SIGN_IN_WINDOW_PROBE_INTERVAL_MS,
  __resetSignInWindowHealth,
  evaluateOrigin,
  evaluateSignInWindow,
  probeSignInWindow,
  refreshSignInWindowHealth,
  signInWindowHealth,
  type HeaderRead,
} from "../src/lib/health/sign-in-window.js";
import { alarmGate } from "../src/lib/health/alarm-gate.js";

const today: HeaderRead = { ok: true, status: 200, coop: null, xfo: "SAMEORIGIN" };

test("today's headers are green", () => {
  assert.deepEqual(evaluateOrigin(today), { ok: true });
  assert.deepEqual(evaluateOrigin({ ...today, xfo: "sameorigin" }), { ok: true });
});

test("a COOP that severs the opener is red", () => {
  for (const coop of ["same-origin", "same-origin-allow-popups", "noopener-allow-popups", "Same-Origin"]) {
    const v = evaluateOrigin({ ...today, coop });
    assert.equal(v.ok, false, coop);
    assert.match(v.reason!, /loses its opener/);
  }
});

test("unsafe-none, with or without a report-to, is not a change", () => {
  assert.deepEqual(evaluateOrigin({ ...today, coop: "unsafe-none" }), { ok: true });
  assert.deepEqual(evaluateOrigin({ ...today, coop: "unsafe-none; report-to=\"coop\"" }), { ok: true });
});

test("an X-Frame-Options change is red, absent included", () => {
  for (const xfo of ["DENY", "ALLOW-FROM https://x.example", null]) {
    const v = evaluateOrigin({ ...today, xfo });
    assert.equal(v.ok, false, String(xfo));
    assert.match(v.reason!, /X-Frame-Options changed from SAMEORIGIN/);
  }
});

test("every copy of a repeated X-Frame-Options must say SAMEORIGIN", () => {
  assert.deepEqual(evaluateOrigin({ ...today, xfo: "SAMEORIGIN, SAMEORIGIN" }), { ok: true });
  assert.equal(evaluateOrigin({ ...today, xfo: "SAMEORIGIN, DENY" }).ok, false);
});

test("a host that does not answer 2xx is red", () => {
  for (const status of [404, 500, 502]) {
    assert.deepEqual(evaluateOrigin({ ...today, status }), { ok: false, reason: `answered HTTP ${status}` });
  }
});

test("an unreachable host is unknown, never red or green", () => {
  assert.deepEqual(evaluateOrigin({ ok: false, reason: "timed out" }), { ok: null, reason: "could not be read: timed out" });
});

test("both origins are probed, opener first, and a throwing read is unknown", async () => {
  const asked: string[] = [];
  const r = await probeSignInWindow(async (origin) => {
    asked.push(origin);
    if (origin.includes("auth.")) throw new Error("boom");
    return today;
  }, () => 1_000);
  assert.deepEqual(asked, ["https://woco.eth.limo", "https://auth.woco.eth.limo"]);
  assert.equal(r.at, 1_000);
  assert.deepEqual(r.origins[1]!.read, { ok: false, reason: "unreadable" });
  assert.equal(evaluateSignInWindow(r).ok, null);
});

test("the section is red when either host is, and names the host", () => {
  const reading = {
    at: 0,
    origins: [
      { origin: "https://woco.eth.limo", read: today },
      { origin: "https://auth.woco.eth.limo", read: { ...today, coop: "same-origin" } },
    ],
  };
  const v = evaluateSignInWindow(reading);
  assert.equal(v.ok, false);
  assert.match(v.reason!, /^auth\.woco\.eth\.limo sends Cross-Origin-Opener-Policy: same-origin/);
  assert.deepEqual(evaluateSignInWindow({ ...reading, origins: [reading.origins[0]!, reading.origins[0]!] }), { ok: true });
  assert.deepEqual(evaluateSignInWindow(null), { ok: null, reason: "not checked yet" });
});

test("the section reports each host's headers and goes stale when the probe stops", async () => {
  __resetSignInWindowHealth();
  const lines: string[] = [];
  await refreshSignInWindowHealth(async (origin) => (origin.includes("auth.") ? { ...today, status: 404 } : today), (l) => lines.push(l));
  const now = Date.now();
  const s = signInWindowHealth(now);
  assert.equal(s.ok, false);
  assert.equal(s.stale, false);
  assert.deepEqual(s.origins.map((o) => [o.origin, o.ok, o.status, o.xFrameOptions]), [
    ["https://woco.eth.limo", true, 200, "SAMEORIGIN"],
    ["https://auth.woco.eth.limo", false, 404, "SAMEORIGIN"],
  ]);
  assert.equal(signInWindowHealth(now + SIGN_IN_WINDOW_PROBE_INTERVAL_MS * 3).stale, true);
  assert.deepEqual(lines, ["[health] signInWindow: ALARM - auth.woco.eth.limo answered HTTP 404"]);
  await refreshSignInWindowHealth(async () => today, (l) => lines.push(l));
  await refreshSignInWindowHealth(async () => today, (l) => lines.push(l));
  assert.equal(lines.length, 2, "one line per crossing");
  __resetSignInWindowHealth();
});

test("a red section pages /api/health/alarms, and the server wires it in", () => {
  const report = { ok: true, signInWindow: { ok: false, origins: [{ origin: "https://auth.woco.eth.limo", ok: false }] } };
  assert.equal(alarmGate(report, undefined).status, 503);
  assert.equal(alarmGate(report, "signInWindow").status, 503);
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(index, /\n {4}signInWindow: signInWindowHealth\(\),\n/);
  assert.match(index, /\nstartSignInWindowProbe\(\);\n/);
});
