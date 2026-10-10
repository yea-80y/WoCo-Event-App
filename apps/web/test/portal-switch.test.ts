/**
 * Every top bar offers BOTH portals, signed in or not, and the logo always goes
 * to the home page (owner 2026-10-10). The pre-launch banner is gone from all of
 * them. SOURCE SCAN: Svelte components cannot be mounted in Node.
 *
 * MUTATION: wrap a PortalSwitch in a signed-in-only branch, point a logo at
 * /home, or put the banner back, and a case below goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ATTENDEE_PORTAL_LABEL,
  ATTENDEE_PORTAL_PATH,
  ORGANISER_PORTAL_LABEL,
  ORGANISER_PORTAL_PATH,
} from "../src/lib/components/nav/portal-labels.js";

const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(path(rel), "utf8");

const HOME = read("../src/lib/landing/Splitter.svelte");
const ATTENDEE = read("../src/lib/layouts/AttendeeShell.svelte");
const ORGANISER = read("../src/lib/layouts/CreatorShell.svelte");

test("the two portals keep their names and doors", () => {
  assert.equal(ORGANISER_PORTAL_LABEL, "Organisers");
  assert.equal(ATTENDEE_PORTAL_LABEL, "Fans");
  assert.equal(ORGANISER_PORTAL_PATH, "/creator");
  assert.equal(ATTENDEE_PORTAL_PATH, "/home");
});

test("the home page shows both portals with no sign-in of its own", () => {
  assert.match(HOME, /<PortalSwitch \/>/);
  assert.doesNotMatch(HOME, /loginRequest|My tickets<\/button>\s*\{:else/);
});

test("each portal's bar shows both portals whether signed in or not, with its own lit", () => {
  for (const [name, src, current] of [
    ["AttendeeShell", ATTENDEE, "attendee"],
    ["CreatorShell", ORGANISER, "organiser"],
  ] as const) {
    const switches = src.match(new RegExp(`<PortalSwitch current="${current}" />`, "g")) ?? [];
    assert.equal(switches.length, 2, `${name}: one switch in the signed-in branch and one in the signed-out branch`);
  }
});

test("every logo goes to the home page", () => {
  for (const src of [HOME, ATTENDEE, ORGANISER]) {
    assert.match(src, /class="(?:logo|brand)" onclick=\{\(\) => navigate\("\/"\)\}/);
  }
});

test("the pre-launch banner is gone", () => {
  assert.equal(existsSync(path("../src/lib/components/status/PreLaunchBanner.svelte")), false);
  for (const src of [HOME, ATTENDEE, ORGANISER]) assert.doesNotMatch(src, /PreLaunchBanner/);
});
