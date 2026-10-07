/**
 * Buyers never see a ticket's edition number (owner, 2026-10-07): its sequence
 * tells them how many tickets have sold. A group order numbers its own tickets
 * ("Ticket 2 of 4") instead. Organiser and door tools keep the real number, and
 * the edition stays inside the QR payload and the /t link, which the door needs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const BUYER_VIEWS = [
  "../src/ticket/ticket-page.ts",
  "../src/lib/attendee/passport/PassportTicket.svelte",
  "../src/lib/attendee/passport/VerifyTicket.svelte",
  "../src/lib/attendee/events/TicketSuccess.svelte",
  "../src/lib/attendee/gate/SignupLanding.svelte",
  "../../server/src/routes/tickets.ts",
  "../../server/src/lib/ticket/render-card.ts",
];

test("no buyer-facing view formats or prints the edition number", () => {
  for (const rel of BUYER_VIEWS) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf-8");
    assert.doesNotMatch(src, /padStart\(3/, `${rel}: the zero-padded edition ("#037") is back`);
    assert.doesNotMatch(src, /Ticket #|#\$\{[^}]*edition|#\{[^}]*edition/i, `${rel}: an edition is shown with a #`);
    assert.doesNotMatch(src, /of \$\{series\.totalSupply\}/, `${rel}: "N of total supply" leaks sales`);
  }
});
