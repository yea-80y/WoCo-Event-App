/**
 * One rate-limit bucket should mean one caller (#179).
 *
 * Two ways that failed. Six of nine call sites read a caller-supplied header
 * first, so a caller could pick their own bucket — and three of those read the
 * authoritative header too, just second, which is why they read as correct at a
 * glance. And every site bucketed on the raw address, so one caller could hold
 * many buckets: an end site controls a whole IPv6 /64, and the same address has
 * several textual spellings.
 *
 * The first test is the one that matters: a caller-supplied X-Forwarded-For must
 * not influence the answer, whatever it contains.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { clientIp, normaliseClientIp, UNKNOWN_CLIENT } from "../src/lib/http/client-ip.js";

/** Minimal stand-in for the Hono context the helper reads. */
function req(headers: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { req: { header: (n: string) => lower[n.toLowerCase()] } };
}

test("a caller-supplied X-Forwarded-For does not influence the bucket", () => {
  // The edge appends to whatever the client sent, so xff[0] is caller-authored.
  const c = req({
    "x-forwarded-for": "9.9.9.9, 8.8.8.8",
    "cf-connecting-ip": "203.0.113.7",
  });
  assert.equal(clientIp(c), "203.0.113.7");
});

test("the forwarded header alone yields no identity at all", () => {
  assert.equal(clientIp(req({ "x-forwarded-for": "9.9.9.9" })), UNKNOWN_CLIENT);
});

test("a header-less request lands in the shared bucket", () => {
  assert.equal(clientIp(req({})), UNKNOWN_CLIENT);
  assert.equal(clientIp(req({ "cf-connecting-ip": "   " })), UNKNOWN_CLIENT);
});

// ── One caller, one bucket ───────────────────────────────────────────────────

test("IPv6 buckets on the /64, so varying the low bits does not mint buckets", () => {
  const a = normaliseClientIp("2001:db8:1234:5678:1:2:3:4");
  const b = normaliseClientIp("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd");
  assert.equal(a, b, "two addresses in one /64 keyed different buckets");
  assert.equal(a, "2001:db8:1234:5678::/64");
});

test("a different /64 is a different bucket", () => {
  assert.notEqual(
    normaliseClientIp("2001:db8:1234:5678::1"),
    normaliseClientIp("2001:db8:1234:9999::1"),
  );
});

test("spelling does not change the bucket", () => {
  const canonical = normaliseClientIp("2001:db8:1234:5678::1");
  for (const variant of [
    "2001:0db8:1234:5678:0000:0000:0000:0001", // fully expanded
    "2001:DB8:1234:5678::1",                    // upper case
    "2001:db8:1234:5678::1%eth0",               // zone index
  ]) {
    assert.equal(normaliseClientIp(variant), canonical, `variant keyed differently: ${variant}`);
  }
});

test("an IPv4-mapped address lands in the IPv4 caller's bucket", () => {
  assert.equal(normaliseClientIp("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(normaliseClientIp("::ffff:203.0.113.7"), normaliseClientIp("203.0.113.7"));
});

test("IPv4 is used whole — the whole address is the caller", () => {
  assert.equal(normaliseClientIp("203.0.113.7"), "203.0.113.7");
  assert.notEqual(normaliseClientIp("203.0.113.7"), normaliseClientIp("203.0.113.8"));
});

test("an unrecognised value keeps its own bucket rather than joining unknown", () => {
  // Collapsing it into UNKNOWN_CLIENT would let one malformed value share a
  // bucket with the header-less case, and with every other malformed value.
  const odd = normaliseClientIp("not-an-address");
  assert.equal(odd, "not-an-address");
  assert.notEqual(odd, UNKNOWN_CLIENT);
  assert.notEqual(odd, normaliseClientIp("also-not-an-address"));
});

test("the edge value is normalised, not passed through raw", () => {
  assert.equal(clientIp(req({ "cf-connecting-ip": "2001:DB8:1234:5678::1" })), "2001:db8:1234:5678::/64");
});
