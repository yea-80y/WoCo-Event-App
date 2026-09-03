/**
 * The profile-name ledger is the server's ONLY record of which of an account's
 * sub-ENS names is its IDENTITY rather than a URL, and the only brake on rename
 * churn. Chain ownership stays the authority everywhere else; nothing here
 * grants a name, and every caller re-checks `getLabelOwner` live.
 *
 * These tests assert the RULE from the plan doc §2, not the shape of a
 * function: a bind of a different label is allowed iff the free-correction
 * window is open and unspent, OR the cooldown has elapsed. A first bind, an
 * unbind, and a rebind of the same label are ungated.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The store resolves `.data` from cwd at import time, so redirect before import.
process.chdir(mkdtempSync(join(tmpdir(), "woco-profile-names-")));

const {
  profileNameOf,
  nameChangeStatus,
  bindProfileName,
  unbindProfileName,
  isProfileName,
  _resetProfileNamesForTests,
  NAME_CHANGE_COOLDOWN_MS,
  FREE_CORRECTION_WINDOW_MS,
} = await import("../src/lib/profile/name-ledger.js");

const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/**
 * A fresh account per test. `_resetProfileNamesForTests` drops the in-memory
 * map and forces a RELOAD FROM DISK — which is what makes the restart test
 * meaningful, but means it is not a truncation, so sharing an address across
 * tests would leak state through the file.
 */
let n = 0;
const acct = (): string => `0x${(++n).toString(16).padStart(40, "a")}`;

test("an account with no record has no profile name and may bind freely", () => {
  const A = acct();
  assert.equal(profileNameOf(A), null);
  const s = nameChangeStatus(A, T0);
  assert.equal(s.allowed, true);
  assert.equal(s.nextChangeAllowedAt, null);
});

test("the first bind is ungated and is readable back", () => {
  const A = acct();
  assert.equal(bindProfileName(A, "punkpub", T0).ok, true);
  assert.equal(profileNameOf(A), "punkpub");
});

test("addresses and labels are matched case-insensitively", () => {
  const A = acct();
  bindProfileName(A.toUpperCase(), "PunkPub", T0);
  assert.equal(profileNameOf(A.toLowerCase()), "punkpub");
});

test("one account's name is not another's", () => {
  const A = acct();
  const B = acct();
  bindProfileName(A, "punkpub", T0);
  assert.equal(profileNameOf(B), null);
});

test("the ledger survives a restart", () => {
  const A = acct();
  bindProfileName(A, "punkpub", T0);
  _resetProfileNamesForTests(); // drops memory; next read reloads from disk
  assert.equal(profileNameOf(A), "punkpub");
  // and the clock came back with it, not reset to "never bound"
  assert.equal(nameChangeStatus(A, T0 + 8 * DAY).allowed, false);
});

test("a second, different label inside 7 days is the FREE correction", () => {
  const A = acct();
  bindProfileName(A, "punkpub", T0);
  const r = bindProfileName(A, "punkpubb", T0 + 2 * DAY);
  assert.equal(r.ok, true);
  assert.equal(profileNameOf(A), "punkpubb");
  assert.equal(nameChangeStatus(A, T0 + 2 * DAY).freeCorrectionUsed, true);
});

test("the free correction is spendable only ONCE", () => {
  const A = acct();
  bindProfileName(A, "one", T0);
  assert.equal(bindProfileName(A, "two", T0 + DAY).ok, true);
  const third = bindProfileName(A, "three", T0 + 2 * DAY);
  assert.equal(third.ok, false);
  assert.equal(profileNameOf(A), "two", "a refused change must not be written");
});

test("after the 7-day window the cooldown is the only route", () => {
  const A = acct();
  bindProfileName(A, "one", T0);
  const r = bindProfileName(A, "two", T0 + 8 * DAY);
  assert.equal(r.ok, false);
  assert.equal((r as { reason?: string }).reason, "cooldown");
  assert.equal(profileNameOf(A), "one");
});

test("a change is allowed once the cooldown has elapsed", () => {
  const A = acct();
  bindProfileName(A, "one", T0);
  const at = T0 + NAME_CHANGE_COOLDOWN_MS;
  assert.equal(nameChangeStatus(A, at).allowed, true);
  assert.equal(bindProfileName(A, "two", at).ok, true);
  assert.equal(profileNameOf(A), "two");
});

test("one millisecond before the cooldown expires it is still refused", () => {
  const A = acct();
  bindProfileName(A, "one", T0);
  const justBefore = T0 + NAME_CHANGE_COOLDOWN_MS - 1;
  assert.equal(nameChangeStatus(A, justBefore).allowed, false);
  assert.equal(bindProfileName(A, "two", justBefore).ok, false);
});

test("a refused change reports WHEN it becomes allowed", () => {
  const A = acct();
  bindProfileName(A, "one", T0);
  const s = nameChangeStatus(A, T0 + 8 * DAY);
  assert.equal(s.nextChangeAllowedAt, T0 + NAME_CHANGE_COOLDOWN_MS);
});

test("a successful change restarts the cooldown from the change, not the first bind", () => {
  const A = acct();
  bindProfileName(A, "one", T0);
  const changedAt = T0 + NAME_CHANGE_COOLDOWN_MS;
  bindProfileName(A, "two", changedAt);
  assert.equal(nameChangeStatus(A, changedAt + DAY).allowed, false);
  assert.equal(
    nameChangeStatus(A, changedAt + DAY).nextChangeAllowedAt,
    changedAt + NAME_CHANGE_COOLDOWN_MS,
  );
});

test("re-binding the SAME label is ungated and does not touch the clock", () => {
  const A = acct();
  bindProfileName(A, "one", T0);
  assert.equal(bindProfileName(A, "one", T0 + 8 * DAY).ok, true);
  // If that had counted as a change, the cooldown would now run from +8d.
  assert.equal(nameChangeStatus(A, T0 + NAME_CHANGE_COOLDOWN_MS).allowed, true);
});

test("an unbind clears the profile name but not the clock", () => {
  const A = acct();
  bindProfileName(A, "one", T0);
  const unboundAt = T0 + 8 * DAY; // past the free window, inside the cooldown
  unbindProfileName(A);
  assert.equal(profileNameOf(A), null);
  // The cooldown still runs from the ORIGINAL bind. If the unbind had touched
  // the clock, `nextChangeAllowedAt` would have moved to unboundAt + COOLDOWN.
  const s = nameChangeStatus(A, unboundAt);
  assert.equal(s.allowed, false);
  assert.equal(s.nextChangeAllowedAt, T0 + NAME_CHANGE_COOLDOWN_MS);
});

test("unbind-then-bind-different is NOT a free rename", () => {
  const A = acct();
  bindProfileName(A, "one", T0);
  bindProfileName(A, "two", T0 + DAY); // spends the free correction
  unbindProfileName(A);
  const r = bindProfileName(A, "three", T0 + 2 * DAY);
  assert.equal(r.ok, false, "an unbind must not launder a rename past the cooldown");
});

test("re-binding the same label after an unbind is an undo, not a change", () => {
  const A = acct();
  bindProfileName(A, "one", T0);
  unbindProfileName(A);
  const r = bindProfileName(A, "one", T0 + DAY);
  assert.equal(r.ok, true);
  assert.equal(profileNameOf(A), "one");
  assert.equal(nameChangeStatus(A, T0 + DAY).freeCorrectionUsed, false);
});

test("unbinding twice is a no-op", () => {
  const A = acct();
  bindProfileName(A, "one", T0);
  unbindProfileName(A);
  unbindProfileName(A);
  assert.equal(profileNameOf(A), null);
});

test("the free correction is not consumed by a change the cooldown already allowed", () => {
  const A = acct();
  bindProfileName(A, "one", T0);
  // Well past both windows: the cooldown is what permits this, so the free
  // correction must survive for a genuine early typo after a later rename.
  const at = T0 + NAME_CHANGE_COOLDOWN_MS + DAY;
  bindProfileName(A, "two", at);
  assert.equal(nameChangeStatus(A, at).freeCorrectionUsed, false);
});

test("the free-correction window is measured from the FIRST bind, never the last", () => {
  const A = acct();
  bindProfileName(A, "one", T0);
  const at = T0 + NAME_CHANGE_COOLDOWN_MS; // a legitimate cooldown-based change
  bindProfileName(A, "two", at);
  // Two days after THAT change is ~30 days after the first bind, so the free
  // window must be shut — otherwise every rename would reopen it.
  assert.equal(bindProfileName(A, "three", at + 2 * DAY).ok, false);
  assert.ok(FREE_CORRECTION_WINDOW_MS < NAME_CHANGE_COOLDOWN_MS);
});

// ---------------------------------------------------------------------------
// The clock outlives the name (Fable, 5c consult fact 7)
// ---------------------------------------------------------------------------

test("giving up the old name does not reset the cooldown", () => {
  // `release` is the holder's own tx and is ungated by design, so if losing a
  // name also cleared the record, `release old -> mint new -> bind` would read
  // as a FIRST bind and skip the cooldown entirely. The cooldown would then
  // bind only the users who KEPT their old name — the ones not churning.
  //
  // Releasing is invisible to the server, so from this module's side it is
  // indistinguishable from doing nothing: the assertion is that no path drops
  // the record. `unbindProfileName` is the strongest thing a user can do to it.
  const A = acct();
  bindProfileName(A, "one", T0);
  bindProfileName(A, "two", T0 + DAY); // spends the free correction
  unbindProfileName(A); // the closest server-visible analogue of a release
  _resetProfileNamesForTests(); // and it survives a restart in that state

  const s = nameChangeStatus(A, T0 + 2 * DAY);
  assert.equal(s.allowed, false, "the rename clock must outlive the name");
  assert.equal(s.freeCorrectionUsed, true, "the spent free correction must not come back");
  assert.equal(bindProfileName(A, "three", T0 + 2 * DAY).ok, false);
});

test("the module exposes no way to delete a record", () => {
  // The clock's whole value is that it cannot be shed. Anything that removes an
  // entry — however well-intentioned, e.g. "tidy up names the user no longer
  // owns" — reopens the bypass above.
  const mod = { profileNameOf, nameChangeStatus, bindProfileName, unbindProfileName, isProfileName };
  for (const name of Object.keys(mod)) {
    assert.doesNotMatch(name, /delete|remove|clear|forget|purge/i);
  }
});
