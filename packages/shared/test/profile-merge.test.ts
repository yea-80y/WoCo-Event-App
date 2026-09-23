/**
 * The one rule both profile save paths use for the text fields (#652).
 *
 * Before it, each path merged with `updates.x ?? existing.x`, so a field could be
 * set or kept but never removed: emptying your bio or website and saving left the
 * old value in place while the save reported success.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PROFILE_TEXT_FIELDS, mergeProfileText, type ProfileText } from "../src/profile/merge.js";
import type { UpdateProfileRequest } from "../src/profile/types.js";

const EXISTING: ProfileText = {
  displayName: "Nabil",
  bio: "old bio",
  website: "https://woco.eth.limo",
  twitterHandle: "nabil",
  farcasterHandle: "nabil.eth",
};

test("a field the request leaves out keeps its current value", () => {
  assert.deepEqual(mergeProfileText({}, EXISTING), EXISTING);
  assert.deepEqual(mergeProfileText({ bio: "new bio" }, EXISTING), { ...EXISTING, bio: "new bio" });
});

test("null removes a field, and so does an empty string", () => {
  const { twitterHandle: _t, website: _w, ...rest } = EXISTING;
  assert.deepEqual(mergeProfileText({ twitterHandle: null, website: "" }, EXISTING), rest);
});

test("removing from a profile that never had the field is a no-op, not an error", () => {
  assert.deepEqual(mergeProfileText({ bio: null }, { displayName: "Nabil" }), { displayName: "Nabil" });
  assert.deepEqual(mergeProfileText({ bio: null }, null), {});
});

test("a first save starts from nothing and keeps only what it sets", () => {
  assert.deepEqual(mergeProfileText({ displayName: "Nabil", bio: null }, null), { displayName: "Nabil" });
});

test("a malformed value keeps the current one: only an explicit clear may remove", () => {
  // Reaches the server unvalidated from a request body. A junk type must never
  // read as "clear this field".
  for (const junk of [0, 42, true, false, {}, [], { toString: () => "x" }]) {
    const updates = { bio: junk } as unknown as UpdateProfileRequest;
    assert.deepEqual(mergeProfileText(updates, EXISTING), EXISTING, `bio: ${JSON.stringify(junk)}`);
  }
});

test("a stored empty string is not carried forward", () => {
  assert.deepEqual(mergeProfileText({}, { displayName: "Nabil", bio: "" }), { displayName: "Nabil" });
});

test("only the text fields come out, so the merge cannot drop or invent anything else", () => {
  const merged = mergeProfileText(
    { displayName: "N", subEnsLabel: "nabil" } as UpdateProfileRequest,
    { ...EXISTING, avatarRef: "ab".repeat(32) } as ProfileText,
  );
  assert.deepEqual(Object.keys(merged).sort(), [...PROFILE_TEXT_FIELDS].sort());
});
