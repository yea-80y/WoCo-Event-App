import { test } from "node:test";
import assert from "node:assert/strict";
import { fromFrame, fromWidget, originOf, parseFrameMessage, parseWidgetMessage, seatmapFrameUrl } from "../src/seatmap-bridge.js";

const digest = `0x${"ab".repeat(32)}`;

test("frame messages: exact shapes only, seats sorted, never more than an order holds", () => {
  assert.deepEqual(parseFrameMessage({ v: 1, type: "ready" }), { v: 1, type: "ready" });
  assert.deepEqual(parseFrameMessage({ v: 1, type: "cancel" }), { v: 1, type: "cancel" });
  assert.deepEqual(parseFrameMessage({ v: 1, type: "picked", seats: [9, 2], planDigest: digest }), { v: 1, type: "picked", seats: [2, 9], planDigest: digest });
  for (const bad of [
    null, "ready", [], { type: "ready" }, { v: 2, type: "ready" }, { v: 1, type: "ready", extra: 1 },
    { v: 1, type: "picked", seats: [], planDigest: digest },
    { v: 1, type: "picked", seats: [1, 1], planDigest: digest },
    { v: 1, type: "picked", seats: [-1], planDigest: digest },
    { v: 1, type: "picked", seats: [1.5], planDigest: digest },
    { v: 1, type: "picked", seats: Array.from({ length: 11 }, (_, i) => i), planDigest: digest },
    { v: 1, type: "picked", seats: [1], planDigest: "0x12" },
    { v: 1, type: "picked", seats: [1], planDigest: digest, reservationId: "x" },
    { v: 1, type: "hold", expiresAt: "2026-01-01T00:00:00Z" },
  ]) {
    assert.equal(parseFrameMessage(bad), null, JSON.stringify(bad));
  }
  assert.equal(parseFrameMessage({ v: 1, type: "picked", seats: [1, 2, 3], planDigest: digest }, 2), null, "the widget's own max");
});

test("widget messages: exact shapes only", () => {
  assert.deepEqual(parseWidgetMessage({ v: 1, type: "open", max: 10, clientKey: "abcdefgh-123", canHold: false }), { v: 1, type: "open", max: 10, clientKey: "abcdefgh-123", canHold: false });
  assert.deepEqual(parseWidgetMessage({ v: 1, type: "hold", expiresAt: "2026-11-03T21:00:00.000Z" })?.type, "hold");
  assert.deepEqual(parseWidgetMessage({ v: 1, type: "refused", seats: [4], message: "Taken" }), { v: 1, type: "refused", seats: [4], message: "Taken" });
  for (const bad of [
    { v: 1, type: "open", max: 0, clientKey: "abcdefgh", canHold: true },
    { v: 1, type: "open", max: 11, clientKey: "abcdefgh", canHold: true },
    { v: 1, type: "open", max: 2, clientKey: "short", canHold: true },
    { v: 1, type: "open", max: 2, clientKey: "abcdefgh", canHold: "yes" },
    { v: 1, type: "hold", expiresAt: "soon" },
    { v: 1, type: "refused", seats: [4], message: "x".repeat(301) },
    { v: 1, type: "picked", seats: [1], planDigest: digest },
  ]) {
    assert.equal(parseWidgetMessage(bad), null, JSON.stringify(bad));
  }
});

test("each side hears only the other's exact window AND origin", () => {
  const frame = {}, parent = {}, other = {};
  assert.equal(fromFrame({ source: frame, origin: "https://events-api.woco-net.com" }, frame, "https://events-api.woco-net.com"), true);
  assert.equal(fromFrame({ source: other, origin: "https://events-api.woco-net.com" }, frame, "https://events-api.woco-net.com"), false, "another window on our origin");
  assert.equal(fromFrame({ source: frame, origin: "https://evil.example" }, frame, "https://events-api.woco-net.com"), false);
  assert.equal(fromFrame({ source: null, origin: "https://events-api.woco-net.com" }, null, "https://events-api.woco-net.com"), false, "no frame yet");
  assert.equal(fromWidget({ source: parent, origin: "https://venue.example" }, parent, "https://venue.example"), true);
  assert.equal(fromWidget({ source: parent, origin: "https://venue.example.evil" }, parent, "https://venue.example"), false);
});

test("origins and the frame address", () => {
  assert.equal(originOf("https://venue.example/tickets?x=1"), "https://venue.example");
  assert.equal(originOf("javascript:alert(1)"), null);
  assert.equal(originOf("not a url"), null);
  const url = seatmapFrameUrl("https://events-api.woco-net.com/", "e 1", "s/1", "https://venue.example", "light");
  assert.equal(url, "https://events-api.woco-net.com/embed/seatmap/e%201/s%2F1?host=https%3A%2F%2Fvenue.example&theme=light");
});
