/**
 * The overlay ships pre-configured for the pilot, so the subject it points at
 * is baked into a generated HTML file rather than passed in. If that literal
 * ever stopped matching the registry, the overlay would count a coaster nobody
 * is riding and every signature involved would still verify — the failure would
 * look exactly like "no laps yet".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RITA_SUBJECT } from "@woco/shared";
import { RITA_SUBJECT_HASH } from "../src/count/pilot.js";

test("the overlay's baked-in pilot subject is the registry's Rita subject", () => {
  assert.equal(
    RITA_SUBJECT_HASH,
    RITA_SUBJECT,
    "regenerate src/count/pilot.ts from RITA_SUBJECT in @woco/shared",
  );
});

test("it is a lowercase bytes32, which is what the count endpoint accepts", () => {
  assert.match(RITA_SUBJECT_HASH, /^0x[0-9a-f]{64}$/);
});
