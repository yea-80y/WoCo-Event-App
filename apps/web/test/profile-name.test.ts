/**
 * Which name a person's own codes carry (owner's phone test, 2026-09-15).
 *
 * The rule is narrow: the PROFILE name, and only once the chain confirms this
 * account holds it; otherwise nothing, so the caller uses the address link.
 * Other names the account owns are never consulted, which is why these fakes
 * have no way to offer one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { verifiedProfileName, type ProfileNameDeps } from "../src/lib/sub-ens/profile-name.js";

const ME = "0xAbCdEf0000000000000000000000000000000001";

function fakes(over: Partial<ProfileNameDeps> = {}) {
  const asked: [string, string][] = [];
  const deps: ProfileNameDeps = {
    readProfile: async () => ({ subEnsLabel: "nabil" }),
    verify: async (label, owner) => { asked.push([label, owner]); return true; },
    ...over,
  };
  return { deps, asked };
}

test("the profile's name is used once the chain confirms this account holds it", async () => {
  const { deps, asked } = fakes();
  assert.equal(await verifiedProfileName(ME, deps), "nabil");
  // Asked about THIS account, in the case the owner check compares.
  assert.deepEqual(asked, [["nabil", ME.toLowerCase()]]);
});

test("a name the chain gives to another account is not used", async () => {
  const { deps } = fakes({ verify: async () => false });
  assert.equal(await verifiedProfileName(ME, deps), null);
});

test("no name on the profile means no name, and nothing is checked", async () => {
  for (const profile of [{}, null]) {
    const { deps, asked } = fakes({ readProfile: async () => profile });
    assert.equal(await verifiedProfileName(ME, deps), null);
    assert.equal(asked.length, 0);
  }
});

test("an unreadable profile leaves the address link", async () => {
  const { deps } = fakes({ readProfile: async () => { throw new Error("gateway down"); } });
  assert.equal(await verifiedProfileName(ME, deps), null);
});

test("an unanswered ownership check leaves the address link", async () => {
  const { deps } = fakes({ verify: async () => { throw new Error("rate limited"); } });
  assert.equal(await verifiedProfileName(ME, deps), null);
});
