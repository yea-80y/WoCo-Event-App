/**
 * Reading who owns a name (#488).
 *
 * `getLabelOwner` used to answer null for EVERY failure, so a timeout, a 429 or
 * a connection reset was indistinguishable from "this label was never minted".
 * Every caller reads null as "not registered", which turned an RPC blip into a
 * 404/403 on a real holder's own name and into `reason: "not_owner"` on a site
 * deploy — the platform telling an organiser they lost a name they still hold.
 *
 * The property pinned here: null is DEFINITIVE. It is returned only for the one
 * revert that means the token does not exist, decoded BY NAME; everything else
 * propagates so the caller can answer "unverified". The ladder that turns those
 * three outcomes into HTTP lives in `refuseUnlessOwner`, tested with an injected
 * read, and the wiring is held by source pins — the regression that happens here
 * is a route quietly going back to its own inline check, not a bad comparison.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isNonexistentTokenRevert, ownerOrNull } from "../src/lib/chain/sub-ens-contract.js";
import { refuseUnlessOwner } from "../src/routes/sub-ens.js";

const OWNER = "0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd";

function nonexistentRevert() {
  return { code: "CALL_EXCEPTION", revert: { name: "ERC721NonexistentToken", args: [1n] } };
}

// ---------------------------------------------------------------------------
// isNonexistentTokenRevert — the ONE failure that means absence
// ---------------------------------------------------------------------------

test("the decoded ERC721NonexistentToken revert is recognised", () => {
  assert.equal(isNonexistentTokenRevert(nonexistentRevert()), true);
});

test("nothing else is: transport failures are not absence", () => {
  for (const err of [
    { code: "NETWORK_ERROR" },
    { code: "TIMEOUT" },
    { code: "SERVER_ERROR" },
    new Error("ECONNRESET"),
    undefined,
  ]) {
    assert.equal(isNonexistentTokenRevert(err), false, `read as absence: ${JSON.stringify(err)}`);
  }
});

test("an UNDECODABLE revert is not absence — no revert data is not proof of no token", () => {
  // What a provider returns when it stripped the revert data, or when there is
  // no code at the address we called. Both are misconfiguration or outage.
  assert.equal(isNonexistentTokenRevert({ code: "CALL_EXCEPTION", revert: null }), false);
});

test("a DIFFERENT decoded revert is not absence either", () => {
  assert.equal(
    isNonexistentTokenRevert({ code: "CALL_EXCEPTION", revert: { name: "SomethingElse" } }),
    false,
  );
});

// ---------------------------------------------------------------------------
// ownerOrNull — null is definitive, everything else propagates
// ---------------------------------------------------------------------------

test("an owner comes back lowercased", async () => {
  assert.equal(await ownerOrNull(async () => OWNER), OWNER.toLowerCase());
});

test("the nonexistent-token revert is the only path to null", async () => {
  assert.equal(await ownerOrNull(async () => { throw nonexistentRevert(); }), null);
});

test("a network failure REJECTS with the same error, so a caller cannot mistake it for absence", async () => {
  const boom = Object.assign(new Error("could not detect network"), { code: "NETWORK_ERROR" });
  await assert.rejects(
    () => ownerOrNull(async () => { throw boom; }),
    (err: unknown) => {
      assert.equal(err, boom, "the original error must survive, not a null");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// refuseUnlessOwner — the three refusals, kept apart
// ---------------------------------------------------------------------------

const SENTINEL = { sentinel: true } as unknown as Response;

function fakeContext() {
  const calls: { body: unknown; status: number }[] = [];
  return {
    calls,
    c: {
      json: (body: unknown, status: number) => {
        calls.push({ body, status });
        return SENTINEL;
      },
    },
  };
}

test("a read that did not answer is 502 'unverified', NOT 404 or 403", async () => {
  const { c, calls } = fakeContext();
  const refused = await refuseUnlessOwner(c, "punkpub", OWNER, async () => {
    throw Object.assign(new Error("timeout"), { code: "TIMEOUT" });
  });
  assert.equal(refused, SENTINEL);
  assert.deepEqual(calls, [{ body: { ok: false, error: "ownership_unverified" }, status: 502 }]);
});

test("a definitively unregistered label is 404", async () => {
  const { c, calls } = fakeContext();
  const refused = await refuseUnlessOwner(c, "punkpub", OWNER, async () => null);
  assert.equal(refused, SENTINEL);
  assert.deepEqual(calls, [{ body: { ok: false, error: "label not found" }, status: 404 }]);
});

test("somebody else's name is 403", async () => {
  const { c, calls } = fakeContext();
  const refused = await refuseUnlessOwner(
    c, "punkpub", OWNER,
    async () => "0x1111111111111111111111111111111111111111",
  );
  assert.equal(refused, SENTINEL);
  assert.deepEqual(calls, [{ body: { ok: false, error: "not authorised for this label" }, status: 403 }]);
});

test("the owner proceeds, whatever case the verified parent arrived in", async () => {
  const { c, calls } = fakeContext();
  const refused = await refuseUnlessOwner(c, "punkpub", OWNER, async () => OWNER.toLowerCase());
  assert.equal(refused, null, "null means proceed");
  assert.deepEqual(calls, [], "no refusal is written for the owner");
});

// ---------------------------------------------------------------------------
// Source guards — the wiring, not the comparison
// ---------------------------------------------------------------------------

function sourceOf(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
}

const ROUTE = sourceOf("../src/routes/sub-ens.ts");
const CHAIN = sourceOf("../src/lib/chain/sub-ens-contract.ts");

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("every mutation route goes through the shared gate, not its own inline check", () => {
  // The one remaining direct read is /check, which already answers 500 from its
  // own try/catch and must keep doing so — it is a public read, not a gate.
  assert.equal(
    occurrences(ROUTE, "await getLabelOwner("), 1,
    "a route grew its own ownership read again",
  );
  assert.ok(
    occurrences(ROUTE, "refuseUnlessOwner(c,") >= 3,
    "stamp-event, set-contenthash and relay-release must all use the gate",
  );
});

test("getLabelOwner swallows nothing — no bare catch in its body", () => {
  const start = CHAIN.indexOf("export async function getLabelOwner");
  assert.ok(start > 0, "getLabelOwner not found");
  const next = CHAIN.indexOf("\nexport ", start + 10);
  const body = CHAIN.slice(start, next > 0 ? next : undefined);
  assert.ok(
    !body.includes("catch {"),
    "a bare catch here is the #488 defect: it turns an outage back into 'unregistered'",
  );
});
