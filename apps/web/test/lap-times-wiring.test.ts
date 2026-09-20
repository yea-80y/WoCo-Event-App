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

test("the tap that starts the unlock is on screen before anything can block", () => {
  const tapped = body(CARD, /async function tapped\(/);
  const shown = tapped.indexOf("pendingTap = at;");
  assert.ok(shown >= 0, "the tap is held where the card can render it");
  assert.ok(shown < tapped.indexOf("await"), "and assigned before the first await");
  // Every "waiting" the card shows has to include it, or the tap that raised
  // the dialog stays invisible underneath it — which is what made a tester
  // re-tap and start at three laps.
  const markup = CARD.slice(CARD.indexOf("</script>"));
  assert.doesNotMatch(markup, /counts\.waiting/, "the markup counts through the derived, never the journal alone");
  assert.match(CARD, /const waiting = \$derived\(counts\.waiting \+ \(pendingTap === null \? 0 : 1\)\)/);
});

test("a held tap is cleared on every exit from the unlock", () => {
  const tapped = body(CARD, /async function tapped\(/);
  const cleared = tapped.indexOf("pendingTap = null;");
  assert.ok(cleared >= 0);
  // In the `finally`, so a declined sign-in and a failed key ceremony both drop
  // it — a tap left behind would show as waiting forever and be sent by nobody.
  const fin = tapped.indexOf("} finally {");
  assert.ok(fin >= 0 && cleared > fin, "cleared in the finally, not on the success path only");
});

test("the first tap uses the ONE planned account gate, not its own sequence", () => {
  const tapped = body(CARD, /async function tapped\(/);
  // How many prompts a rider meets depends on the login kind and on what the
  // device already holds, so a call site that orders them gets it wrong for
  // somebody — and a brand-new account, with nothing on the device, is the case
  // that broke: the first ride after creating an account got stuck.
  assert.match(tapped, /auth\.ensureAccountSetup\(\{ identity: true \}\)/);
  assert.doesNotMatch(CARD, /requireAccountForAction/, "never the session gate plus a separate key call");
  const login = tapped.indexOf("loginRequest.request()");
  const setup = tapped.indexOf("ensureAccountSetup");
  assert.ok(login >= 0 && login < setup, "sign in first, then the planned setup");
  // And the key check must come after the gate, never instead of it.
  assert.ok(setup < tapped.indexOf("unlockCredits()"));
});

test("a tap made during the unlock is answered, not silently dropped", () => {
  const tapped = body(CARD, /async function tapped\(/);
  const guard = tapped.slice(0, tapped.indexOf("notice = null;"));
  assert.match(guard, /if \(unlocking\)/);
  assert.match(guard, /notice = /, "it says something rather than returning in silence");
});

test("coming back online resets the ladder before it retries", () => {
  const onOnline = body(CARD, /function onOnline\(/);
  const reset = onOnline.indexOf("resetBackoff()");
  assert.ok(reset >= 0 && reset < onOnline.indexOf("drain()"), "reset first, then try");
  assert.match(CARD, /addEventListener\("online", onOnline\)/);
  assert.match(CARD, /removeEventListener\("online", onOnline\)/);
});

test("unsent laps are retried on a steady poll, whatever events arrive", () => {
  // The event listeners SHOULD be enough and were not: a tester had to tap a
  // lap to move three waiting ones after reconnecting.
  const poll = body(CARD, /function pollWhileUnsent\(/);
  assert.match(poll, /if \(pollTimer \|\| !hasWork\(\)\) return;/, "one timer, and only while there is work");
  assert.match(poll, /setInterval/);
  assert.match(body(CARD, /function drain\(/), /pollWhileUnsent\(\)/);
  assert.match(body(CARD, /function stopPolling\(/), /clearInterval/);
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
  const send = body(CREDITS, /async function sendRide\(/);
  // The extraction itself is asserted: a mutation run found this check reading
  // the function's RETURN TYPE (an inline `{ ... }`) and so guarding nothing.
  assert.match(send, /writeRideBody\(keys, subject, visibility, ride\.body,/, "this is the function body, and it uploads the prepared bytes");
  assert.doesNotMatch(send, /sealJson\(|signCreditStatement\(|nextCreditStatement\(/);
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
  const bail = refresh.indexOf("if (!read) return;");
  const assign = refresh.indexOf("head = read;");
  assert.ok(bail >= 0 && assign >= 0);
  assert.ok(bail < assign, "the null check comes BEFORE the head is touched");
  assert.equal(refresh.match(/\bhead = /g)?.length, 1, "and that is the only place it is assigned");
});

test("a stale read cannot take the count on screen backwards", () => {
  const refresh = body(CARD, /async function refresh\(/);
  const stale = refresh.indexOf("read.statement.seq < head.statement.seq");
  assert.ok(stale >= 0 && stale < refresh.indexOf("head = read;"));
});

test("every network step re-checks whose session it is", () => {
  const ensure = body(CARD, /function ensureSender\(/);
  for (const step of ["prepare", "send", "reconcile", "seal"]) {
    assert.match(ensure, new RegExp(`${step}: async \\([^)]*\\) =>\\s*\\(?\\s*mine\\(\\)`), `${step} is gated on mine()`);
  }
  assert.match(ensure, /if \(sender && boundParent === parent\) return sender;/);
});

test("an account change under a mounted card resets it", () => {
  const at = CARD.indexOf("parent === boundParent) return;");
  assert.ok(at >= 0);
  const reset = CARD.slice(at, at + 600);
  for (const cleared of ["sender = null;", "store = null;", "head = null;", "cachedLaps = null;", "journal = emptyJournal();"]) {
    assert.ok(reset.includes(cleared), `resets ${cleared}`);
  }
});

test("publishing drops the sender's private head before anything can build on it", () => {
  const publish = body(CARD, /async function confirmPublish\(/);
  assert.ok(publish.indexOf("dropHead()") >= 0 && publish.indexOf("dropHead()") < publish.indexOf("refresh()"));
});

// ---------------------------------------------------------------------------
// Listing the collection — the passport's way back to a coaster
// ---------------------------------------------------------------------------

const PASSPORT = code(read("../src/lib/attendee/passport/PassportTab.svelte"));
const PAGE = code(read("../src/lib/credits/CoasterPage.svelte"));

test("listing a collection never prompts", () => {
  // The passport is a tab someone OPENS, not an action they took. Reaching for
  // riderKeys() first would raise a key ceremony at a rider who has done
  // nothing, which is the rule the coaster card's mount read already follows.
  const list = body(CREDITS, /export async function readMyCredits\(/);
  const gate = list.indexOf("creditsUnlocked()");
  assert.ok(gate >= 0, "asks only what the device already holds");
  assert.ok(gate < list.indexOf("riderKeys()"), "and does so BEFORE establishing anything");
  assert.match(list, /return \{ status: "locked" \}/);
});

test("both partitions are read, and merged by the tested rule", () => {
  const list = body(CREDITS, /export async function readMyCredits\(/);
  assert.match(list, /readSubjectIndex\(keys, "public"\)/);
  assert.match(list, /readSubjectIndex\(keys, "private"\)/);
  assert.match(list, /mergeSubjectPartitions\(/);
});

test("a head that will not read is dropped, never shown as zero laps", () => {
  const list = body(CREDITS, /export async function readMyCredits\(/);
  assert.match(list, /if \(head\.status !== "found"\) continue;/);
  // The index says the rider owns it, so a count of nothing would be a WRONG
  // number on the screen that lists what they own; absent is merely a slow one.
  assert.doesNotMatch(list, /total: 0/);
});

test("one unreadable partition is survivable, both is not", () => {
  const list = body(CREDITS, /export async function readMyCredits\(/);
  assert.match(
    list,
    /pub\.read\.status === "unavailable" && priv\.read\.status === "unavailable"/,
    "AND, not OR: an absent index is an ordinary empty partition",
  );
});

test("the passport tells 'not set up' apart from 'no credits'", () => {
  // A returning rider on a new phone must not be told their collection is empty.
  assert.match(PASSPORT, /creditsState === "locked"/);
  assert.match(PASSPORT, /creditsState === "unavailable"/);
  const locked = PASSPORT.slice(PASSPORT.indexOf('creditsState === "locked"'));
  assert.doesNotMatch(locked.slice(0, 260), /No credits|no credits yet/i);
});

test("no coaster surface uses a fragment anchor, which the base href sends to the gateway", () => {
  // The deploy injects `<base href="https://gateway.woco-net.com/bzz/{hash}/">`
  // so the bundle's own assets resolve. A fragment-only href resolves against
  // that BASE, so `<a href="#/tickets">` walks the rider off woco.eth.limo and
  // onto the gateway origin — where `resolvePasskeyRpId` reads a different
  // hostname and their passkey is a DIFFERENT ACCOUNT holding none of their
  // credits. Route changes go through `navigate`, which sets location.hash and
  // cannot leave the origin.
  for (const [name, src] of [["CoasterPage", PAGE], ["CoasterCredit", CARD], ["PassportTab", PASSPORT]] as const) {
    assert.doesNotMatch(src, /<a[^>]+href="#/, `${name} uses navigate(), not a fragment anchor`);
  }
  assert.match(PAGE, /navigate\("\/tickets"\)/);
});

test("the lap log spans the whole challenge, not just today", () => {
  // A mutation run caught this one: nothing failed when the card's log was
  // filtered back to a single day, because the rule lives in a $derived that no
  // unit test reaches. A challenge runs over days, and a log that resets at
  // midnight shows an empty list beside a count of 130 the next morning.
  const rows = body(CARD, /const rows = \$derived\.by/);
  assert.match(rows, /allLapRows\(journal\)/);
  assert.doesNotMatch(rows, /dayOf\(/, "no day filter anywhere in building the rows");
  assert.match(CARD, /const byDay = \$derived\(lapRowsByDay\(rows, dayOf\)\)/);
});

test("each credit taps back to its coaster page", () => {
  // The whole point of the section beyond completeness: the coaster page is
  // reached by QR or a link and never from nav, so a rider who closed the tab
  // has no other route back.
  assert.match(PASSPORT, /navigate\(`\/coaster\/\$\{credit\.subject\}`\)/);
});

test("the credits rail is not dragged into the passport's eager bundle", () => {
  const mount = body(PASSPORT, /onMount\(async \(\) =>/);
  assert.match(mount, /await import\("\.\.\/\.\.\/credits\/credits\.js"\)/);
  assert.doesNotMatch(PASSPORT, /^import .*credits\/credits\.js/m);
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
