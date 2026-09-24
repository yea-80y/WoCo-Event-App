/**
 * The server's profile save uses the same text-field rule as the client's (#652),
 * so an account cannot keep a value it cleared because of which path it saved
 * through. The rule itself is tested in packages/shared/test/profile-merge.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const service = readFileSync(fileURLToPath(new URL("../src/lib/profile/service.ts", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

test("the server save merges the text fields with the shared rule", () => {
  const save = service.slice(service.indexOf("export async function updateProfile("));
  assert.match(save, /\.\.\.mergeProfileText\(updates, existing\)/);
  assert.doesNotMatch(save, /updates\.(?:displayName|bio|website|twitterHandle|farcasterHandle) \?\?/);
});
