/**
 * #565's display rules for the Invited list: newest first, an unreadable
 * confirmation keeps its row but is not counted, and a confirmation naming
 * someone else is not this member's invite.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { REFERRAL_CONFIRMATION_FORMAT, type Hex0x, type ReferralConfirmationV1 } from "@woco/shared";
import { invitesFromReads, verifiedCount } from "../src/lib/campaign/invites.js";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex0x;
const SOMEONE_ELSE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Hex0x;
const R1 = "0x1111111111111111111111111111111111111111" as Hex0x;
const R2 = "0x2222222222222222222222222222222222222222" as Hex0x;
const R3 = "0x3333333333333333333333333333333333333333" as Hex0x;

function confirmed(referee: Hex0x, confirmedAt: string, referrer: Hex0x = ME): ReferralConfirmationV1 {
  return {
    format: REFERRAL_CONFIRMATION_FORMAT,
    referee,
    refereeFeed: "0xcccccccccccccccccccccccccccccccccccccccc" as Hex0x,
    referrer,
    confirmedAt,
  };
}

const ok = <T>(value: T): PromiseSettledResult<T> => ({ status: "fulfilled", value });
const failed: PromiseSettledResult<never> = { status: "rejected", reason: new Error("network") };

test("dated rows run newest first", () => {
  const rows = invitesFromReads(ME, [R1, R2, R3], [
    ok(confirmed(R1, "2026-09-01T10:00:00.000Z")),
    ok(confirmed(R2, "2026-09-12T10:00:00.000Z")),
    ok(confirmed(R3, "2026-09-05T10:00:00.000Z")),
  ]);
  assert.deepEqual(rows.map((r) => r.referee), [R2, R3, R1]);
});

test("a confirmation that fails to read keeps its row, sorts last and is not counted", () => {
  const rows = invitesFromReads(ME, [R1, R2], [failed, ok(confirmed(R2, "2026-09-12T10:00:00.000Z"))]);
  assert.deepEqual(rows.map((r) => r.referee), [R2, R1]);
  assert.equal(rows[1].confirmation, null);
  assert.equal(verifiedCount(rows), 1);
});

test("an unanswered read comes back null and is treated like a failed one", () => {
  const rows = invitesFromReads(ME, [R1], [ok(null)]);
  assert.equal(rows.length, 1);
  assert.equal(verifiedCount(rows), 0);
});

test("a confirmation naming another referrer is not this member's invite", () => {
  const rows = invitesFromReads(ME, [R1, R2], [
    ok(confirmed(R1, "2026-09-01T10:00:00.000Z", SOMEONE_ELSE)),
    ok(confirmed(R2, "2026-09-02T10:00:00.000Z")),
  ]);
  assert.deepEqual(rows.map((r) => r.referee), [R2]);
});

test("a confirmation for a different referee is not that row's", () => {
  const rows = invitesFromReads(ME, [R1], [ok(confirmed(R2, "2026-09-01T10:00:00.000Z"))]);
  assert.equal(rows.length, 0);
});

test("addresses match whatever their case", () => {
  const upperMe = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as Hex0x;
  const rows = invitesFromReads(upperMe, [R1], [ok(confirmed(R1, "2026-09-01T10:00:00.000Z"))]);
  assert.equal(verifiedCount(rows), 1);
});
