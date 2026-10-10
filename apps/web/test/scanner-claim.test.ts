/**
 * The scanner's claim client (#641). The one property that matters: the door
 * shows green ONLY on a confirmed admission for this exact ticket. Every other
 * outcome - timeout, network error, 5xx, malformed or mismatched answer - is
 * "couldn't confirm", because the next scanner may be admitting the same ticket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimAdmission, type ClaimCall } from "../src/lib/scanner/claim.js";

const CLAIM = { seriesId: "ser-1", edition: 7, method: "scan" as const, claimId: "c1", at: "2026-09-26T21:00:00.000Z" };
const HOLDER = { seriesId: "ser-1", edition: 7, at: "2026-09-26T20:59:00.000Z", deviceId: "otherdevice01", method: "scan" as const };

function reply(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

function call(fetchFn: typeof fetch, timeoutMs?: number): ClaimCall {
  return { fetchFn, apiBase: "https://api.test", eventId: "evt", token: "tok", deviceId: "thisdevice01", claim: CLAIM, timeoutMs };
}

test("a confirmed admission for this ticket admits", async () => {
  const a = await claimAdmission(call(reply(200, { ok: true, data: { status: "admitted", record: { ...CLAIM, deviceId: "thisdevice01" } } })));
  assert.equal(a.kind, "admitted");
});

test("already in: the holder's record comes back so staff see when and where", async () => {
  const a = await claimAdmission(call(reply(200, { ok: true, data: { status: "already-in", record: HOLDER } })));
  assert.equal(a.kind, "already-in");
  assert.equal(a.kind === "already-in" && a.record.deviceId, "otherdevice01");
});

test("no answer in time is 'couldn't confirm', never a yes", async () => {
  const hang = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
  // Raced so a missing timeout fails this test instead of hanging the run.
  const a = await Promise.race([
    claimAdmission(call(hang, 30)),
    new Promise<{ kind: "hung" }>((r) => setTimeout(() => r({ kind: "hung" }), 1000)),
  ]);
  assert.equal(a.kind, "cant-confirm");
});

test("a network error, a 5xx or a malformed body is 'couldn't confirm'", async () => {
  const down = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
  for (const f of [
    down,
    reply(503, { ok: false, error: "Check-in could not be recorded" }),
    reply(500, "not json"),
    reply(200, { ok: true }),
    reply(200, { ok: true, data: { status: "maybe", record: CLAIM } }),
    // A body that claims admission is not enough on its own: the status and the
    // ok flag must agree, or a proxy's error page could wave someone through.
    reply(502, { ok: true, data: { status: "admitted", record: { ...CLAIM, deviceId: "thisdevice01" } } }),
    reply(200, { ok: false, data: { status: "admitted", record: { ...CLAIM, deviceId: "thisdevice01" } } }),
  ]) {
    assert.equal((await claimAdmission(call(f))).kind, "cant-confirm");
  }
});

test("an answer about a DIFFERENT ticket never admits this one", async () => {
  const a = await claimAdmission(call(reply(200, { ok: true, data: { status: "admitted", record: { ...CLAIM, edition: 8, deviceId: "x" } } })));
  assert.equal(a.kind, "cant-confirm");
});

test("a revoked pass and a pass bound to another phone are reported as such", async () => {
  assert.equal((await claimAdmission(call(reply(401, { ok: false, error: "Door pass revoked" })))).kind, "pass-dead");
  assert.equal((await claimAdmission(call(reply(403, { ok: false, error: "Door pass is for a different event" })))).kind, "pass-dead");
  const other = await claimAdmission(call(reply(409, { ok: false, error: "This door pass is for one scanner", reason: "wrong-device" })));
  assert.equal(other.kind, "cant-confirm");
  assert.match(other.kind === "cant-confirm" ? other.message : "", /one scanner/);
});

test("the claim carries the door pass and this device's id", async () => {
  let seen: Headers | null = null;
  const spy = (async (_url: string, init?: RequestInit) => {
    seen = new Headers(init?.headers);
    return new Response(JSON.stringify({ ok: true, data: { status: "admitted", record: { ...CLAIM, deviceId: "thisdevice01" } } }));
  }) as typeof fetch;
  await claimAdmission(call(spy));
  assert.equal(seen!.get("X-Door-Pass"), "tok");
  assert.equal(seen!.get("X-Scanner-Device"), "thisdevice01");
});
