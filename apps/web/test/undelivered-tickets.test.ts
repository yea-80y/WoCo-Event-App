/**
 * #983 step 4, the organiser's side of an undelivered ticket: the held copy is opened
 * HERE, with the organiser's keys, and each box must be this sale's ticket for its seat
 * before anything is sent back.
 *
 * The panel checks are TEXT checks on Svelte source (no component harness; see
 * login-surface-registration.test.ts).
 *
 * MUTATION: open under a context without the sale and "another sale's box" goes red;
 * skip the plaintext check and "a box naming another seat" goes red; drop the unlock
 * before a resend, the panel from the dashboard, or the address on the Send button and
 * the panel tests go red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deriveXWingKeypairFromSeed } from "@woco/shared/crypto/xwing";
import { openBoxJson, sealBoxJson, ticketHoldSealContext } from "@woco/shared/crypto/sealed-box";
import { openHeldTickets, type HeldCopy } from "../src/lib/creator/dashboard/held-tickets.ts";

const EVENT = "e0000000-0000-4000-8000-000000000983";
const SERIES = "s0000000-0000-4000-8000-000000000001";
const SALE = "cs_live_dash000000000001";
const OTHER = "cs_live_dash000000000002";
const KEY = deriveXWingKeypairFromSeed("0x" + "4d".repeat(32));
const OLD_KEY = deriveXWingKeypairFromSeed("0x" + "3c".repeat(32));
const qr = (e: number) => `woco://t/${EVENT}/${SERIES}/${e}/0x${"ab".repeat(65)}`;

const open = async <T>(keys: Uint8Array[], box: unknown, ctx: { info: string; aad: string }): Promise<T> => {
  let last: unknown;
  for (const k of keys) {
    try {
      return await openBoxJson<T>(k, box as never, ctx);
    } catch (e) {
      last = e;
    }
  }
  throw last;
};

async function copyOf(sessionId: string, editions: number[], pk = KEY.publicKey, plain?: (e: number) => unknown): Promise<HeldCopy> {
  return {
    eventId: EVENT,
    seriesId: SERIES,
    orderKeyRef: "ab".repeat(32),
    tickets: await Promise.all(
      editions.map(async (edition) => ({
        edition,
        box: await sealBoxJson(pk, plain ? plain(edition) : { v: 1, sessionId, seriesId: SERIES, edition, qrContent: qr(edition) }, ticketHoldSealContext(EVENT, SERIES, edition, sessionId)),
      })),
    ),
  };
}

test("the held copy opens with the organiser's keys, an older generation's too", async () => {
  const tickets = await openHeldTickets(await copyOf(SALE, [1, 2], OLD_KEY.publicKey), SALE, [KEY.secretKey, OLD_KEY.secretKey], open);
  assert.deepEqual(tickets, [{ edition: 1, qrContent: qr(1) }, { edition: 2, qrContent: qr(2) }]);
});

test("another sale's box is refused - it cannot be sent to this buyer", async () => {
  await assert.rejects(openHeldTickets(await copyOf(OTHER, [1]), SALE, [KEY.secretKey], open));
});

test("a box that opens but names another seat or sale is refused, never sent on", async () => {
  const lies = [
    (e: number) => ({ v: 1, sessionId: SALE, seriesId: SERIES, edition: e, qrContent: qr(e + 1) }),
    (e: number) => ({ v: 1, sessionId: OTHER, seriesId: SERIES, edition: e, qrContent: qr(e) }),
    (e: number) => ({ v: 1, sessionId: SALE, seriesId: SERIES, edition: e + 1, qrContent: qr(e) }),
  ];
  for (const lie of lies) {
    await assert.rejects(openHeldTickets(await copyOf(SALE, [1], KEY.publicKey, lie), SALE, [KEY.secretKey], open), /did not match/);
  }
});

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const panel = read("../src/lib/creator/dashboard/UndeliveredTickets.svelte");
const dashboard = read("../src/lib/creator/dashboard/Dashboard.svelte");
const index = read("../src/lib/creator/dashboard/DashboardIndex.svelte");

test("the panel is on every event's dashboard, and the badge on the index", () => {
  assert.match(dashboard, /<UndeliveredTickets \{eventId\} \/>/);
  assert.match(index, /undeliveredSummary\(\)/);
  assert.equal((index.match(/class="undelivered-tag"/g) ?? []).length, 2, "upcoming and past");
});

test("a resend asks the organiser to confirm it's them, and shows the exact address first", () => {
  const body = panel.slice(panel.indexOf("async function resend("));
  const unlock = body.indexOf("await auth.ensureOrganiserUnlock();");
  assert.ok(unlock > 0 && unlock < body.indexOf("resendUndelivered("), "unlock before anything is opened");
  assert.match(panel, /`Send to \$\{to\.trim\(\)\}`/);
  assert.match(panel, /Only send to an address the buyer gave you\./);
});

test("owner copy: a spaced hyphen, never an em dash", () => {
  const markup = panel.slice(panel.indexOf("</script>"), panel.indexOf("<style>"));
  assert.doesNotMatch(markup + panel.slice(0, panel.indexOf("</script>")), /—/);
});
