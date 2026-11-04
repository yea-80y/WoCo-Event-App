import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEATS_ALWAYS_DRAWN, SEAT_DRAW_BUDGET, TOUCH_TARGET_PX, clampView, fitBox, levelFor, onScreen, panBy, seatTargetPx,
  showPoints, viewBoxOf, visible, zoomAt, zoomForTarget, zoomLimits,
} from "../src/view.js";

const screen = { w: 1000, h: 600 };
const room = { x0: 0, y0: 0, x1: 2000, y1: 1000 };

test("fit shows the whole box, centred", () => {
  const v = fitBox(room, screen, 0);
  assert.equal(v.cx, 1000);
  assert.equal(v.cy, 500);
  assert.equal(v.z, 0.5);
  const vb = viewBoxOf(v, screen);
  assert.ok(vb.x <= 0 && vb.x + vb.w >= 2000 && vb.y <= 0 && vb.y + vb.h >= 1000);
});

test("zooming about a point keeps that point under the finger", () => {
  const v = { cx: 1000, cy: 500, z: 0.5 };
  const before = { x: v.cx + (200 - 500) / v.z, y: v.cy + (100 - 300) / v.z };
  const w = zoomAt(v, 3, 200, 100, screen);
  const after = { x: w.cx + (200 - 500) / w.z, y: w.cy + (100 - 300) / w.z };
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
  assert.equal(w.z, 1.5);
});

test("clamp keeps zoom in limits and some of the room on screen", () => {
  const { min, max } = zoomLimits(room, screen);
  assert.ok(max >= zoomForTarget(TOUCH_TARGET_PX));
  assert.equal(clampView({ cx: 1000, cy: 500, z: 100 }, room, screen).z, max);
  assert.equal(clampView({ cx: 1000, cy: 500, z: 0.0001 }, room, screen).z, min);
  const far = clampView({ cx: 1e7, cy: -1e7, z: 1 }, room, screen);
  assert.ok(far.cx <= room.x1 + screen.w && far.cy >= room.y0 - screen.h);
  assert.deepEqual(panBy({ cx: 0, cy: 0, z: 2 }, 20, -10), { cx: -10, cy: 5, z: 2 });
});

test("level: small rooms are always seats; big ones need visible seats and few enough of them", () => {
  assert.equal(levelFor(SEATS_ALWAYS_DRAWN, 0.01, 1e6), "seats");
  assert.equal(levelFor(SEATS_ALWAYS_DRAWN + 1, 0.1, 10), "sections", "seats under 7 px");
  assert.equal(levelFor(SEATS_ALWAYS_DRAWN + 1, 1, SEAT_DRAW_BUDGET + 1), "sections", "too many on screen");
  assert.equal(levelFor(SEATS_ALWAYS_DRAWN + 1, 1, SEAT_DRAW_BUDGET), "seats");
});

test("visible picks boxes on screen, with a margin", () => {
  const v = fitBox({ x0: 0, y0: 0, x1: 100, y1: 100 }, screen, 0);
  const list = [{ box: { x0: 10, y0: 10, x1: 20, y1: 20 } }, { box: { x0: 5000, y0: 0, x1: 5100, y1: 10 } }];
  assert.deepEqual(visible(list, v, screen, 0), [0]);
});

test("show points: stay put when they are already on screen and tappable, else go there zoomed to tap size", () => {
  const minZ = zoomForTarget(TOUCH_TARGET_PX);
  const here = { cx: 100, cy: 100, z: minZ };
  assert.equal(showPoints(here, [{ x: 100, y: 100 }], screen, minZ), here);
  const there = showPoints(here, [{ x: 5000, y: 5000 }, { x: 5040, y: 5000 }], screen, minZ)!;
  assert.equal(there.cx, 5020);
  assert.equal(there.z, minZ);
  assert.ok(onScreen(there, screen, 5000, 5000) && onScreen(there, screen, 5040, 5000));
  assert.ok(seatTargetPx(there.z) >= TOUCH_TARGET_PX - 1e-9);
  assert.equal(showPoints(here, [], screen, minZ), null);
});
