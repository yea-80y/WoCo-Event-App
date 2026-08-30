/**
 * Version dispatch for the event contract.
 *
 * These tests exist because the failure mode this code had was SILENT. Dispatch
 * was written as `if (version === "v2") { …v2… } else { …v1… }`, and the env
 * parser fell back to "v1" for any unrecognised string. Adding a third contract
 * therefore degraded to V1 at every call site with no error, no log, and a
 * server that looked healthy while pointed at the wrong ledger.
 *
 * The worst instance was `walkChainRegistrations`, which returns "no
 * registrations found" — and whose caller, the #318 intent resolver, treats
 * that as "not registered" and re-broadcasts, duplicating a landed on-chain
 * event. So the assertions below are mostly about things FAILING LOUDLY.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Interface, id } from "ethers";

import {
  getEventContractVersion,
  getWoCoEventAddress,
} from "../src/lib/chain/event-contract.js";
import { LEDGER_ABI } from "../src/lib/chain/event-contract-ledger.js";
import { V2_ABI } from "../src/lib/chain/event-contract-v2.js";
import { deriveEventId } from "../src/lib/event/onchain-registry.js";

const CHAIN = 421614;
const VERSION_KEY = `WOCO_EVENT_VERSION_${CHAIN}`;
const LEDGER_ADDR_KEY = `WOCO_EVENT_ADDRESS_LEDGER_${CHAIN}`;
const V2_ADDR_KEY = `WOCO_EVENT_ADDRESS_V2_${CHAIN}`;

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const k of Object.keys(vars)) saved.set(k, process.env[k]);
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("unset version defaults to v1 — an absent config may have a default", () => {
  withEnv({ [VERSION_KEY]: undefined }, () => {
    assert.equal(getEventContractVersion(CHAIN), "v1");
  });
  withEnv({ [VERSION_KEY]: "" }, () => {
    assert.equal(getEventContractVersion(CHAIN), "v1");
  });
});

test("each known version round-trips", () => {
  for (const v of ["v1", "v2", "ledger"] as const) {
    withEnv({ [VERSION_KEY]: v }, () => {
      assert.equal(getEventContractVersion(CHAIN), v);
    });
  }
});

test("an unrecognised version THROWS rather than silently falling back to v1", () => {
  // This is the regression that matters. A typo used to route every read and
  // every mint to the V1 contract while reporting success.
  for (const bad of ["v3", "V2", "ledgerr", "true", "latest"]) {
    withEnv({ [VERSION_KEY]: bad }, () => {
      assert.throws(
        () => getEventContractVersion(CHAIN),
        /is not a known contract version/,
        `"${bad}" must be rejected, not treated as v1`,
      );
    });
  }
});

test("ledger resolves its own address override, not V2's", () => {
  withEnv(
    {
      [VERSION_KEY]: "ledger",
      [LEDGER_ADDR_KEY]: "0x1111111111111111111111111111111111111111",
      [V2_ADDR_KEY]: "0x2222222222222222222222222222222222222222",
    },
    () => {
      assert.equal(
        getWoCoEventAddress(CHAIN),
        "0x1111111111111111111111111111111111111111",
      );
    },
  );
});

test("v2 still resolves its own override once the ledger literal exists", () => {
  withEnv(
    {
      [VERSION_KEY]: "v2",
      [LEDGER_ADDR_KEY]: "0x1111111111111111111111111111111111111111",
      [V2_ADDR_KEY]: "0x2222222222222222222222222222222222222222",
    },
    () => {
      assert.equal(
        getWoCoEventAddress(CHAIN),
        "0x2222222222222222222222222222222222222222",
      );
    },
  );
});

test("selecting the ledger before it is deployed yields no address, not a wrong one", () => {
  // DEPLOYED_LEDGER is empty until the contract is deployed. The correct
  // behaviour is `undefined` — every caller then throws "No WoCoEvent contract
  // deployed", which is loud. The dangerous alternative would be silently
  // handing back the V1 or V2 address.
  withEnv(
    { [VERSION_KEY]: "ledger", [LEDGER_ADDR_KEY]: undefined },
    () => {
      assert.equal(getWoCoEventAddress(CHAIN), undefined);
    },
  );
});

// ── ABI drift + cross-version receipt parsing ────────────────────────────────
//
// These two failures are invisible to the type system: a wrong ABI fragment
// compiles perfectly and fails at runtime, and parsing a receipt with the wrong
// version's fragments matches NOTHING — which the #318 resolver reads as "the
// registration never landed" and answers by broadcasting a duplicate.

test("ledger event topics match the contract signatures exactly", () => {
  // Literals transcribed once from contracts/src/WoCoTicketLedger.sol. If a
  // fragment in event-contract-ledger.ts drifts, the derived topic moves and
  // this fails in CI rather than against a live chain.
  const iface = new Interface(LEDGER_ABI as unknown as string[]);

  assert.equal(
    iface.getEvent("Registered")!.topicHash,
    id("Registered(bytes32,address,address,uint64,bytes32,uint64)"),
    "ledger Registered topic drifted from the contract",
  );
  assert.equal(
    iface.getEvent("SlotClaimed")!.topicHash,
    id("SlotClaimed(bytes32,uint256,address,address,bytes32)"),
    "ledger SlotClaimed topic drifted from the contract",
  );
});

test("SlotClaimed is byte-identical between V2 and the ledger", () => {
  // Relied on deliberately: the claim path and receipt parsing keep one shape
  // across the cutover. If this ever diverges, fulfilment needs a version split
  // it does not currently have.
  const v2 = new Interface(V2_ABI as unknown as string[]);
  const ledger = new Interface(LEDGER_ABI as unknown as string[]);
  assert.equal(
    ledger.getEvent("SlotClaimed")!.topicHash,
    v2.getEvent("SlotClaimed")!.topicHash,
  );
});

test("Registered does NOT collide across versions — a V2 receipt cannot parse as a ledger one", () => {
  const v2 = new Interface(V2_ABI as unknown as string[]);
  const ledger = new Interface(LEDGER_ABI as unknown as string[]);

  // Distinct topics is the precondition for the next assertion meaning anything.
  assert.notEqual(
    ledger.getEvent("Registered")!.topicHash,
    v2.getEvent("Registered")!.topicHash,
    "if these ever match, a V2 receipt would silently decode as a ledger one",
  );

  // Encode a real V2 Registered log, then try to read it as the ledger would.
  const eventId = "0x" + "11".repeat(32);
  const organiser = "0x" + "22".repeat(20);
  const v2Log = v2.encodeEventLog(v2.getEvent("Registered")!, [
    eventId,
    organiser,
    10n,                    // supply
    0n,                     // priceBaseUnits
    organiser,              // payoutRecipient
    "0x" + "00".repeat(20), // dropGate
    "0x" + "33".repeat(32), // manifestRef
    9_999_999_999n,         // eventEndTs
    86_400n,                // releaseDelay
  ]);

  // The ledger fragments must not match it. `parseLog` returns null on a topic
  // it does not know; either that or a throw is acceptable — silently
  // returning a decoded event would be the dangerous outcome.
  let decoded: unknown = null;
  try {
    decoded = ledger.parseLog({ topics: v2Log.topics as string[], data: v2Log.data });
  } catch {
    decoded = null;
  }
  assert.equal(decoded, null, "a V2 Registered log decoded under ledger fragments");

  // Sanity: it does parse under its own fragments, so the negative above is
  // about the version mismatch and not a malformed fixture.
  const own = v2.parseLog({ topics: v2Log.topics as string[], data: v2Log.data });
  assert.equal(own?.name, "Registered");
  assert.equal((own?.args.eventId as string).toLowerCase(), eventId);
});

// ── eventId derivation — the cross-repo drift guard ──────────────────────────
//
// The server mirrors the contract's derivation so it can walk registrations
// without a log scan. If the two drift, `walkChainRegistrations` finds NOTHING,
// which the #318 resolver reads as "never registered" and answers by
// broadcasting a DUPLICATE registration (#423).
//
// The expected values below are ground truth from Solidity tooling, not from
// this code:
//   cast keccak $(cast abi-encode "f(uint256,address,address,uint256)" \
//                 8453 0x…aa 0x…bb 7)
// Regenerate them the same way if the derivation ever legitimately changes.

test("ledger derivation matches the contract, byte for byte", () => {
  const CHAIN_ID = 8453;
  const CONTRACT = "0x00000000000000000000000000000000000000aa";
  const SPONSOR = "0x00000000000000000000000000000000000000bb";
  const NONCE = 7;

  assert.equal(
    deriveEventId("ledger", SPONSOR, NONCE, CHAIN_ID, CONTRACT),
    "0xf2e609b38f3da8e3659ebf6be0cfb7d4d6a3be2a4d46e35899a5f51ff41660d8",
    "server derivation drifted from WoCoTicketLedger.registerEvent",
  );
});

test("v2 derivation is unchanged — the old shape still walks old registrations", () => {
  assert.equal(
    deriveEventId("v2", "0x00000000000000000000000000000000000000bb", 7, 8453, "0x00000000000000000000000000000000000000aa"),
    "0xced105af4f8f301759df09f00865179865421b33cf78c95c13ea2f275fb4638b",
  );
});

test("the two derivations cannot collide — this is #423 made structural", () => {
  const SPONSOR = "0x00000000000000000000000000000000000000bb";
  const CONTRACT = "0x00000000000000000000000000000000000000aa";

  // Same sponsor, same nonce, and the ledger's counter restarting at 0 — the
  // exact condition that reproduced V2's ids before domain separation.
  for (let nonce = 0; nonce < 5; nonce++) {
    assert.notEqual(
      deriveEventId("ledger", SPONSOR, nonce, 8453, CONTRACT),
      deriveEventId("v2", SPONSOR, nonce, 8453, CONTRACT),
      `ledger and v2 produced the same id at nonce ${nonce}`,
    );
  }
});

test("ledger ids differ across chains and across contracts", () => {
  const SPONSOR = "0x00000000000000000000000000000000000000bb";
  const A = "0x00000000000000000000000000000000000000aa";
  const B = "0x00000000000000000000000000000000000000cc";

  assert.notEqual(
    deriveEventId("ledger", SPONSOR, 0, 8453, A),
    deriveEventId("ledger", SPONSOR, 0, 42161, A),
    "chainId does not participate",
  );
  assert.notEqual(
    deriveEventId("ledger", SPONSOR, 0, 8453, A),
    deriveEventId("ledger", SPONSOR, 0, 8453, B),
    "contract address does not participate",
  );
});

test("v1 is never walked, and says so rather than guessing a shape", () => {
  assert.throws(
    () => deriveEventId("v1", "0x00000000000000000000000000000000000000bb", 0, 8453, "0x00000000000000000000000000000000000000aa"),
    /not walked/,
  );
});
