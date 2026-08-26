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

  // The name claimed a universal the code did not deliver (#221): an IPv4-mapped
  // address has three spellings and only the dotted one was recognised. The
  // other two fell to the /64 path and keyed `0:0:0:0::/64`.
  const v4 = normaliseClientIp("203.0.113.7");
  for (const variant of [
    "::ffff:203.0.113.7",         // dotted-mapped
    "::ffff:cb00:7107",           // hex-mapped — 0xcb00 = 203.0, 0x7107 = 113.7
    "0:0:0:0:0:ffff:203.0.113.7", // expanded-mapped
    "::FFFF:CB00:7107",           // upper case
  ]) {
    assert.equal(normaliseClientIp(variant), v4, `variant keyed differently: ${variant}`);
  }
});

test("an IPv4-mapped address lands in the IPv4 caller's bucket", () => {
  assert.equal(normaliseClientIp("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(normaliseClientIp("::ffff:203.0.113.7"), normaliseClientIp("203.0.113.7"));
  assert.equal(normaliseClientIp("::ffff:cb00:7107"), "203.0.113.7");
  assert.equal(normaliseClientIp("0:0:0:0:0:ffff:203.0.113.7"), "203.0.113.7");
});

test("two hex-mapped IPv4 callers do not collide, as they used to", () => {
  // The converse of the defect above, and the one that mattered: EVERY
  // hex-spelled IPv4 address keyed the single bucket `0:0:0:0::/64`, so
  // unrelated machines shared one allowance and one of them could spend it.
  assert.equal(normaliseClientIp("::ffff:102:304"), "1.2.3.4");
  assert.equal(normaliseClientIp("::ffff:506:708"), "5.6.7.8");
  assert.notEqual(normaliseClientIp("::ffff:102:304"), normaliseClientIp("::ffff:506:708"));
});

test("an IPv4-COMPATIBLE address is not treated as mapped", () => {
  // `::1.2.3.4` has no ffff prefix. It is a deprecated form and not evidence of
  // an IPv4 caller, so it stays on the /64 path — the mapped check must key on
  // the ffff hextet, not merely on there being a dotted tail.
  assert.equal(normaliseClientIp("::1.2.3.4"), "0:0:0:0::/64");
  assert.notEqual(normaliseClientIp("::1.2.3.4"), normaliseClientIp("1.2.3.4"));
});

test("IPv4 is used whole — the whole address is the caller", () => {
  assert.equal(normaliseClientIp("203.0.113.7"), "203.0.113.7");
  assert.notEqual(normaliseClientIp("203.0.113.7"), normaliseClientIp("203.0.113.8"));
});

test("an unrecognised value keeps its own bucket rather than joining unknown", () => {
  // Collapsing it into UNKNOWN_CLIENT would let one malformed value share a
  // bucket with the header-less case, and with every other malformed value.
  const odd = normaliseClientIp("not-an-address");
  assert.notEqual(odd, UNKNOWN_CLIENT);
  assert.notEqual(odd, normaliseClientIp("also-not-an-address"));

  // The name was false for one input, and it was the input that mattered: the
  // literal "unknown" normalised to exactly UNKNOWN_CLIENT, so a caller could
  // choose to join the shared header-less bucket. Literal keys are namespaced
  // now, which makes the two keyspaces disjoint by construction (#221).
  assert.notEqual(normaliseClientIp("unknown"), UNKNOWN_CLIENT);
  assert.notEqual(normaliseClientIp("unknown"), normaliseClientIp("not-an-address"));
});

test("no literal can be spelled to land in a real address's bucket", () => {
  // The other half of the same property. A literal that LOOKS like a normalised
  // key must not become one — otherwise the value a caller sends decides which
  // bucket it shares, which is the property this whole module exists to deny.
  // NOT "203.0.113.7 " — a whitespace-padded real address is the same caller and
  // SHOULD trim into the same bucket; the test above asserts exactly that. It is
  // an impostor only if the value is not that address.
  for (const impostor of ["unknown", "2001:db8:1:2::/64", "raw:203.0.113.7", "0:0:0:0::/64"]) {
    const key = normaliseClientIp(impostor);
    assert.notEqual(key, normaliseClientIp("203.0.113.7"), `impostor reached an IPv4 bucket: ${impostor}`);
    assert.notEqual(key, normaliseClientIp("2001:db8:1:2:3:4:5:6"), `impostor reached a /64 bucket: ${impostor}`);
    assert.notEqual(key, UNKNOWN_CLIENT, `impostor reached the shared bucket: ${impostor}`);
  }
});

test("whitespace around a real address does not mint a second bucket", () => {
  // Handled by the trim() in normaliseClientIp, previously untested.
  assert.equal(normaliseClientIp("  203.0.113.7  "), "203.0.113.7");
  assert.equal(normaliseClientIp("\t2001:db8:1:2:3:4:5:6\n"), normaliseClientIp("2001:db8:1:2:3:4:5:6"));
});

test("an IPv4 with leading zeros keeps its own bucket — deliberately", () => {
  // `isIPv4` rejects `203.0.113.007`, so it is not treated as an address. That
  // is the RIGHT answer rather than a gap: accepting a form Node rejects would
  // mean parsing octets ourselves, and the ambiguity (octal? decimal?) is the
  // reason it is rejected. It gets a literal bucket, distinct from the canonical
  // spelling — which costs one bucket and grants nothing.
  assert.notEqual(normaliseClientIp("203.0.113.007"), normaliseClientIp("203.0.113.7"));
  assert.notEqual(normaliseClientIp("203.0.113.007"), UNKNOWN_CLIENT);
});

test("the edge value is normalised, not passed through raw", () => {
  assert.equal(clientIp(req({ "cf-connecting-ip": "2001:DB8:1234:5678::1" })), "2001:db8:1234:5678::/64");
});
