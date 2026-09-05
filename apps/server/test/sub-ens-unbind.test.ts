/**
 * Removing a sub-ENS name from a profile, an event or a site (plan doc §5).
 *
 * The shape that matters everywhere: `undefined` LEAVES the bound name alone,
 * `null` REMOVES it. Every other field in these patches uses
 * `patch ?? existing`, which collapses those two into one — which is why a name
 * could be bound but never removed.
 *
 * Setting a name is deliberately not reachable from any of these paths: it
 * requires an on-chain ownership proof that only `POST /api/sub-ens/stamp-event`
 * (events) and the profile bind (`/verify-label`) perform. So the removal paths
 * are typed and checked as CLEAR-ONLY.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveSubEnsLabelUpdate } from "../src/lib/profile/service.js";

// ---------------------------------------------------------------------------
// The three-way merge
// ---------------------------------------------------------------------------

test("undefined carries the bound name forward", () => {
  // The regression this protects: editing a display name must not silently
  // drop a name that took an on-chain verification step to bind.
  assert.equal(resolveSubEnsLabelUpdate(undefined, "punkpub"), "punkpub");
});

test("null REMOVES the bound name", () => {
  assert.equal(resolveSubEnsLabelUpdate(null, "punkpub"), undefined);
});

test("a string binds", () => {
  assert.equal(resolveSubEnsLabelUpdate("newname", "punkpub"), "newname");
});

test("null on an account that has no name is a no-op, not an error", () => {
  assert.equal(resolveSubEnsLabelUpdate(null, undefined), undefined);
});

test("undefined with no existing name stays absent", () => {
  assert.equal(resolveSubEnsLabelUpdate(undefined, undefined), undefined);
});

test("null and undefined are NOT interchangeable — the whole point", () => {
  // Stated as its own test because the two collapse under `??`, which is
  // exactly the defect: `undefined ?? existing` and `null ?? existing` both
  // yield `existing`, so the unbind silently did nothing.
  assert.notEqual(
    resolveSubEnsLabelUpdate(null, "punkpub"),
    resolveSubEnsLabelUpdate(undefined, "punkpub"),
  );
});

// ---------------------------------------------------------------------------
// Clear-only, at the routes that accept the patch
// ---------------------------------------------------------------------------

function sourceOf(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
}

test("update-meta REFUSES a name string instead of setting one", () => {
  // Accepting a string here would be a second way to put a name on an event
  // without the on-chain ownership check — on a route whose whole shape is
  // "patch whitelisted display fields".
  const src = sourceOf("../src/routes/events.ts");
  assert.match(src, /body\.subEnsLabel !== null/);
  assert.match(src, /use stamp-event to set a name/);
});

test("the event merge can only DELETE the label, never assign it", () => {
  const src = sourceOf("../src/lib/event/service.ts");
  const merge = src.slice(src.indexOf("if (updates.subEnsLabel !== undefined)"));
  const block = merge.slice(0, merge.indexOf("}") + 1);
  assert.match(block, /delete updated\.subEnsLabel/);
  assert.doesNotMatch(block, /updated\.subEnsLabel\s*=/);
});

test("the clear-only intent is carried by the TYPE, not just the check", () => {
  // `subEnsLabel?: null` on both the request and the internal patch means a
  // string cannot be assigned at all in typed code; the runtime check exists
  // for untyped JSON off the wire. Losing the type would make the runtime check
  // the only guard, so pin it.
  const shared = sourceOf("../../../packages/shared/src/event/types.ts");
  assert.match(shared, /subEnsLabel\?: null;/);
  const svc = sourceOf("../src/lib/event/service.ts");
  assert.match(svc, /subEnsLabel\?: null;/);
});

test("the unbind route exists and does not require an ownership proof", () => {
  // Removing can only ever make an account claim LESS, so gating it on a chain
  // read would mean an RPC outage could trap a user with a name they cannot
  // remove.
  const src = sourceOf("../src/routes/profiles.ts");
  assert.match(src, /profiles\.post\("\/unbind-name", requireAuth/);
  assert.doesNotMatch(
    src.slice(src.indexOf('profiles.post("/unbind-name"')).slice(0, 400),
    /getLabelOwner/,
  );
});
