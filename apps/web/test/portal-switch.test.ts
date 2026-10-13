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
  assert.equal(ATTENDEE_PORTAL_LABEL, "Attendees");
  assert.equal(ORGANISER_PORTAL_PATH, "/creator");
  assert.equal(ATTENDEE_PORTAL_PATH, "/home");
});

test("the home page shows both portals with no sign-in of its own", () => {
  assert.match(HOME, /<PortalSwitch \/>/);
  assert.doesNotMatch(HOME, /loginRequest|My tickets<\/button>\s*\{:else/);
});

test("each portal's bar shows both portals whether signed in or not, with its own lit, and no Sign in", () => {
  for (const [name, src, current] of [
    ["AttendeeShell", ATTENDEE, "attendee"],
    ["CreatorShell", ORGANISER, "organiser"],
  ] as const) {
    const bar = src.slice(src.indexOf('<div class="top-right">'), src.indexOf("</header>"));
    const at = bar.indexOf(`<PortalSwitch current="${current}" />`);
    assert.ok(at > 0, `${name}: the switch is in the bar`);
    // Before any {#if}: shown in every state, never only signed in or signed out.
    assert.ok(!bar.slice(0, at).includes("{#if"), `${name}: the switch sits inside a condition`);
    assert.doesNotMatch(bar, /loginRequest|>\s*Sign in\s*</, `${name}: the bar has its own Sign in again`);
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
