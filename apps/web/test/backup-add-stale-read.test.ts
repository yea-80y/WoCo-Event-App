/**
 * The add-a-backup guards (#505) — the two places a lagging RPC replica could
 * make "add a second backup" silently delete the first.
 *
 * THE SEQUENCE THIS PINS. A user adds backup A; seconds later they add B. The
 * pre-write route read is answered by a replica that has not seen A's install,
 * so it reports `absent` — honestly, from where it is standing. `absent` maps to
 * `install`, and a route install pins the hook's set to EXACTLY the listed
 * guardian: the set becomes [B] and A silently loses its recovery power. The
 * old read-back only asked "is B registered?", which is true, so the user was
 * told it worked.
 *
 * Two guards, tested here as the pure functions they are:
 *  - `checkAddAgainstPriorProtection` — a fresh read may CONFIRM the protection
 *    the panel showed, never quietly retract it. No write happens otherwise.
 *  - `expectedGuardiansAfterAdd` + `diffGuardianSets` — the post-write read-back
 *    compares the WHOLE set, so a replace that ate the others cannot pass.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  checkAddAgainstPriorProtection,
  diffGuardianSets,
  expectedGuardiansAfterAdd,
  type PriorProtection,
} from "../src/lib/auth/guardian-hook.js";
import {
  STALE_BACKUP_READ_SENTENCE,
  StaleBackupReadError,
  describeRecoveryError,
  isStaleBackupRead,
} from "../src/lib/auth/recovery-errors.js";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** The panel showed "you are protected" and listed A — the state the bug destroys. */
const PROTECTED_WITH_A: PriorProtection = { expectInstalled: true, expectedGuardians: [A] };

test("a stale 'absent' route under a panel that listed backups REFUSES — no write", () => {
  const r = checkAddAgainstPriorProtection({
    prior: PROTECTED_WITH_A,
    routeState: "absent",
    hookKind: "none",
    set: null,
  });
  assert.equal(r.ok, false);
  assert.match((r as { detail: string }).detail, /absent/);
});

test("an unreadable route under the same expectation REFUSES", () => {
  const r = checkAddAgainstPriorProtection({
    prior: PROTECTED_WITH_A,
    routeState: "unknown",
    hookKind: "none",
    set: null,
  });
  assert.equal(r.ok, false);
});

test("the route confirming the panel's own list proceeds (the real add-a-second-backup path)", () => {
  const r = checkAddAgainstPriorProtection({
    prior: PROTECTED_WITH_A,
    routeState: "installed",
    hookKind: "woco",
    set: { state: "read", guardians: [A] },
  });
  assert.deepEqual(r, { ok: true });
});

test("case is not protection: the same guardian in mixed case still confirms", () => {
  const r = checkAddAgainstPriorProtection({
    prior: { expectInstalled: true, expectedGuardians: [A.toUpperCase().replace("0X", "0x")] },
    routeState: "installed",
    hookKind: "woco",
    set: { state: "read", guardians: [A] },
  });
  assert.deepEqual(r, { ok: true });
});

test("an unprotected account installing its FIRST backup is untouched by the guard", () => {
  const r = checkAddAgainstPriorProtection({
    prior: { expectInstalled: false, expectedGuardians: null },
    routeState: "absent",
    hookKind: "none",
    set: null,
  });
  assert.deepEqual(r, { ok: true });
});

test("a set that has LOST an expected guardian refuses rather than writing over it", () => {
  const r = checkAddAgainstPriorProtection({
    prior: { expectInstalled: true, expectedGuardians: [A, B] },
    routeState: "installed",
    hookKind: "woco",
    set: { state: "read", guardians: [B] },
  });
  assert.equal(r.ok, false);
  assert.match((r as { detail: string }).detail, new RegExp(A));
});

test("a WoCo route whose set the panel could not read still refuses a retraction", () => {
  const prior: PriorProtection = { expectInstalled: true, expectedGuardians: "unknown" };
  assert.equal(
    checkAddAgainstPriorProtection({ prior, routeState: "absent", hookKind: "none", set: null }).ok,
    false,
  );
  // Confirmed route + readable set ⇒ the write will APPEND, which loses nothing.
  assert.deepEqual(
    checkAddAgainstPriorProtection({
      prior,
      routeState: "installed",
      hookKind: "woco",
      set: { state: "read", guardians: [A] },
    }),
    { ok: true },
  );
  // A route that is installed but whose set will not load cannot be appended to
  // safely, so it refuses too.
  assert.equal(
    checkAddAgainstPriorProtection({
      prior,
      routeState: "installed",
      hookKind: "woco",
      set: { state: "unknown" },
    }).ok,
    false,
  );
});

test("a route that changed hook under a listed set refuses (an install there would replace it)", () => {
  const r = checkAddAgainstPriorProtection({
    prior: PROTECTED_WITH_A,
    routeState: "installed",
    hookKind: "legacy",
    set: null,
  });
  assert.equal(r.ok, false);
});

test("expectedGuardiansAfterAdd: install REPLACES (exactly the new one), append ADDS", () => {
  assert.deepEqual(expectedGuardiansAfterAdd({ path: "install" }, B), [B]);
  assert.deepEqual(expectedGuardiansAfterAdd({ path: "append", currentGuardians: [A] }, B), [A, B]);
  // Lowercased and de-duplicated — the chain has no opinion about either.
  assert.deepEqual(
    expectedGuardiansAfterAdd({ path: "append", currentGuardians: [A.toUpperCase().replace("0X", "0x"), A] }, B),
    [A, B],
  );
});

test("read-back of [A,B] against previous [A] plus new B is a match, in any order", () => {
  const expected = expectedGuardiansAfterAdd({ path: "append", currentGuardians: [A] }, B);
  assert.deepEqual(diffGuardianSets(expected, [B, A]), { ok: true, missing: [], unexpected: [] });
});

test("read-back of [B] alone is the silent-drop signature and is reported as a mismatch", () => {
  const expected = expectedGuardiansAfterAdd({ path: "append", currentGuardians: [A] }, B);
  const diff = diffGuardianSets(expected, [B]);
  assert.equal(diff.ok, false);
  assert.deepEqual(diff.missing, [A]);
  assert.deepEqual(diff.unexpected, []);
});

test("a guardian nobody asked for is a mismatch too, not just a missing one", () => {
  const diff = diffGuardianSets([A], [A, B]);
  assert.equal(diff.ok, false);
  assert.deepEqual(diff.unexpected, [B]);
});

test("the refusal reaches the user as one sentence, and never as a sponsorship failure", () => {
  const e = new StaleBackupReadError('route read back "absent"');
  assert.ok(isStaleBackupRead(e));
  assert.equal(e.message, STALE_BACKUP_READ_SENTENCE);
  assert.equal(describeRecoveryError(e, "setup"), STALE_BACKUP_READ_SENTENCE);
  // The machine detail stays off the screen.
  assert.ok(!describeRecoveryError(e, "setup").includes("absent"));
});
