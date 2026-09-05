/**
 * The gasless name claim's sponsor fallback (#487).
 *
 * Two properties, both about a path that fires only when something else has
 * already gone wrong — which is why neither defect was visible in use:
 *
 *   1. The fallback mints the SAME NAME WITH THE SAME CONTENT. It listed its
 *      arguments by hand and left out `swarmHash`, so a passkey organiser's
 *      site deploy — which always passes one — minted a name pointing nowhere.
 *      The arguments are now DERIVED from the claim, minus `kernelAddress`, so
 *      a field added later cannot be silently dropped here.
 *   2. It fires ONLY for an account-abstraction failure. The classifier
 *      lowercased the needle "AA" and substring-matched it, so any message
 *      carrying a tx hash or an address ("0x…aa91…") matched by chance and a
 *      non-AA failure was quietly retried on the sponsor rail.
 *
 * Imported from `sub-ens-permit.ts` rather than `sub-ens.ts`: the latter
 * statically imports the API client, which reaches the runes auth store and
 * `import.meta.env`, neither of which runs under tsx. Same split, same reason,
 * as `sub-ens-resolve.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claimSubEnsViaPermitWith,
  isAccountAbstractionFailure,
  type SubEnsPermitDeps,
} from "../src/lib/api/sub-ens-permit.js";

const SWARM = "ab".repeat(32);

const PERMIT = {
  ok: true,
  data: {
    label: "nabil",
    ensName: "nabil.woco.eth",
    sig: "0xsig",
    expiry: 1_800_000_000,
    chainId: 421614,
    registrarAddress: "0x42c6464d000000000000000000000000000000d6",
  },
};

const OPTS = {
  label: "nabil",
  kernelAddress: "0xk000000000000000000000000000000000000000",
  description: "d",
  avatar: "a",
  swarmHash: SWARM,
};

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

test("an EntryPoint AA code is an account-abstraction failure", () => {
  assert.equal(isAccountAbstractionFailure(new Error("AA21 didn't pay prefund")), true);
  assert.equal(isAccountAbstractionFailure(new Error("UserOperation reverted")), true);
  assert.equal(isAccountAbstractionFailure(new Error("paymaster rejected")), true);
});

test("a hex blob that happens to contain 'aa' is NOT one", () => {
  // The #487 nit: "AA" lowercased and substring-matched hits any tx hash or
  // address with those two characters in it.
  assert.equal(isAccountAbstractionFailure(new Error("execution reverted: 0x8aa3...aa91")), false);
});

test("the code is anchored: two digits, uppercase, on a word boundary", () => {
  assert.equal(isAccountAbstractionFailure(new Error("AAA")), false);
  assert.equal(isAccountAbstractionFailure(new Error("aa33")), false);
  assert.equal(isAccountAbstractionFailure(new Error("label already taken")), false);
});

// ---------------------------------------------------------------------------
// The fallback
// ---------------------------------------------------------------------------

function deps(over: Partial<SubEnsPermitDeps> = {}): SubEnsPermitDeps & {
  sponsorCalls: unknown[];
} {
  const sponsorCalls: unknown[] = [];
  return {
    sponsorCalls,
    fetchPermit: async () => PERMIT,
    register: async () => ({ txHash: "0xtx" }),
    sponsorClaim: async (args) => {
      sponsorCalls.push(args);
      return { ok: true, data: { label: "nabil", ensName: "nabil.woco.eth", txHash: "0xsponsored" } };
    },
    ...over,
  };
}

test("the sponsor fallback carries EVERY claim field over, swarmHash included", async () => {
  const d = deps({
    register: async () => { throw new Error("AA21 didn't pay prefund"); },
  });
  const res = await claimSubEnsViaPermitWith(OPTS, d);

  assert.equal(d.sponsorCalls.length, 1, "the sponsor path runs exactly once");
  assert.deepEqual(
    d.sponsorCalls[0],
    { label: "nabil", description: "d", avatar: "a", swarmHash: SWARM },
    "a dropped field here mints a name pointing nowhere",
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(d.sponsorCalls[0], "kernelAddress"),
    "kernelAddress is the gasless sender — the sponsor mints to the verified parent",
  );
  assert.equal(res.ok, true);
});

test("a failure that is NOT account abstraction is reported, never retried on the sponsor rail", async () => {
  const d = deps({
    register: async () => { throw new Error("reverted: 0xaa…"); },
  });
  const res = await claimSubEnsViaPermitWith(OPTS, d);

  assert.deepEqual(d.sponsorCalls, [], "the sponsor wallet must not pay for someone else's bug");
  assert.deepEqual(res, { ok: false, error: "reverted: 0xaa…" });
});

test("the gasless path succeeding never touches the sponsor", async () => {
  const d = deps();
  const res = await claimSubEnsViaPermitWith(OPTS, d);

  assert.deepEqual(d.sponsorCalls, []);
  assert.deepEqual(res, {
    ok: true,
    data: { label: "nabil", ensName: "nabil.woco.eth", txHash: "0xtx" },
  });
});

test("the gasless submit gets the swarmHash too — the claim only has one source", async () => {
  let seen: { swarmHash?: string } | undefined;
  const d = deps({
    register: async (args) => { seen = args; return { txHash: "0xtx" }; },
  });
  await claimSubEnsViaPermitWith(OPTS, d);
  assert.equal(seen?.swarmHash, SWARM);
});

test("a refused permit stops before either rail", async () => {
  const d = deps({ fetchPermit: async () => ({ ok: false, error: "ticket_required" }) });
  const res = await claimSubEnsViaPermitWith(OPTS, d);
  assert.deepEqual(res, { ok: false, error: "ticket_required" });
  assert.deepEqual(d.sponsorCalls, []);
});
