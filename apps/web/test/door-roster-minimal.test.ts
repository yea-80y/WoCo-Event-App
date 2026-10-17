/**
 * Data minimisation at the door (owner, 2026-10-15): a door phone gets each ticket,
 * its ticket type, a name and an email - never the other order-form answers (dietary
 * needs, custom questions). The dashboard builds the list that way, both sides of the
 * roster encryption keep only those keys (a roster pushed before still carries
 * answers), the scanner keeps only those from storage, and it searches only them.
 *
 * MUTATION: put `fields` back in `buildRosterEntries` and the exact-key-set test goes
 * red; drop `pickRosterEntries` from `decryptRoster`, `encryptRoster` or the store's
 * open and its test goes red; search the answers again and the search test goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base64UrlEncode, type RosterEntry } from "@woco/shared";
import { doorRosterKey } from "@woco/shared/checkin/door-keys";
import { buildRosterEntries } from "../src/lib/creator/dashboard/door-roster.js";
import { decryptRoster, encryptRoster, pickRosterEntries } from "../src/lib/scanner/roster-crypto.js";
import { attendeeName, searchAttendees } from "../src/lib/scanner/attendee-search.js";
import { db, makePass, openTab, removeCompiledStore, resetWorld, storeEvent } from "./scanner-store-harness.ts";

test.after(removeCompiledStore);

const ALLOWED = ["edition", "email", "name", "seriesId", "seriesName"];
const ANSWERS = { "Full name": "Ada Lovelace", Dietary: "vegan, no nuts", "Access needs": "step-free entry", "T-shirt": "M" };
const keysOf = (e: object) => Object.keys(e).sort();

test("the dashboard's door list carries exactly the ticket, ticket type, name and email - no other answer", () => {
  const orders = [
    { seriesId: "ser-1", seriesName: "Feed name", edition: 1 },
    { seriesId: "ser-1", seriesName: "Feed name", edition: 2 },
    { seriesId: "ser-2", seriesName: "Late", edition: 1 },
  ];
  const decrypted = new Map([
    [0, { fields: ANSWERS, claimerEmail: "ada@example.com" }],
    [2, { fields: { Dietary: "vegan" } }],
  ]);
  const roster = buildRosterEntries(orders, decrypted, new Map([["ser-1", "General"]]));
  assert.deepEqual(roster[0], { seriesId: "ser-1", seriesName: "General", edition: 1, name: "Ada Lovelace", email: "ada@example.com" });
  assert.deepEqual(keysOf(roster[0]), ALLOWED, "exactly these keys");
  assert.deepEqual(keysOf(roster[1]), ["edition", "seriesId", "seriesName"], "no order data: the ticket only");
  assert.deepEqual(roster[2], { seriesId: "ser-2", seriesName: "Late", edition: 1 }, "no name question: no name, and no answer either");
  const json = JSON.stringify(roster);
  for (const answer of ["vegan", "step-free", "T-shirt", "Dietary"]) assert.ok(!json.includes(answer), answer);
});

test("both sides of the roster encryption keep only the door's keys", async () => {
  const secret = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const withAnswers = [{ seriesId: "ser-1", seriesName: "General", edition: 1, name: "Ada", email: "ada@example.com", fields: ANSWERS, source: "sale" }];

  // A dashboard sending extra keys: dropped before encryption - read here with
  // WebCrypto directly, not decryptRoster, which would drop them again.
  const raw = doorRosterKey(Uint8Array.from(Buffer.from(secret, "base64url")));
  const sealed = await encryptRoster(withAnswers as unknown as RosterEntry[], secret);
  const dec = await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(sealed.iv, "base64") },
    dec,
    Buffer.from(sealed.ciphertext, "base64"),
  );
  assert.deepEqual((JSON.parse(new TextDecoder().decode(plain)) as object[]).map(keysOf), [ALLOWED], "what leaves the dashboard");

  // A roster pushed before the change (answers inside the ciphertext): dropped on opening.
  const key = await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(withAnswers))));
  const old = await decryptRoster({ iv: Buffer.from(iv).toString("base64"), ciphertext: Buffer.from(ct).toString("base64"), updatedAt: "x" }, secret);
  assert.deepEqual(old, [{ seriesId: "ser-1", seriesName: "General", edition: 1, name: "Ada", email: "ada@example.com" }]);

  assert.deepEqual(pickRosterEntries([{ seriesId: "s", edition: "1" }, null, "x", { seriesId: "s", edition: 2 }]), [{ seriesId: "s", seriesName: "", edition: 2 }]);
  assert.deepEqual(pickRosterEntries({ not: "a list" }), []);
});

test("the scanner keeps only the door's keys from a roster stored before the change", async (t) => {
  resetWorld();
  const pass = makePass("event-a", "a".repeat(32));
  await storeEvent(pass);
  await db.putRoster("event-a", [{ seriesId: "ser-event-a", seriesName: "General", edition: 1, name: "Ada", fields: ANSWERS } as unknown as RosterEntry]);
  const scanner = await openTab(t);
  await scanner.openEvent("event-a");
  assert.deepEqual(scanner.attendees.map(keysOf), [["edition", "name", "seriesId", "seriesName"]]);
  assert.ok(!JSON.stringify(scanner.attendees).includes("vegan"));
});

test("the scanner searches name, email and ticket number - and nothing else", () => {
  const list = [
    { seriesId: "ser-1", seriesName: "General", edition: 12, name: "Ada Lovelace", email: "ada@example.com" },
    { seriesId: "ser-1", seriesName: "General", edition: 3, email: "grace@example.com" },
    // An entry object from an old phone that still carries answers: they are not searchable.
    { seriesId: "ser-1", seriesName: "General", edition: 7, name: "Old Entry", fields: { Dietary: "vegan" } } as unknown as RosterEntry,
  ];
  const ed = (q: string) => searchAttendees(list, q).map((r) => r.edition);
  assert.deepEqual(ed(""), [3, 7, 12], "everyone, by ticket type and number");
  assert.deepEqual(ed("lovelace"), [12]);
  assert.deepEqual(ed("GRACE@"), [3]);
  assert.deepEqual(ed("#12"), [12]);
  assert.deepEqual(ed("3"), [3]);
  assert.deepEqual(ed("vegan"), [], "an order answer finds nobody");
  assert.deepEqual(ed("General"), [], "nor does the ticket type");
});

test("no scanner screen and no door list code reads order answers", () => {
  for (const f of ["../src/lib/scanner/RosterScreen.svelte", "../src/lib/scanner/ScanScreen.svelte", "../src/ScannerApp.svelte", "../src/lib/scanner/attendee-search.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), "utf8"), /\bfields\b/, f);
  }
  const panel = readFileSync(new URL("../src/lib/creator/dashboard/CheckinPanel.svelte", import.meta.url), "utf8");
  assert.match(panel, /encryptRoster\(doorRoster\(\)/);
  assert.doesNotMatch(panel, /function buildRosterEntries/);
  const types = readFileSync(new URL("../../../packages/shared/src/checkin/types.ts", import.meta.url), "utf8");
  const entry = types.slice(types.indexOf("export interface RosterEntry"), types.indexOf("}", types.indexOf("export interface RosterEntry")));
  assert.doesNotMatch(entry, /fields/, "RosterEntry has no field for answers");
});

test("a sale's name reads \"Paid by\" on the list and the scan card; the organiser's list shows as is", () => {
  assert.equal(attendeeName({ edition: 4, name: "Jane Smith", email: "j@example.com", source: "sale" }), "Paid by Jane Smith");
  assert.equal(attendeeName({ edition: 4, name: "Jane Smith", email: "j@example.com" }), "Jane Smith");
  assert.equal(attendeeName({ edition: 4, email: "j@example.com", source: "sale" }), "j@example.com", "no card name: the email, as is");
  assert.equal(attendeeName({ edition: 4 }), "Ticket #4");
  const roster = readFileSync(new URL("../src/lib/scanner/RosterScreen.svelte", import.meta.url), "utf8");
  const scan = readFileSync(new URL("../src/lib/scanner/ScanScreen.svelte", import.meta.url), "utf8");
  assert.match(roster, /<span class="name">\{attendeeName\(entry\)\}<\/span>/);
  assert.match(scan, /<span class="verdict-who">\{attendeeName\(attendee\)\}<\/span>/);
  for (const src of [roster, scan]) assert.doesNotMatch(src, /card name|name on the card/i, "the old tags are gone");
});
