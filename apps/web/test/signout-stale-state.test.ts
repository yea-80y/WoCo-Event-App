/**
 * What a sign-out must take off the screen without a reload.
 *
 * Both surfaces here stay MOUNTED across a sign-out - Home shows its sign-in
 * callout, the profile keeps its URL - so anything they loaded for the last
 * account stays visible unless they clear it themselves. The owner found both
 * by signing out (2026-11-02): the referral card still said who "now earns from
 * your sales", and the profile came back as the public view of the account
 * just left. Components cannot run under node:test, so what is pinned is the
 * SOURCE, as in `lap-times-wiring.test.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
/** Comments stripped: the files describe the bug in prose. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/\/\/[^\n]*/g, "");

const BANNER = code(read("../src/lib/components/campaign/ReferralConfirmBanner.svelte"));
const PROFILE = code(read("../src/lib/components/profile/ProfilePage.svelte"));

function body(src: string, signature: RegExp): string {
  const at = src.search(signature);
  assert.ok(at >= 0, `not found: ${signature}`);
  const open = src.indexOf("{", src.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error("unbalanced");
}

test("the referral card clears everything it read when the account goes or changes", () => {
  const reset = body(BANNER, /function reset\(\)/);
  for (const field of ["myFeed", "statement", "status", "confirmed", "errorMsg"]) {
    assert.match(reset, new RegExp(`\\b${field} = null`), `reset() must clear ${field}`);
  }
  assert.match(reset, /phase = "idle"/);
  assert.match(reset, /generation\+\+/, "a reset retires reads already in flight");

  // Keyed on the signed-in account, null when signed out: a sign-out IS a change.
  assert.match(BANNER, /const parent = auth\.isAuthenticated \? \(auth\.parent\?\.toLowerCase\(\) \?\? null\) : null;/);
  assert.match(BANNER, /if \(parent !== shownFor\) \{\s*reset\(\);/);
});

test("a referral read that finishes after a sign-out lands nowhere", () => {
  const load = body(BANNER, /async function load\(/);
  // Every await in load() is followed by the same-account check before any write.
  const awaits = load.split(/\bawait\b/).slice(1);
  assert.ok(awaits.length >= 3, "load() awaits the feed, the two reads and the auto-confirm");
  for (const after of awaits) {
    const nextStatement = after.slice(after.indexOf(";") + 1).trimStart();
    assert.match(nextStatement, /^if \((!feed \|\| )?!current\(\)\) return;/, `unchecked await: ${after.slice(0, 60)}`);
  }

  const confirm = body(BANNER, /async function confirm\(\)/);
  const confirmAwaits = confirm.split(/\bawait\b/).slice(1);
  for (const after of confirmAwaits) {
    const nextStatement = after.slice(after.indexOf(";") + 1).trimStart();
    assert.match(nextStatement, /^if \(generation !== mine\) return;/, `unchecked await in confirm(): ${after.slice(0, 60)}`);
  }
});

test("signing out on your own profile leaves the address-less route, not your public view", () => {
  assert.match(PROFILE, /const signedOutOfOwn = _wasOwnView && !auth\.isConnected;/);
  // Remembered per key, from the owner verdict the page already uses.
  assert.match(PROFILE, /_wasOwnView = isOwner;/);
  assert.match(
    PROFILE,
    /if \(signedOutOfOwn && v\) \{[^}]*replaceRoute\(router\.surface === "creator" \? "\/creator\/profile" : "\/profile"\);\s*return;/,
  );
  // Before the public load, or the page paints the public view first.
  assert.ok(PROFILE.indexOf("if (signedOutOfOwn && v)") < PROFILE.indexOf("loadProfile();\n  });"));
});
