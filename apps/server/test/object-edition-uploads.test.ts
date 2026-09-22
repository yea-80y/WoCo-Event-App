/**
 * #263: minting a chain-rail badge must not upload one Swarm body per edition.
 * Nothing reads `objectRefs`, and the manifest's Merkle root already commits to
 * every body - the event path dropped the same uploads in 896b29b3. The
 * certificate rail keeps its single template upload.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { EditionV1Body } from "@woco/shared";
import { bodiesToUpload } from "../src/lib/object/issuance.js";

const body = (n: number) => ({ edition: n }) as unknown as EditionV1Body;
const bodies = (count: number) => Array.from({ length: count }, (_, i) => body(i + 1));

test("the chain rail uploads no edition bodies, whatever the supply", () => {
  assert.deepEqual(bodiesToUpload(false, bodies(1)), []);
  assert.deepEqual(bodiesToUpload(false, bodies(10_000)), []);
});

test("the certificate rail uploads exactly its one template body", () => {
  const template = bodies(1);
  assert.deepEqual(bodiesToUpload(true, template), template);
});

test("issueObjectType uploads only what bodiesToUpload returns", () => {
  // Text check: the function's other dependencies (chain registration, the
  // directory write) have no test seam. What matters is that the upload maps
  // over bodiesToUpload and nothing else walks editionBodies to upload.
  const src = readFileSync(new URL("../src/lib/object/issuance.ts", import.meta.url), "utf-8");
  const fn = src.slice(src.indexOf("export async function issueObjectType"));
  assert.match(fn, /bodiesToUpload\(certSourced, editionBodies\)\.map\(\(p\) => uploadToBytes\(/);
  assert.equal(fn.match(/uploadToBytes\(/g)?.length, 2, "one body upload site + the manifest blob, no more");
});
