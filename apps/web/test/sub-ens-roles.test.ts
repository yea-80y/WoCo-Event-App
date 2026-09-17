/**
 * The pickers must not offer a name the server will refuse (#484).
 *
 * `stamp-event`, `set-contenthash` and the site deploy hook all answer 409
 * `profile_name` for the account's identity name, so the property under test is
 * narrow and total: the filter removes exactly the profile role and nothing
 * else — including names with no role at all, which is what a response cached
 * from an older server looks like.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { bindableNames, hidesProfileName, inviteLabel, profileLabel, roleLabel } from "../src/lib/sub-ens/roles.js";

const NAMES = [
  { label: "nabil", role: "profile" as const },
  { label: "punkpub", role: "url" as const },
  { label: "spare", role: "free" as const },
];

test("the profile name is the only row hidden", () => {
  const offered = bindableNames(NAMES);
  assert.deepEqual(offered.map((n) => n.label), ["punkpub", "spare"]);
  // Said the other way round, so a filter that dropped everything still fails.
  assert.equal(offered.some((n) => n.role === "profile"), false);
});

test("a name with no role is kept — an older server sends none", () => {
  const legacy = [{ label: "old" }, { label: "nabil", role: "profile" as const }];
  assert.deepEqual(bindableNames(legacy).map((n) => n.label), ["old"]);
});

test("a list with no profile name is returned whole", () => {
  const all = NAMES.slice(1);
  assert.equal(bindableNames(all).length, all.length);
  assert.equal(hidesProfileName(all), false);
});

test("hidesProfileName says whether the hint line is warranted", () => {
  assert.equal(hidesProfileName(NAMES), true);
  assert.equal(hidesProfileName([]), false);
});

test("filtering does not mutate the list it was given", () => {
  const before = NAMES.map((n) => n.label);
  bindableNames(NAMES);
  assert.deepEqual(NAMES.map((n) => n.label), before);
});

test("each role reads as a person would say it", () => {
  assert.equal(roleLabel("profile"), "profile name");
  assert.equal(roleLabel("url"), "site address");
  assert.equal(roleLabel("free"), "not pointed anywhere yet");
});

test("an absent role has no label, so the caller keeps its old text", () => {
  assert.equal(roleLabel(undefined), undefined);
});

test("an invite link carries the profile name even when another name sorts first", () => {
  // "aardvark" sorts before "nabil", so a plain sort would put the site name in the link.
  const names = [{ label: "aardvark", role: "url" as const }, { label: "nabil", role: "profile" as const }];
  assert.equal(inviteLabel(names), "nabil");
});

test("without a profile name the invite link uses the first name alphabetically", () => {
  assert.equal(inviteLabel([{ label: "punkpub", role: "url" as const }, { label: "aardvark" }]), "aardvark");
});

test("no names means no name in the invite link", () => {
  assert.equal(inviteLabel([]), null);
});

test("profileLabel picks the profile name and nothing else", () => {
  assert.equal(profileLabel(NAMES), "nabil");
  // Other roles and role-less names are never mistaken for the profile name.
  assert.equal(profileLabel([{ label: "punkpub", role: "url" as const }, { label: "old" }]), null);
  assert.equal(profileLabel([]), null);
});
