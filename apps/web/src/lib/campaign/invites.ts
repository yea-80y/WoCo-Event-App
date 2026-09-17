/**
 * The Invited list's rules (#565), pure so the suite can pin them.
 *
 * Every referee in a referrer's index was confirmed first — the issuer appends
 * to the index only after writing the confirmation — so a confirmation that
 * fails to read is an unanswered read, not a missing invite. It keeps its row
 * (shown as "Couldn't check"), sorts after the dated rows, and is not counted.
 * A confirmation that names someone else is not this member's invite at all.
 */

import type { Hex0x, ReferralConfirmationV1 } from "@woco/shared";

export interface InviteRow {
  referee: Hex0x;
  /** Null when the confirmation could not be read. */
  confirmation: ReferralConfirmationV1 | null;
}

export function invitesFromReads(
  referrer: Hex0x,
  referees: readonly Hex0x[],
  reads: readonly PromiseSettledResult<ReferralConfirmationV1 | null>[],
): InviteRow[] {
  const me = referrer.toLowerCase();
  const rows: InviteRow[] = [];
  referees.forEach((referee, i) => {
    const read = reads[i];
    const confirmation = read?.status === "fulfilled" ? read.value : null;
    if (
      confirmation &&
      (confirmation.referrer.toLowerCase() !== me ||
        confirmation.referee.toLowerCase() !== referee.toLowerCase())
    ) {
      return;
    }
    rows.push({ referee, confirmation });
  });

  // `confirmedAt` is `Date#toISOString`, so string order is time order.
  return rows.sort((a, b) => {
    const at = a.confirmation?.confirmedAt;
    const bt = b.confirmation?.confirmedAt;
    if (at === bt) return 0;
    if (!at) return 1;
    if (!bt) return -1;
    return at < bt ? 1 : -1;
  });
}

/** The number shown: confirmations that actually read. */
export function verifiedCount(rows: readonly InviteRow[]): number {
  return rows.filter((row) => row.confirmation !== null).length;
}
