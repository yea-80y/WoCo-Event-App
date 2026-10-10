/**
 * The door's `refunded` verdict (#645 part C).
 *
 * A refunded ticket is still a genuine ticket on chain — the contract has no
 * per-slot void — so the pack's `voidSlots` is what turns it away. The order of
 * checks is the property: owner and signature FIRST, the refund list after. A
 * forged QR for a refunded slot must read `invalid`, never `refunded`: only a
 * real ticket can be told "refunded", and a pack listing a slot can never make
 * a forgery pass.
 *
 * Real signatures from a real burner key, verified by the real verifier.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildTicketCanonicalMessage, type CheckinPack } from "@woco/shared";
import { verifyTicket } from "../src/lib/scanner/verify.js";

const EVENT_ID = "evt-refund-door";
const SERIES_ID = "ser-1";
const ON_CHAIN_EVENT_ID = ("0x" + "ab".repeat(32)) as `0x${string}`;

const burners = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())];
const stranger = privateKeyToAccount(generatePrivateKey());

async function qr(edition: number, signer = burners[edition - 1]): Promise<string> {
  const sig = await signer.signMessage({
    message: buildTicketCanonicalMessage({ onChainEventId: ON_CHAIN_EVENT_ID, seriesId: SERIES_ID, edition }),
  });
  return `woco://t/${EVENT_ID}/${SERIES_ID}/${edition}/${sig}`;
}

function pack(voidSlots?: number[]): CheckinPack {
  return {
    v: 1,
    eventId: EVENT_ID,
    eventTitle: "Door test",
    series: [
      {
        seriesId: SERIES_ID,
        name: "General",
        totalSupply: 10,
        onChainEventId: ON_CHAIN_EVENT_ID,
        slotOwners: burners.map((b) => b.address.toLowerCase()),
        ...(voidSlots ? { voidSlots } : {}),
      },
    ],
    checkins: [],
    generatedAt: "2026-09-26T00:00:00.000Z",
  };
}

test("a genuine ticket whose slot is void reads refunded", async () => {
  const v = await verifyTicket(await qr(1), pack([0]));
  assert.equal(v.status, "refunded");
  assert.equal(v.status === "refunded" && v.seriesName, "General");
});

test("the refund is per slot: the next ticket in the same pack still admits", async () => {
  const v = await verifyTicket(await qr(2), pack([0]));
  assert.equal(v.status, "valid");
});

test("a FORGED ticket for a void slot reads invalid, not refunded", async () => {
  const v = await verifyTicket(await qr(1, stranger), pack([0]));
  assert.equal(v.status, "invalid");
});

test("a void slot nobody was ever issued stays invalid", async () => {
  const v = await verifyTicket(await qr(3, stranger), pack([2]));
  assert.equal(v.status, "invalid");
});

test("a pack built before voidSlots existed admits as before", async () => {
  const v = await verifyTicket(await qr(1), pack());
  assert.equal(v.status, "valid");
});
