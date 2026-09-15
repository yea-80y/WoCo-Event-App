/**
 * The Following list shows only live follows of accounts: an unfollow stays in
 * the index but not the list, an unreadable statement is counted rather than
 * guessed, and event subjects (likes live there) never become a row.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FOLLOW_STATEMENT_FORMAT, socialEventSubject, socialProfileSubject, type Hex0x } from "@woco/shared";
import { followsFromReads } from "../src/lib/social/follows.js";

const A = "0xabcdef1111111111111111111111111111111111" as Hex0x;
const B = "0x2222222222222222222222222222222222222222" as Hex0x;
const subjectA = socialProfileSubject(A);
const subjectB = socialProfileSubject(B);

const statement = (subject: Hex0x, value: boolean) => ({
  status: "found" as const,
  value: { format: FOLLOW_STATEMENT_FORMAT, subject, value },
});

test("a live follow is listed as the account it names", () => {
  assert.deepEqual(followsFromReads([subjectA], [statement(subjectA, true)]), { accounts: [A], unreadable: 0 });
});

test("an unfollow stays in the index but not in the list", () => {
  const result = followsFromReads([subjectA, subjectB], [statement(subjectA, false), statement(subjectB, true)]);
  assert.deepEqual(result.accounts, [B]);
});

test("a statement that cannot be read is counted, never guessed", () => {
  assert.deepEqual(followsFromReads([subjectA], [{ status: "unavailable" }]), { accounts: [], unreadable: 1 });
});

test("an absent statement is not a follow", () => {
  assert.deepEqual(followsFromReads([subjectA], [{ status: "absent" }]), { accounts: [], unreadable: 0 });
});

test("a statement about a different subject is ignored", () => {
  assert.deepEqual(followsFromReads([subjectA], [statement(subjectB, true)]).accounts, []);
});

test("a subject that is not an account never becomes a row", () => {
  const eventSubject = socialEventSubject(`0x${"ab".repeat(32)}`);
  assert.deepEqual(followsFromReads([eventSubject], [statement(eventSubject, true)]).accounts, []);
});

test("bytes that are not a follow statement are not a follow", () => {
  // Right subject, value true, but no format: foreign bytes at the topic. Only
  // schema validation stands between this and a row.
  const foreign = { status: "found" as const, value: { subject: subjectA, value: true } };
  assert.deepEqual(followsFromReads([subjectA], [foreign]), { accounts: [], unreadable: 0 });
});
