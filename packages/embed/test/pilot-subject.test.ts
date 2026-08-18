/**
 * The overlay ships pre-configured for the pilot, so the subject it points at
 * is baked into a generated HTML file rather than passed in. If that literal
 * ever stopped matching the coaster it names, the overlay would count something
 * nobody is riding and every signature involved would still verify — the
 * failure would look exactly like "no laps yet".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RITA_SUBJECT, WOCO_SUBJECT_DEFINITIONS, creditSubject } from "@woco/shared";
import { RITA_SUBJECT_HASH } from "../src/count/pilot.js";

/**
 * The permanent id Rita's subject hashes from. Anchoring on THIS rather than on
 * `RITA_SUBJECT` is the whole point of the test: `RITA_SUBJECT` is positional
 * (`creditSubject(WOCO_SUBJECT_DEFINITIONS[0]!.id)`), so inserting any coaster
 * ahead of Rita in the definitions array silently redefines it. A test pinned
 * to the alias would then fail telling whoever hit it to repoint the live
 * overlay at whatever now sits at index 0 — turning a correct build into a
 * wrong one by following its own instructions.
 */
const RITA_ID = "mstisnru-cjt0ipv";

test("the overlay's baked-in subject is Rita, by permanent id", () => {
  assert.equal(
    RITA_SUBJECT_HASH,
    creditSubject(RITA_ID),
    `src/count/pilot.ts must hold the subject for id "${RITA_ID}"`,
  );
});

test("Rita is still in the shipped catalogue under that id", () => {
  const found = WOCO_SUBJECT_DEFINITIONS.find((d) => d.id === RITA_ID);
  assert.ok(found, `no definition with id "${RITA_ID}" — the overlay would render "Unknown coaster"`);
});

test("the RITA_SUBJECT alias still resolves to Rita", () => {
  // Not what the overlay depends on, but if this drifts, every OTHER call site
  // using the alias has quietly changed coaster — worth failing loudly here
  // since this package is where the mismatch was reasoned about.
  assert.equal(
    RITA_SUBJECT,
    creditSubject(RITA_ID),
    "RITA_SUBJECT no longer points at Rita — a definition was inserted ahead of it",
  );
});

test("it is a lowercase bytes32, which is what the count endpoint accepts", () => {
  assert.match(RITA_SUBJECT_HASH, /^0x[0-9a-f]{64}$/);
});
