/**
 * The relay gate's decisions (#301): which bucket refuses, that refusals are
 * not charged, that statements get the tighter bucket, and that the global
 * ceiling answers 503 and trips the health alarm.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  RelayGate,
  classifyRelayPayload,
  type RelayLimits,
} from "../src/lib/swarm/soc-relay-limits.js";

const MIN = 60_000;
const toHex = (s: string) => Buffer.from(s, "utf8").toString("hex");

const LIMITS: RelayLimits = {
  parent: [{ limit: 4, windowMs: MIN }],
  statement: [{ limit: 2, windowMs: MIN }],
  ip: [{ limit: 6, windowMs: MIN }],
  global: [{ limit: 8, windowMs: MIN }],
};

test("classify: like/follow/credit statements and their subject indexes are 'statement'", () => {
  for (const f of ["woco.like.v1", "woco.follow.v1", "woco.credit.v1", "woco.like-index.v1", "woco.follow-index.v1", "woco.credit-index.v2"]) {
    assert.equal(classifyRelayPayload(toHex(JSON.stringify({ format: f, subject: "x", value: 1 }))), "statement", f);
  }
});

test("classify: anything else is 'other' and never throws", () => {
  assert.equal(classifyRelayPayload(toHex(JSON.stringify({ v: 2, ciphertext: "…" }))), "other"); // sealed envelope
  assert.equal(classifyRelayPayload(toHex(JSON.stringify({ format: "woco.event.v1" }))), "other");
  assert.equal(classifyRelayPayload(toHex("not json")), "other");
  assert.equal(classifyRelayPayload("zz"), "other");
  assert.equal(classifyRelayPayload(""), "other");
  assert.equal(classifyRelayPayload("0x" + toHex("[1,2]")), "other");
});

test("a statement is charged to the parent AND the statement bucket; the statement bucket refuses first", () => {
  const g = new RelayGate("t", LIMITS);
  const a = { parent: "0xA", ip: "1.1.1.1", kind: "statement" as const };
  assert.equal(g.decide({ ...a, now: 0 }).allowed, true);
  assert.equal(g.decide({ ...a, now: 1 }).allowed, true);
  const r = g.decide({ ...a, now: 2 });
  assert.equal(r.allowed, false);
  if (!r.allowed) {
    assert.equal(r.bucket, "statement");
    assert.equal(r.status, 429);
  }
  // The same parent may still make a publish-shaped write (parent bucket 2/4 used).
  assert.equal(g.decide({ ...a, kind: "other", now: 3 }).allowed, true);
  assert.equal(g.decide({ ...a, kind: "other", now: 4 }).allowed, true);
  const r2 = g.decide({ ...a, kind: "other", now: 5 });
  assert.equal(r2.allowed, false);
  if (!r2.allowed) assert.equal(r2.bucket, "parent");
});

test("parent case does not split a bucket", () => {
  const g = new RelayGate("t", LIMITS);
  for (let i = 0; i < 4; i++) assert.equal(g.decide({ parent: "0xAbC", ip: "1.1.1.1", kind: "other", now: i }).allowed, true);
  assert.equal(g.decide({ parent: "0xabc", ip: "1.1.1.1", kind: "other", now: 5 }).allowed, false);
});

test("the IP bucket binds across parents; a refusal is charged nowhere", () => {
  const g = new RelayGate("t", LIMITS);
  for (let i = 0; i < 6; i++) {
    assert.equal(g.decide({ parent: `0x${i}`, ip: "9.9.9.9", kind: "other", now: i }).allowed, true);
  }
  const r = g.decide({ parent: "0xfresh", ip: "9.9.9.9", kind: "other", now: 7 });
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.equal(r.bucket, "ip");
  // The fresh parent was not charged: once the IP window slides it has its full allowance.
  for (let i = 0; i < 4; i++) {
    assert.equal(g.decide({ parent: "0xfresh", ip: "9.9.9.9", kind: "other", now: MIN + 1 + i }).allowed, true);
  }
});

test("the global ceiling answers 503, trips the alarm, and recovers when the window slides", () => {
  const g = new RelayGate("t", LIMITS);
  // 8 allowed across distinct parents and IPs (so no caller bucket refuses first).
  for (let i = 0; i < 8; i++) {
    assert.equal(g.decide({ parent: `0x${i}`, ip: `10.0.0.${i}`, kind: "other", now: i }).allowed, true);
  }
  assert.equal(g.health().globalTrippedAt, null);
  const r = g.decide({ parent: "0x99", ip: "10.0.0.99", kind: "other", now: 9 });
  assert.equal(r.allowed, false);
  if (!r.allowed) {
    assert.equal(r.bucket, "global");
    assert.equal(r.status, 503);
  }
  const h = g.health();
  assert.equal(h.globalTrippedAt, 9);
  assert.equal(h.lastRefusalAt, 9);
  assert.equal(h.refusals.global, 1);
  assert.equal(g.decide({ parent: "0x99", ip: "10.0.0.99", kind: "other", now: MIN + 1 }).allowed, true);
});

test("health counts refusals per bucket", () => {
  const g = new RelayGate("t", LIMITS);
  const a = { parent: "0xA", ip: "1.1.1.1", kind: "statement" as const };
  g.decide({ ...a, now: 0 });
  g.decide({ ...a, now: 1 });
  g.decide({ ...a, now: 2 }); // statement refusal
  g.decide({ ...a, now: 3 }); // statement refusal
  assert.deepEqual(g.health().refusals, { parent: 0, statement: 2, ip: 0, global: 0 });
});
