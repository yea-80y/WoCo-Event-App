/**
 * The scanner store with door entries wired in (phase 2 of the live door list): the
 * real store, real IndexedDB (fake), real sealing, a fake server. New buyers appear
 * on the Attendees list with nothing for the organiser to do.
 *
 * MUTATION (each goes red here): drop the pass check after a reply and "a reply
 * after the tab switched" goes red; drop the door entries clear in `putPass` or the
 * in-memory reset in `provision` and "a new pass starts again" goes red; drop the
 * `putUnderPass` token check and "storage never takes a reply for a replaced pass"
 * goes red; let `findAttendee` read the roster alone and the tombstone case goes red;
 * treat a 503 as dead and "503 keeps the list" goes red; never (or always) set the
 * warning and the key check goes red; stop after one page and the cursor test goes
 * red; restore nothing on open and "survives a reload" goes red. The jti check in
 * `restoreDoorEntries` is held by `scanner-door-entries.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildTicketCanonicalMessage, type RosterEntry } from "@woco/shared";
import { doorEntriesKeypair } from "@woco/shared/checkin/door-entries-key";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  db,
  EntriesLog,
  fakeDocument,
  makePass,
  okSync,
  openTab,
  packFor,
  removeCompiledStore,
  resetWorld,
  server,
  seriesId,
  storeEvent,
  waitFor,
  type Handler,
} from "./scanner-store-harness.ts";

test.after(removeCompiledStore);
test.beforeEach(resetWorld);

const A = "event-a";
const B = "event-b";
const JTI_A = "a".repeat(32);
const JTI_B = "b".repeat(32);
const key = (eventId: string, edition: number) => `${seriesId(eventId)} ${edition}`;
const names = (list: RosterEntry[]) =>
  list.map((r) => `${r.edition}:${r.name ?? ""}:${r.source ?? "roster"}`).sort();
const entriesRequests = () => server.requests.filter((r) => r.url.pathname.endsWith("/entries"));

/** Holds every entries reply until released; `reached` resolves when one is waiting. */
function holdEntries(inner: Handler) {
  let release!: () => void;
  let arrive!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (arrive = r));
  server.handlers.set("/entries", async (url, init) => {
    arrive();
    await held;
    return inner(url, init);
  });
  return { reached, release };
}

test("polling applies each page, follows the cursor while the server says more, and sends the pass and device", async (t) => {
  const pass = makePass(A, JTI_A);
  await storeEvent(pass);
  const log = new EntriesLog(pass);
  for (const e of [1, 2, 3]) await log.add(e);
  server.handlers.set("/entries", log.handler(2));
  server.handlers.set("/sync", okSync);

  const scanner = await openTab(t);
  await scanner.init(); // boots into the one event on the phone, with this phone's device id
  assert.equal(scanner.pass?.eventId, A);
  await scanner.refreshDoorEntries();

  assert.deepEqual(entriesRequests().map((r) => r.url.searchParams.get("since")), ["0", "2"], "page two asked for after page one's cursor");
  const sent = entriesRequests()[0].headers;
  assert.equal(sent["X-Door-Pass"], pass.token);
  assert.match(sent["X-Scanner-Device"] ?? "", /^[A-Za-z0-9_-]{8,64}$/);
  assert.deepEqual(names(scanner.attendees), ["1:Card Holder 1:sale", "2:Card Holder 2:sale", "3:Card Holder 3:sale"]);
  assert.equal(scanner.findAttendee(seriesId(A), 2)?.email, "buyer2@example.com");
  assert.equal(scanner.doorEntries.next, 3);

  await log.add(4);
  await scanner.refreshDoorEntries();
  assert.equal(entriesRequests().at(-1)?.url.searchParams.get("since"), "3", "the next tick starts at the cursor");
  assert.equal(scanner.attendees.length, 4);
});

test("on the pack refresh tick, door entries are fetched after the pack", async (t) => {
  const pass = makePass(A, JTI_A);
  await storeEvent(pass);
  const log = await new EntriesLog(pass).add(1);
  let packAt = -1;
  server.handlers.set("/pack", () => {
    packAt = server.requests.length;
    return Response.json({ ok: true, data: packFor(A) });
  });
  server.handlers.set("/entries", log.handler());
  server.handlers.set("/sync", okSync);
  fakeDocument.visibilityState = "visible";

  const scanner = await openTab(t);
  await scanner.openEvent(A); // opening runs the refresh at once
  await waitFor(() => scanner.attendees.length > 0);
  const at = server.requests.findIndex((r) => r.url.pathname.endsWith("/entries"));
  assert.ok(packAt > 0 && at >= packAt, "entries asked for once the pack came back");
  assert.equal(scanner.attendees.length, 1);
});

test("the list survives a reload: a new tab opens with the entries already on the phone", async (t) => {
  const pass = makePass(A, JTI_A);
  await storeEvent(pass);
  const log = await (await new EntriesLog(pass).add(1)).add(2);
  server.handlers.set("/entries", log.handler());
  const first = await openTab(t);
  await first.openEvent(A);
  await first.refreshDoorEntries();

  server.handlers.clear(); // offline after the reload
  const reloaded = await openTab(t);
  await reloaded.openEvent(A);
  assert.deepEqual(names(reloaded.attendees), ["1:Card Holder 1:sale", "2:Card Holder 2:sale"]);
  assert.equal(reloaded.doorEntries.next, 2, "and polls on from where it was");
});

test("a new pass for the event starts the list again, in memory and on the phone", async (t) => {
  const old = makePass(A, JTI_A);
  await storeEvent(old);
  server.handlers.set("/entries", (await new EntriesLog(old).add(1)).handler());
  const scanner = await openTab(t);
  await scanner.openEvent(A);
  await scanner.refreshDoorEntries();
  assert.equal(scanner.attendees.length, 1);

  const fresh = makePass(A, JTI_B);
  server.handlers.set("/pack", () => Response.json({ ok: true, data: packFor(A) }));
  server.handlers.set("/entries", () => new Promise<Response>(() => {})); // the new log is not read in this test
  assert.equal(await scanner.provision(fresh.token, fresh.keyB64url), true);
  assert.equal(scanner.attendees.length, 0, "nothing opened under the old pass is shown");
  assert.equal(await db.getDoorEntries(A), undefined, "nor kept on the phone");

  const reloaded = await openTab(t);
  await reloaded.openEvent(A);
  assert.equal(reloaded.attendees.length, 0);
});

test("a list stored under an older pass is never restored under a newer one", async (t) => {
  const old = makePass(A, JTI_A);
  await storeEvent(old);
  server.handlers.set("/entries", (await new EntriesLog(old).add(1)).handler());
  const first = await openTab(t);
  await first.openEvent(A);
  await first.refreshDoorEntries();
  const stored = await db.getDoorEntries(A);
  assert.equal(stored?.jti, JTI_A);

  // Another tab sets up a new pass; this storage still holds the old pass's list.
  const fresh = makePass(A, JTI_B);
  await db.putPass({ token: fresh.token, keyB64url: fresh.keyB64url, eventId: A, exp: fresh.exp });
  assert.equal(await db.getDoorEntries(A), undefined, "a new pass clears the old list");
  const restored = await openTab(t);
  server.handlers.clear();
  await restored.openEvent(A);
  assert.equal(restored.attendees.length, 0);
});

test("an erased order hides the ticket from the sale entries AND from the organiser's roster; the organiser's entry beats a sale's", async (t) => {
  const pass = makePass(A, JTI_A);
  await storeEvent(pass);
  await db.putRoster(A, [
    { seriesId: seriesId(A), edition: 1, name: "Erased Guest" },
    { seriesId: seriesId(A), edition: 2, name: "Organiser's Answer" },
  ]);
  const log = new EntriesLog(pass);
  await log.add(2, { buyerName: "Payer Of Two" });
  await log.add(3);
  log.remove(1);
  log.remove(3);
  server.handlers.set("/entries", log.handler());

  const scanner = await openTab(t);
  await scanner.openEvent(A);
  await scanner.refreshDoorEntries();
  assert.deepEqual(names(scanner.attendees), ["2:Organiser's Answer:roster"]);
  assert.equal(scanner.findAttendee(seriesId(A), 1), undefined, "the organiser's roster entry for an erased order is hidden");
  assert.equal(scanner.findAttendee(seriesId(A), 3), undefined, "and the sale entry");
  assert.equal(scanner.findAttendee(seriesId(A), 2)?.name, "Organiser's Answer");
  assert.ok(scanner.doorEntries.tombstones.has(key(A, 1)));
});

test("a reply that arrives after the tab switched event is dropped, shown nowhere and not stored", async (t) => {
  const a = makePass(A, JTI_A);
  const b = makePass(B, JTI_B);
  await storeEvent(a);
  await storeEvent(b);
  const scanner = await openTab(t);
  await scanner.openEvent(A);
  const gate = holdEntries((await new EntriesLog(a).add(1)).handler());
  const polling = scanner.refreshDoorEntries();
  await gate.reached;
  await scanner.switchTo(B);
  gate.release();
  await polling;

  assert.equal(scanner.pass?.eventId, B);
  assert.equal(scanner.attendees.length, 0, "event-a's buyer never appears at event-b's door");
  assert.equal(await db.getDoorEntries(A), undefined);
  assert.equal(await db.getDoorEntries(B), undefined);
});

test("a reply for a pass another tab has since replaced is never stored over the new pass", async (t) => {
  const old = makePass(A, JTI_A);
  await storeEvent(old);
  const scanner = await openTab(t);
  await scanner.openEvent(A);
  const gate = holdEntries((await new EntriesLog(old).add(1)).handler());
  const polling = scanner.refreshDoorEntries();
  await gate.reached;
  const fresh = makePass(A, JTI_B);
  await db.putPass({ token: fresh.token, keyB64url: fresh.keyB64url, eventId: A, exp: fresh.exp }); // the other tab
  gate.release();
  await polling;

  assert.equal(await db.getDoorEntries(A), undefined, "storage takes it only while that pass is the stored one");
  assert.equal(await db.putDoorEntries(A, old.token, { jti: JTI_A, next: 1, entries: [], tombstones: [] }), false);
  assert.equal(await db.putDoorEntries(A, fresh.token, { jti: JTI_B, next: 0, entries: [], tombstones: [] }), true);
});

test("a refused pass (401) is marked dead as sync does; a 503 or no signal keeps the list", async (t) => {
  const pass = makePass(A, JTI_A);
  await storeEvent(pass);
  const log = await new EntriesLog(pass).add(1);
  server.handlers.set("/entries", log.handler());
  const scanner = await openTab(t);
  await scanner.openEvent(A);
  await scanner.refreshDoorEntries();
  assert.equal(scanner.attendees.length, 1);

  server.handlers.set("/entries", () => Response.json({ ok: false, error: "New buyers can't be listed right now - scanning still works" }, { status: 503 }));
  await scanner.refreshDoorEntries();
  assert.equal(scanner.attendees.length, 1, "503: the list stays");
  assert.equal(scanner.passDead, null);
  server.handlers.delete("/entries");
  await scanner.refreshDoorEntries();
  assert.equal(scanner.attendees.length, 1, "no signal: the list stays");
  assert.equal(scanner.passDead, null);
  assert.equal((await db.getDoorEntries(A))?.entries.length, 1);

  server.handlers.set("/entries", () => Response.json({ ok: false, error: "Door pass revoked — ask the organiser for a new one", reason: "revoked" }, { status: 401 }));
  await scanner.refreshDoorEntries();
  assert.equal(scanner.passDead, "Door pass revoked — ask the organiser for a new one");
  assert.equal((await db.getPass(A))?.dead, "Door pass revoked — ask the organiser for a new one");
  const asked = entriesRequests().length;
  await scanner.refreshDoorEntries();
  assert.equal(entriesRequests().length, asked, "a dead pass asks for nothing more");
});

test("the key check: a server sealing to another key shows the warning; the right key shows none", async (t) => {
  const pass = makePass(A, JTI_A);
  await storeEvent(pass);
  const other = doorEntriesKeypair(crypto.getRandomValues(new Uint8Array(32))).publicKey;
  const wrong = await new EntriesLog(pass, other).add(1);
  server.handlers.set("/entries", wrong.handler());
  const scanner = await openTab(t);
  await scanner.openEvent(A);
  await scanner.refreshDoorEntries();
  assert.equal(scanner.doorKeyMismatch, true);
  assert.equal(scanner.attendees.length, 0, "and nothing sealed to that key opens");

  const right = makePass(B, JTI_B);
  await storeEvent(right);
  server.handlers.set("/entries", (await new EntriesLog(right).add(1)).handler());
  await scanner.switchTo(B);
  assert.equal(scanner.doorKeyMismatch, false, "switching clears it");
  await scanner.refreshDoorEntries();
  assert.equal(scanner.doorKeyMismatch, false);
  assert.equal(scanner.attendees.length, 1);
});

test("a page with nothing to open runs no key check, so it never loads the lattice code", async (t) => {
  const pass = makePass(A, JTI_A);
  await storeEvent(pass);
  const other = doorEntriesKeypair(crypto.getRandomValues(new Uint8Array(32))).publicKey;
  const onlyRemovals = new EntriesLog(pass, other).remove(1);
  server.handlers.set("/entries", onlyRemovals.handler());
  const scanner = await openTab(t);
  await scanner.openEvent(A);
  await scanner.refreshDoorEntries();
  assert.equal(scanner.doorKeyMismatch, false, "the wrong key went unchecked: nothing needed it");
  assert.ok(scanner.doorEntries.tombstones.has(key(A, 1)));
});

test("two events on one phone keep separate lists", async (t) => {
  const a = makePass(A, JTI_A);
  const b = makePass(B, JTI_B);
  await storeEvent(a);
  await storeEvent(b);
  const logA = await new EntriesLog(a).add(1, { buyerName: "At A" });
  const logB = await (await new EntriesLog(b).add(1, { buyerName: "At B" })).add(2, { buyerName: "Also B" });
  server.handlers.set("/entries", (url, init) => (url.pathname.includes(`/${A}/`) ? logA : logB).handler()(url, init));

  const tabA = await openTab(t);
  const tabB = await openTab(t);
  await tabA.openEvent(A);
  await tabB.openEvent(B);
  await Promise.all([tabA.refreshDoorEntries(), tabB.refreshDoorEntries()]);
  assert.deepEqual(names(tabA.attendees), ["1:At A:sale"]);
  assert.deepEqual(names(tabB.attendees), ["1:At B:sale", "2:Also B:sale"]);
  assert.equal((await db.getDoorEntries(A))?.entries.length, 1);
  assert.equal((await db.getDoorEntries(B))?.entries.length, 2);

  await db.clearEvent(A); // "Reset" in A's tab
  assert.equal(await db.getDoorEntries(A), undefined);
  assert.equal((await db.getDoorEntries(B))?.entries.length, 2, "B's list is untouched");
});

// ── the door decision never reads door entries ──────────────────────────────

const ONCHAIN = ("0x" + "11".repeat(32)) as `0x${string}`;
const burner = privateKeyToAccount(generatePrivateKey());

test("an erased order's tombstone never changes the door's decision: the genuine ticket is admitted, once", async (t) => {
  const pass = makePass(A, JTI_A);
  await storeEvent(pass, {
    series: [{ seriesId: seriesId(A), name: "General", totalSupply: 10, onChainEventId: ONCHAIN, slotOwners: [burner.address] }],
  });
  const log = await new EntriesLog(pass).add(1);
  log.remove(1);
  server.handlers.set("/entries", log.handler());
  const scanner = await openTab(t);
  await scanner.openEvent(A);
  await scanner.refreshDoorEntries();
  assert.ok(scanner.doorEntries.tombstones.has(key(A, 1)));

  const sig = await burner.signMessage({ message: buildTicketCanonicalMessage({ onChainEventId: ONCHAIN, seriesId: seriesId(A), edition: 1 }) });
  const qr = `woco://t/${A}/${seriesId(A)}/1/${sig}`;
  const first = await scanner.scan(qr);
  assert.equal(first.kind, "checked-in");
  assert.equal("attendee" in first ? first.attendee : undefined, undefined, "no details shown for an erased order");
  assert.equal((await scanner.scan(qr)).kind, "duplicate");
});

test("the door decision code names no door entries", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/scanner/store.svelte.ts", import.meta.url), "utf8");
  const between = (from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
  for (const [name, body] of [
    ["admitTicket", between("private admitTicket(", "private async claimAtServer(")],
    ["claimAtServer", between("private async claimAtServer(", "private async mark(")],
    ["mark", between("private async mark(", "private async fetchPack(")],
    ["isCheckedIn", between("isCheckedIn(", "findAttendee(")],
  ] as const) {
    assert.doesNotMatch(body, /doorEntries|attendees|DoorEntr/, name);
  }
  const admission = readFileSync(new URL("../src/lib/scanner/admission.ts", import.meta.url), "utf8");
  assert.doesNotMatch(admission, /door-entries|DoorEntr|attendee/i);
});
