/**
 * #983: a held ticket - each emailed ticket's QR sealed to the organiser's order key,
 * so a bounced ticket can be sent again. The context is FROZEN: change a byte and
 * every copy already held stops opening.
 *
 * MUTATION: drop the edition from the AAD and "lifted to another ticket" goes red;
 * accept an edition of 0 and "refuses" goes red; let the QR check skip the event id
 * and "names this seat" goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TICKET_HOLD_SEAL_INFO,
  ORDER_SEAL_INFO,
  openBoxJson,
  orderSealContext,
  sealBoxJson,
  ticketHoldSealContext,
} from "../../src/crypto/sealed-box.js";
import { deriveXWingKeypairFromSeed } from "../../src/crypto/xwing.js";
import { isTicketHoldPlaintext, ticketQrNamesSeat, type TicketHoldPlaintext } from "../../src/event/ticket-hold.js";

const EVENT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const SERIES = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SIG = `0x${"ab".repeat(65)}`;
const qr = (edition: number, event = EVENT, series = SERIES) => `woco://t/${event}/${series}/${edition}/${SIG}`;
const KEYS = deriveXWingKeypairFromSeed("09".repeat(32));

test("FROZEN: the label and the AAD, byte for byte", () => {
  assert.equal(TICKET_HOLD_SEAL_INFO, "woco/ticket-hold/v1");
  assert.deepEqual(ticketHoldSealContext(EVENT, SERIES, 3), {
    info: "woco/ticket-hold/v1",
    aad: `woco/ticket-hold/v1:${EVENT}:${SERIES}:3`,
  });
});

test("refuses a context that could collide", () => {
  for (const [e, s, n] of [[EVENT, SERIES, 0], [EVENT, SERIES, 1.5], ["A:B", SERIES, 1], [EVENT, "x:y", 1]] as const) {
    assert.throws(() => ticketHoldSealContext(e, s, n), /malformed/);
  }
});

test("a held ticket opens under its own seat, and nowhere else", async () => {
  const plain: TicketHoldPlaintext = { v: 1, seriesId: SERIES, edition: 2, qrContent: qr(2) };
  const box = await sealBoxJson(KEYS.publicKey, plain, ticketHoldSealContext(EVENT, SERIES, 2));
  assert.deepEqual(await openBoxJson(KEYS.secretKey, box, ticketHoldSealContext(EVENT, SERIES, 2)), plain);
  // Lifted to another ticket, or read as an order: the tag fails.
  await assert.rejects(openBoxJson(KEYS.secretKey, box, ticketHoldSealContext(EVENT, SERIES, 3)));
  await assert.rejects(openBoxJson(KEYS.secretKey, box, orderSealContext(EVENT, SERIES)));
  assert.notEqual(TICKET_HOLD_SEAL_INFO, ORDER_SEAL_INFO);
});

test("the QR names this seat - event, ticket type and edition", () => {
  assert.equal(ticketQrNamesSeat(qr(2), EVENT, SERIES, 2), true);
  assert.equal(ticketQrNamesSeat(qr(3), EVENT, SERIES, 2), false);
  assert.equal(ticketQrNamesSeat(qr(2, "0e8b2c1a-0000-4000-8000-000000000000"), EVENT, SERIES, 2), false);
  assert.equal(ticketQrNamesSeat(qr(2, EVENT, "0e8b2c1a-0000-4000-8000-000000000000"), EVENT, SERIES, 2), false);
  assert.equal(ticketQrNamesSeat(`${qr(2)}x`, EVENT, SERIES, 2), false);
  assert.equal(ticketQrNamesSeat(`woco://t/${EVENT}/${SERIES}/2/0xabc`, EVENT, SERIES, 2), false, "a whole signature");
});

test("an opened box is shown only when it is this seat's held ticket", () => {
  const ok = { v: 1, seriesId: SERIES, edition: 2, qrContent: qr(2) };
  assert.equal(isTicketHoldPlaintext(ok, EVENT, SERIES, 2), true);
  assert.equal(isTicketHoldPlaintext({ ...ok, v: 2 }, EVENT, SERIES, 2), false);
  assert.equal(isTicketHoldPlaintext({ ...ok, edition: 3 }, EVENT, SERIES, 2), false);
  assert.equal(isTicketHoldPlaintext({ ...ok, qrContent: qr(3) }, EVENT, SERIES, 2), false);
  assert.equal(isTicketHoldPlaintext(null, EVENT, SERIES, 2), false);
});
