/**
 * The organiser key a ledger2 registration names: the server checks the browser's binding
 * against the VERIFIED session parent and the account's CURRENT key-ring generation, and
 * stores nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveOrganiserKey, signOrganiserKeyBinding } from "@woco/shared";
import { checkOrganiserKeyBinding, type OrganiserKeyDeps } from "../src/lib/event/organiser-key.js";
import type { CurrentRing } from "../src/lib/keyring/current-ring.js";

const PARENT = "0x" + "1a".repeat(20);
const OTHER_PARENT = "0x" + "2b".repeat(20);
const KEY = deriveOrganiserKey("0x" + "ab".repeat(32));

function deps(ring: CurrentRing): OrganiserKeyDeps {
  return { currentRing: async () => ring };
}

const noRing = deps({ status: "none" });
const ringAt = (gen: number) => deps({ status: "ring", ref: "0x" + "77".repeat(32), ring: { gen } as never });

test("a binding at generation 0 passes for an account with no key ring", async () => {
  const r = await checkOrganiserKeyBinding(signOrganiserKeyBinding(KEY, PARENT, 0), PARENT, noRing);
  assert.deepEqual(r, { ok: true, key: KEY.address });
});

test("a binding at the ring's generation passes; any other generation is stale", async () => {
  assert.deepEqual(
    await checkOrganiserKeyBinding(signOrganiserKeyBinding(KEY, PARENT, 2), PARENT, ringAt(2)),
    { ok: true, key: KEY.address },
  );
  assert.deepEqual(
    await checkOrganiserKeyBinding(signOrganiserKeyBinding(KEY, PARENT, 1), PARENT, ringAt(2)),
    { ok: false, reason: "stale" },
    "a device behind registered under a key the account moved off",
  );
  assert.deepEqual(
    await checkOrganiserKeyBinding(signOrganiserKeyBinding(KEY, PARENT, 1), PARENT, noRing),
    { ok: false, reason: "stale" },
  );
});

test("the session parent is the one the binding must name", async () => {
  // A binding made for another account is replayable, but never for this one.
  const theirs = signOrganiserKeyBinding(KEY, OTHER_PARENT, 0);
  assert.deepEqual(await checkOrganiserKeyBinding(theirs, PARENT, noRing), { ok: false, reason: "invalid" });
  // A mixed-case session parent is the same account.
  assert.equal((await checkOrganiserKeyBinding(signOrganiserKeyBinding(KEY, PARENT, 0), PARENT.toUpperCase().replace("0X", "0x"), noRing)).ok, true);
});

test("missing, malformed and forged bindings are refused", async () => {
  assert.deepEqual(await checkOrganiserKeyBinding(undefined, PARENT, noRing), { ok: false, reason: "missing" });
  assert.deepEqual(await checkOrganiserKeyBinding(null, PARENT, noRing), { ok: false, reason: "missing" });
  assert.deepEqual(await checkOrganiserKeyBinding({ key: KEY.address }, PARENT, noRing), { ok: false, reason: "invalid" });
  const other = deriveOrganiserKey("0x" + "cd".repeat(32));
  const forged = { ...signOrganiserKeyBinding(KEY, PARENT, 0), key: other.address };
  assert.deepEqual(await checkOrganiserKeyBinding(forged, PARENT, noRing), { ok: false, reason: "invalid" });
});

test("an unreadable key ring refuses rather than guessing the generation", async () => {
  const r = await checkOrganiserKeyBinding(
    signOrganiserKeyBinding(KEY, PARENT, 0),
    PARENT,
    deps({ status: "unavailable", reason: "RPC error" }),
  );
  assert.deepEqual(r, { ok: false, reason: "unavailable" });
});

test("the ring is read for the session parent, never for the key", async () => {
  const seen: string[] = [];
  await checkOrganiserKeyBinding(signOrganiserKeyBinding(KEY, PARENT, 0), PARENT, {
    currentRing: async (a) => {
      seen.push(a);
      return { status: "none" };
    },
  });
  assert.deepEqual(seen, [PARENT]);
});
