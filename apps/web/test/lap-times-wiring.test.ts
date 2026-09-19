/**
 * Ratchets on the wiring the pure tests cannot reach.
 *
 * `credits.ts` and the card reach the auth store, so — as with
 * `credits-key-binding.test.ts` — what gets pinned is the SOURCE. Each check
 * below is a rule about where a lap's time and date come from, or about what
 * sign-out may destroy; every one of them was a way to ship a log that looks
 * right and is quietly wrong.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { addTap, beginPrepared, emptyJournal, journalCounts, markAccepted, preparedLanded, type PreparedRide } from "../src/lib/credits/lap-journal.js";
import { CREDIT_STATEMENT_FORMAT, type Hex0x } from "@woco/shared";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
/** Comments stripped: these files NAME the wrong call in order to warn about it. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/\/\/[^\n]*/g, "");

const CREDITS = code(read("../src/lib/credits/credits.ts"));
const CARD = code(read("../src/lib/credits/CoasterCredit.svelte"));

function body(src: string, signature: RegExp): string {
  const at = src.search(signature);
  assert.ok(at >= 0, `not found: ${signature}`);
  const open = src.indexOf("{", src.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error("unbalanced");
}

// ---------------------------------------------------------------------------
// The time is the tap's
// ---------------------------------------------------------------------------

test("the tap handler reads the clock before it does anything else", () => {
  const collect = body(CARD, /function collect\(/);
  assert.match(collect, /^\{\s*const at = Date\.now\(\);/, "Date.now() is the first statement of collect()");
});

test("nothing after the tap reads the clock for that lap again", () => {
  const tapped = body(CARD, /async function tapped\(/);
  assert.doesNotMatch(tapped, /Date\.now\(\)|new Date\(/);
  assert.match(tapped, /addTap\(store\.read\(\), at\)/, "the journal gets the tap's own reading");
});

test("an unlocked rider's lap is on the phone before anything is awaited", () => {
  const tapped = body(CARD, /async function tapped\(/);
  // Everything that awaits sits inside the first-tap unlock branch.
  const afterUnlock = tapped.slice(tapped.indexOf("const s = ensureSender();"));
  assert.ok(afterUnlock.length > 0);
  const upToWrite = afterUnlock.slice(0, afterUnlock.indexOf("store.write("));
  assert.doesNotMatch(upToWrite, /\bawait\b/);
});

test("the tap button is never disabled by a send in progress", () => {
  const button = CARD.match(/<button class="collect" onclick=\{collect\}[^>]*>/)?.[0] ?? "";
  assert.match(button, /disabled=\{unlocking \|\| publishing\}/);
  assert.doesNotMatch(button, /sending|inFlight|running/);
});

// ---------------------------------------------------------------------------
// The date is the taps'
// ---------------------------------------------------------------------------

test("a prepared ride is dated by its taps", () => {
  const prepare = body(CREDITS, /export async function prepareRide\(/);
  assert.match(prepare, /buildRide\(keys, subject, times\.length, warm, rideDate\(times\)\)/);
  assert.doesNotMatch(prepare, /utcSessionDate|Date\.now|new Date/);
});

test("the build passes that date into the statement instead of defaulting to today", () => {
  const build = body(CREDITS, /async function buildRide\(/);
  assert.match(build, /nextCreditStatement\(\{[\s\S]{0,120}\{ date \}/);
});

// ---------------------------------------------------------------------------
// A retry re-sends; it never re-seals
// ---------------------------------------------------------------------------

test("sealing happens in the build, so the send can be repeated byte for byte", () => {
  assert.match(body(CREDITS, /async function buildRide\(/), /sealJson\(/);
  assert.doesNotMatch(body(CREDITS, /async function sendRide\(/), /sealJson\(|signCreditStatement\(|nextCreditStatement\(/);
  assert.doesNotMatch(body(CREDITS, /export async function sendPreparedRide\(/), /buildRide\(|prepareRide\(/);
});

test("times are sealed at version 0 of a seq-keyed topic, and only there", () => {
  const seal = body(CREDITS, /export async function sealLapTimes\(/);
  assert.match(seal, /knownVersion: 0/);
  assert.match(seal, /diaryTopic\(keys, subject, laps\.seq\)/);
});

// ---------------------------------------------------------------------------
// A failed read must not blank the card
// ---------------------------------------------------------------------------

test("a failed refresh leaves the head on screen alone", () => {
  const refresh = body(CARD, /async function refresh\(/);
  assert.match(refresh, /if \(!read\) return;/);
  assert.doesNotMatch(refresh, /head = await/);
});

test("publishing drops the sender's private head before anything can build on it", () => {
  const publish = body(CARD, /async function confirmPublish\(/);
  assert.ok(publish.indexOf("dropHead()") >= 0 && publish.indexOf("dropHead()") < publish.indexOf("refresh()"));
});

// ---------------------------------------------------------------------------
// What sign-out may destroy
// ---------------------------------------------------------------------------

const SUBJECT = `0x${"11".repeat(32)}` as Hex0x;
const T0 = Date.UTC(2026, 8, 21, 10, 0, 0);

function prepared(times: number[]): PreparedRide {
  return {
    times,
    statement: {
      format: CREDIT_STATEMENT_FORMAT, subject: SUBJECT, holder: "aa".repeat(32), seq: 3, total: 9,
      session: { date: "2026-09-21", count: 2 }, holderSig: "bb".repeat(64),
    },
    visibility: "private", band: 0, version: 4, body: {}, indexed: true, rollover: false,
    attempted: false, accepted: false,
  };
}

/** A localStorage just real enough for cache.ts. */
function withStorage<T>(run: () => Promise<T>): Promise<T> {
  const data = new Map<string, string>();
  const fake = {
    get length() { return data.size; },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
  const g = globalThis as { localStorage?: unknown };
  const before = g.localStorage;
  g.localStorage = fake;
  return run().finally(() => { g.localStorage = before; });
}

test("the sign-out question counts unsent laps and unsealed times, per account", async () => {
  await withStorage(async () => {
    const { openLapJournal } = await import("../src/lib/credits/lap-journal-store.js");
    const { unsentLapsOnDevice } = await import("../src/lib/credits/unsent-laps.js");

    const mine = openLapJournal("0xAbC0000000000000000000000000000000000001", SUBJECT);
    let j = [T0, T0 + 1, T0 + 2, T0 + 3].reduce(addTap, emptyJournal());
    j = preparedLanded(beginPrepared(j, prepared([T0, T0 + 1])));   // 2 counted, unsealed
    j = beginPrepared(j, prepared([T0 + 2]));                       // 1 in the air
    mine.write(j);                                                  // 1 still waiting

    openLapJournal("0xabc0000000000000000000000000000000000002", SUBJECT).write(addTap(emptyJournal(), T0));

    assert.deepEqual(unsentLapsOnDevice("0xabc0000000000000000000000000000000000001"), { waiting: 2, unsealed: 2 });
    assert.deepEqual(unsentLapsOnDevice("0xABC0000000000000000000000000000000000001"), { waiting: 2, unsealed: 2 }, "address case does not matter");
    assert.deepEqual(unsentLapsOnDevice("0xabc0000000000000000000000000000000000002"), { waiting: 1, unsealed: 0 });
    assert.deepEqual(unsentLapsOnDevice(null), { waiting: 0, unsealed: 0 });
  });
});

test("the sign-out question never counts LOWER than the card does", async () => {
  await withStorage(async () => {
    const { openLapJournal } = await import("../src/lib/credits/lap-journal-store.js");
    const { unsentLapsOnDevice } = await import("../src/lib/credits/unsent-laps.js");
    const parent = "0xabc0000000000000000000000000000000000003";
    // An ACCEPTED write is in the card's count already, but its read-back has
    // not settled — signing out now could still lose it, so the question errs high.
    const j = markAccepted(beginPrepared(addTap(emptyJournal(), T0), prepared([T0])));
    openLapJournal(parent, SUBJECT).write(j);
    assert.equal(journalCounts(j).waiting, 0);
    assert.equal(unsentLapsOnDevice(parent).waiting, 1);
  });
});

test("a reopened journal is the one that was stored", async () => {
  await withStorage(async () => {
    const { openLapJournal } = await import("../src/lib/credits/lap-journal-store.js");
    const parent = "0xabc0000000000000000000000000000000000004";
    const now = Date.now();
    openLapJournal(parent, SUBJECT).write(addTap(emptyJournal(), now));
    assert.deepEqual(openLapJournal(parent, SUBJECT).read().waiting, [now]);
  });
});

test("the journal lives under the prefix sign-out clears", () => {
  const cache = read("../src/lib/cache/cache.ts");
  const prefixes = cache.slice(cache.indexOf("USER_SCOPED_PREFIXES = ["));
  assert.match(prefixes, /"credit:"/);
  assert.match(read("../src/lib/credits/unsent-laps.ts"), /LAP_JOURNAL_KEY_PREFIX = "credit:journal:"/);
});

test("the sign-out guard stays out of the credits rail's imports", () => {
  // It is imported by the app shell; pulling in the journal would pull the
  // statement formats and their crypto into the eager bundle.
  const guard = read("../src/lib/credits/unsent-laps.ts");
  const imports = [...guard.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imports, ["../cache/cache.js"]);
});
