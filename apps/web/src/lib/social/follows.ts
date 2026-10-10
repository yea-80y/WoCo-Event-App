/**
 * Current follows from a subject index plus one statement read per subject.
 *
 * The index never drops an account once followed, so an unfollow is visible
 * only in the statement (`value: false`). A statement nobody could read is
 * counted and left out — never guessed either way. Pure, so the rules run
 * under the plain-tsx suite.
 */

import { addressFromProfileSubject, validateFollowStatementV1, type Hex0x } from "@woco/shared";

export type StatementRead =
  | { status: "found"; value: unknown }
  | { status: "absent" }
  | { status: "unavailable" };

export function followsFromReads(
  subjects: readonly Hex0x[],
  reads: readonly StatementRead[],
): { accounts: Hex0x[]; unreadable: number } {
  const accounts: Hex0x[] = [];
  let unreadable = 0;
  subjects.forEach((subject, i) => {
    const read = reads[i];
    if (!read || read.status === "unavailable") {
      unreadable++;
      return;
    }
    if (read.status !== "found" || !validateFollowStatementV1(read.value)) return;
    const statement = read.value as { subject: string; value: boolean };
    if (statement.value !== true) return;
    if (statement.subject.toLowerCase() !== subject.toLowerCase()) return;
    const account = addressFromProfileSubject(subject);
    if (account) accounts.push(account);
  });
  return { accounts, unreadable };
}
