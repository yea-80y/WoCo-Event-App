/**
 * The pieces around the ledger2 relay: the end memo that stops being "forever" on
 * ledger2 (#995), the chain-cancellation watch the sale path feeds, the relay key's
 * boot check, the batch's log reading, and the health section's inert / active split.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import {
  LEDGER2_END_TTL_MS,
  _resetChainEndMemoForTests,
  chainEventEndMsAt,
  invalidateChainEnd,
} from "../src/lib/event/end-date-guard.js";
import {
  _resetChainCancelledForTests,
  chainCancelledUnrecorded,
  noteChainCancelled,
} from "../src/lib/event/ledger2-sale-status.js";
import { landedLogs, ledger2RelayIface, relayKeyConflict } from "../src/lib/chain/ledger2-relay-chain.js";
import { ledger2RelayHealth, _resetLedger2RelayHealthForTests } from "../src/lib/health/ledger2-relay-health.js";
import type { EventContractTarget } from "../src/lib/chain/event-contract.js";

const LEDGER2: EventContractTarget = { chainId: 42161, address: "0x00000000000000000000000000000000000000aa", version: "ledger2" };
const LEDGER1: EventContractTarget = { chainId: 42161, address: "0x00000000000000000000000000000000000000bb", version: "ledger" };
const ID = `0x${"0a".repeat(32)}`;

beforeEach(() => {
  _resetChainEndMemoForTests();
  _resetChainCancelledForTests();
});

test("#995: a ledger2 end is remembered for a minute, an earlier version's for good", async () => {
  let reads = 0;
  let end = 1_900_000_000;
  const read = async () => {
    reads++;
    return end;
  };
  const t0 = 1_000_000;
  assert.equal(await chainEventEndMsAt(LEDGER2, ID, read, t0), end * 1000);
  end += 3600;
  assert.equal(await chainEventEndMsAt(LEDGER2, ID, read, t0 + LEDGER2_END_TTL_MS - 1), (end - 3600) * 1000, "inside the minute");
  assert.equal(await chainEventEndMsAt(LEDGER2, ID, read, t0 + LEDGER2_END_TTL_MS), end * 1000, "re-read after it");
  assert.equal(reads, 2);

  reads = 0;
  await chainEventEndMsAt(LEDGER1, ID, read, t0);
  await chainEventEndMsAt(LEDGER1, ID, read, t0 + 365 * 86_400_000);
  assert.equal(reads, 1, "immutable ends stay memoized");
});

test("#995: our relay landing an extension drops the memo at once", async () => {
  let end = 1_900_000_000;
  const read = async () => end;
  const t0 = 1_000_000;
  await chainEventEndMsAt(LEDGER2, ID, read, t0);
  end += 86_400;
  invalidateChainEnd(LEDGER2, ID.toUpperCase().replace("0X", "0x"));
  assert.equal(await chainEventEndMsAt(LEDGER2, ID, read, t0 + 1), end * 1000);
});

test("a chain cancellation the server has not recorded is listed until it is", () => {
  noteChainCancelled("evt-1", ID);
  noteChainCancelled("evt-1", ID);
  noteChainCancelled("evt-2", `0x${"0b".repeat(32)}`);
  assert.equal(chainCancelledUnrecorded(() => "open").length, 2, "noted once each");
  assert.equal(chainCancelledUnrecorded(() => "unknown").length, 2, "an unreadable record resolves nothing");
  assert.deepEqual(chainCancelledUnrecorded((e) => (e === "evt-1" ? "cancelled" : "open")).map((x) => x.eventId), ["evt-2"]);
  assert.equal(chainCancelledUnrecorded(() => "open").length, 1, "a confirmed one leaves for good");
});

test("the relay key must be a key of its own", () => {
  const k = Wallet.createRandom().privateKey;
  const other = Wallet.createRandom().privateKey;
  assert.equal(relayKeyConflict({}), null, "unset = relay off, not a conflict");
  assert.equal(relayKeyConflict({ LEDGER2_RELAY_PRIVATE_KEY: k, WOCO_SPONSOR_PRIVATE_KEY: other }), null);
  for (const name of ["WOCO_SPONSOR_PRIVATE_KEY", "ATTENDEE_STAMPER_PRIVATE_KEY", "SUB_ENS_SPONSOR_PRIVATE_KEY", "FEED_PRIVATE_KEY"]) {
    assert.match(relayKeyConflict({ LEDGER2_RELAY_PRIVATE_KEY: k, [name]: k }) ?? "", new RegExp(name));
  }
  // The same key without its 0x prefix is still the same key.
  assert.match(relayKeyConflict({ LEDGER2_RELAY_PRIVATE_KEY: k, FEED_PRIVATE_KEY: k.slice(2) }) ?? "", /FEED_PRIVATE_KEY/);
  assert.match(relayKeyConflict({ LEDGER2_RELAY_PRIVATE_KEY: "nope" }) ?? "", /not a valid/);
});

test("landed logs: only the ledger's own, in order", () => {
  const log = (name: string, args: unknown[], address = LEDGER2.address) => {
    const l = ledger2RelayIface.encodeEventLog(name, args);
    return { address, topics: l.topics, data: l.data };
  };
  const logs = [
    log("SupplySet", [ID, 1n, 2n]),
    log("SupplySet", [ID, 1n, 2n], "0x00000000000000000000000000000000000000cc"),
    log("SlotReseated", [ID, 7n, 1n, 2n]),
    { address: LEDGER2.address, topics: ["0x" + "00".repeat(32)], data: "0x" },
  ];
  assert.deepEqual(landedLogs(LEDGER2.address, logs), [
    { name: "SupplySet", eventId: ID },
    { name: "SlotReseated", eventId: ID, slot: 7 },
  ]);
});

test("health: green and inactive while no ledger2 is deployed; red once one is and the key is missing", () => {
  _resetLedger2RelayHealthForTests();
  const saved = { ...process.env };
  try {
    process.env.WOCO_EVENT_CHAIN_ID = "42161";
    delete process.env.WOCO_EVENT_ADDRESS_LEDGER2_42161;
    delete process.env.LEDGER2_RELAY_PRIVATE_KEY;
    const idle = ledger2RelayHealth();
    assert.equal(idle.active, false);
    assert.equal(idle.ok, true);

    process.env.WOCO_EVENT_ADDRESS_LEDGER2_42161 = LEDGER2.address;
    const live = ledger2RelayHealth();
    assert.equal(live.active, true);
    assert.equal(live.ok, false);
    assert.match(live.checks.key.reason ?? "", /LEDGER2_RELAY_PRIVATE_KEY/);

    process.env.LEDGER2_RELAY_PRIVATE_KEY = Wallet.createRandom().privateKey;
    const unread = ledger2RelayHealth();
    assert.equal(unread.checks.key.ok, true);
    assert.equal(unread.ok, null, "not read yet is unknown, not red");

    noteChainCancelled("evt-9", ID);
    delete process.env.WOCO_EVENT_ADDRESS_LEDGER2_42161;
    const idleButCancelled = ledger2RelayHealth();
    assert.equal(idleButCancelled.ok, false, "a chain-cancelled event still on sale is red even when idle");
  } finally {
    process.env = saved;
  }
});
