/**
 * The participant registry — who the indexer will read (`lib/social/participants.ts`).
 *
 * Two properties here are load-bearing rather than tidy, and both are the kind
 * that decay silently:
 *
 *   1. A SEALED payload is refused BEFORE the format check. Registering one
 *      would publish the (subject, feed owner) pair through the manifest's
 *      participant list — exactly the participation fact the salted private
 *      topic exists to hide. The module's comment warns that a `SealedBox` is
 *      ordinary JSON that parses perfectly well, and is filtered today only
 *      because it happens to carry no `format` key. So the test that matters is
 *      the one where a sealed envelope ALSO carries a cleartext routing hint:
 *      the refusal must survive that, or the privacy property is one reasonable
 *      -looking envelope change away from being gone with the counts still
 *      perfectly correct.
 *   2. The ceilings apply on BOTH admission paths. A ceiling one entry point
 *      ignores is not a ceiling, it is a comment.
 *
 * Everything else asserted here is the ordinary contract: what is admitted, what
 * is ignored, and that a rejected write is never a thrown one — this observes a
 * user's like and must not be able to fail it.
 *
 * The store writes `.data/` relative to process.cwd(), so this suite chdirs into
 * a temp dir BEFORE importing it and never touches the real one.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let store: typeof import("../src/lib/social/participants.js");

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-social-participants-")));
  store = await import("../src/lib/social/participants.js");
});

beforeEach(() => store.__resetParticipants());

const SUBJECT = `0x${"a1".repeat(32)}`;
const OTHER_SUBJECT = `0x${"b2".repeat(32)}`;
const OWNER = `0x${"11".repeat(20)}`;
const OWNER_2 = `0x${"22".repeat(20)}`;

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

const like = (subject = SUBJECT) => ({ format: "woco.like.v1", subject, value: true });

/** Synthetic addresses, cheap and unique — for filling a registry to a ceiling. */
function addresses(n: number, from = 0): string[] {
  return Array.from({ length: n }, (_, i) => `0x${(i + from).toString(16).padStart(40, "0")}`);
}

// ── The sealed refusal ───────────────────────────────────────────────────────

test("a sealed envelope is refused", () => {
  store.observeStatementBytes(OWNER, bytes({ ephemeralPublicKey: "ab", iv: "cd", ciphertext: "ef" }));
  assert.deepEqual(store.knownSubjects("woco.credit.v1"), []);
});

test("a sealed envelope carrying a cleartext routing hint is STILL refused", () => {
  // The sharp case. Adding `format`/`subject` to the envelope for client-side
  // dispatch is a reasonable-looking change; if the sealed check ran after the
  // format check, every private credit would start flowing into the registry
  // silently and the counts would still be perfectly correct.
  store.observeStatementBytes(
    OWNER,
    bytes({
      ephemeralPublicKey: "ab",
      iv: "cd",
      ciphertext: "ef",
      format: "woco.credit.v1",
      subject: SUBJECT,
    }),
  );
  assert.deepEqual(store.participantsFor("woco.credit.v1", SUBJECT), []);
  assert.deepEqual(store.knownSubjects("woco.credit.v1"), []);
});

test("a public statement that merely resembles the sealed shape is not caught by it", () => {
  // The refusal keys on all three envelope fields being strings, so a statement
  // is only rejected for genuinely looking sealed. Guards the other direction:
  // a check that swallowed public statements would silently shrink every count.
  store.observeStatementBytes(OWNER, bytes({ ...like(), iv: "cd" }));
  assert.deepEqual(store.participantsFor("woco.like.v1", SUBJECT), [OWNER]);
});

// ── What gets admitted ───────────────────────────────────────────────────────

test("a public statement registers its feed owner", () => {
  store.observeStatementBytes(OWNER, bytes(like()));
  assert.deepEqual(store.participantsFor("woco.like.v1", SUBJECT), [OWNER]);
});

test("every indexable format is admitted, and each keeps its own subject space", () => {
  store.observeStatementBytes(OWNER, bytes({ format: "woco.like.v1", subject: SUBJECT, value: true }));
  store.observeStatementBytes(OWNER, bytes({ format: "woco.follow.v1", subject: SUBJECT, value: true }));
  store.observeStatementBytes(OWNER_2, bytes({ format: "woco.credit.v1", subject: SUBJECT, total: 3 }));

  assert.deepEqual(store.participantsFor("woco.like.v1", SUBJECT), [OWNER]);
  assert.deepEqual(store.participantsFor("woco.follow.v1", SUBJECT), [OWNER]);
  assert.deepEqual(store.participantsFor("woco.credit.v1", SUBJECT), [OWNER_2]);
});

test("an owner arriving without 0x, or in mixed case, is stored in one canonical form", () => {
  // Feed topics resolve inside an owner's address space, so two spellings of one
  // owner would be read twice and counted twice.
  store.observeStatementBytes(OWNER.slice(2).toUpperCase(), bytes(like()));
  store.observeStatementBytes(OWNER.toUpperCase(), bytes(like()));
  store.observeStatementBytes(OWNER, bytes(like()));
  assert.deepEqual(store.participantsFor("woco.like.v1", SUBJECT), [OWNER]);
});

test("a subject is matched case-insensitively on read", () => {
  store.observeStatementBytes(OWNER, bytes(like()));
  assert.deepEqual(store.participantsFor("woco.like.v1", SUBJECT.toUpperCase()), [OWNER]);
});

// ── What gets ignored, without throwing ──────────────────────────────────────

test("nothing an observer can be handed makes it throw", () => {
  // It observes a write it must not be able to fail: this is bookkeeping for a
  // view-plane cache riding on a user's like.
  const junk: Uint8Array[] = [
    new TextEncoder().encode("not json at all"),
    new Uint8Array(0),
    bytes(null),
    bytes([1, 2, 3]),
    bytes("a string"),
    bytes(42),
    bytes({}),
  ];
  for (const payload of junk) {
    assert.doesNotThrow(() => store.observeStatementBytes(OWNER, payload));
  }
  assert.deepEqual(store.knownSubjects("woco.like.v1"), []);
});

test("an unknown statement format is not registered", () => {
  store.observeStatementBytes(OWNER, bytes({ format: "woco.post.v1", subject: SUBJECT, value: true }));
  store.observeStatementBytes(OWNER, bytes({ format: "woco.credit-index.v1", subject: SUBJECT }));
  assert.deepEqual(store.knownSubjects("woco.post.v1"), []);
  assert.deepEqual(store.knownSubjects("woco.credit-index.v1"), []);
});

test("a subject that is not a lowercase bytes32 is not registered", () => {
  for (const subject of [SUBJECT.toUpperCase(), SUBJECT.slice(0, 40), `${SUBJECT}ff`, SUBJECT.slice(2), 7]) {
    store.observeStatementBytes(OWNER, bytes({ format: "woco.like.v1", subject, value: true }));
  }
  assert.deepEqual(store.knownSubjects("woco.like.v1"), []);
});

test("an owner that is not an address is not registered", () => {
  for (const owner of ["0xnothex", "0x1234", `0x${"11".repeat(32)}`, ""]) {
    store.observeStatementBytes(owner, bytes(like()));
  }
  assert.deepEqual(store.knownSubjects("woco.like.v1"), []);
});

test("a repeat statement from a known owner does not duplicate them", () => {
  for (let i = 0; i < 5; i++) store.observeStatementBytes(OWNER, bytes(like()));
  assert.deepEqual(store.participantsFor("woco.like.v1", SUBJECT), [OWNER]);
});

// ── Reads are snapshots ──────────────────────────────────────────────────────

test("participantsFor returns a sorted copy the caller cannot mutate the registry through", () => {
  store.__resetParticipants({ "woco.like.v1": { [SUBJECT]: [OWNER_2, OWNER] } });

  const first = store.participantsFor("woco.like.v1", SUBJECT);
  assert.deepEqual(first, [OWNER, OWNER_2]);

  first.push("0xdeadbeef");
  assert.deepEqual(store.participantsFor("woco.like.v1", SUBJECT), [OWNER, OWNER_2]);
});

test("an unknown subject reads as an empty input set, not an error", () => {
  assert.deepEqual(store.participantsFor("woco.like.v1", OTHER_SUBJECT), []);
  assert.deepEqual(store.knownSubjects("woco.nope.v1"), []);
});

test("knownSubjects is sorted", () => {
  store.observeStatementBytes(OWNER, bytes(like(OTHER_SUBJECT)));
  store.observeStatementBytes(OWNER, bytes(like(SUBJECT)));
  assert.deepEqual(store.knownSubjects("woco.like.v1"), [SUBJECT, OTHER_SUBJECT].sort());
});

// ── Ceilings, on BOTH admission paths ────────────────────────────────────────
//
// The numbers mirror the module's declared ceilings. Reached by seeding rather
// than by writing 50,000 statements: what is under test is the refusal, not the
// arithmetic that gets there.

const MAX_PARTICIPANTS_PER_SUBJECT = 50_000;
const MAX_SUBJECTS_PER_FORMAT = 10_000;

test("the relay path refuses a new participant past the per-subject ceiling", () => {
  store.__resetParticipants({ "woco.like.v1": { [SUBJECT]: addresses(MAX_PARTICIPANTS_PER_SUBJECT) } });
  store.observeStatementBytes(OWNER, bytes(like()));
  assert.equal(store.participantsFor("woco.like.v1", SUBJECT).length, MAX_PARTICIPANTS_PER_SUBJECT);
  assert.equal(store.participantsFor("woco.like.v1", SUBJECT).includes(OWNER), false);
});

test("the relay path refuses a NEW subject past the per-format ceiling, but keeps serving known ones", () => {
  const full: Record<string, string[]> = {};
  for (const s of addresses(MAX_SUBJECTS_PER_FORMAT)) full[`0x${s.slice(2).padStart(64, "0")}`] = [];
  const known = Object.keys(full)[0]!;
  store.__resetParticipants({ "woco.like.v1": full });

  store.observeStatementBytes(OWNER, bytes(like(SUBJECT)));
  assert.equal(store.knownSubjects("woco.like.v1").length, MAX_SUBJECTS_PER_FORMAT);
  assert.deepEqual(store.participantsFor("woco.like.v1", SUBJECT), []);

  // Refusing to index a new subject must not stop an existing one growing —
  // otherwise a full registry silently freezes every live count in it.
  store.observeStatementBytes(OWNER, bytes(like(known)));
  assert.deepEqual(store.participantsFor("woco.like.v1", known), [OWNER]);
});

test("the restore path enforces the SAME per-subject ceiling, and reports what it took", () => {
  store.__resetParticipants({
    "woco.like.v1": { [SUBJECT]: addresses(MAX_PARTICIPANTS_PER_SUBJECT - 2) },
  });
  const added = store.mergeParticipants("woco.like.v1", SUBJECT, addresses(5, MAX_PARTICIPANTS_PER_SUBJECT));
  assert.equal(added, 2);
  assert.equal(store.participantsFor("woco.like.v1", SUBJECT).length, MAX_PARTICIPANTS_PER_SUBJECT);
});

test("the restore path refuses a new subject past the per-format ceiling", () => {
  const full: Record<string, string[]> = {};
  for (const s of addresses(MAX_SUBJECTS_PER_FORMAT)) full[`0x${s.slice(2).padStart(64, "0")}`] = [];
  store.__resetParticipants({ "woco.like.v1": full });

  assert.equal(store.mergeParticipants("woco.like.v1", SUBJECT, [OWNER]), 0);
  assert.equal(store.knownSubjects("woco.like.v1").length, MAX_SUBJECTS_PER_FORMAT);
});

// ── The rebuild path ─────────────────────────────────────────────────────────

test("a manifest's participant list restores an input set", () => {
  const recovered = [OWNER_2, OWNER];
  assert.equal(store.mergeParticipants("woco.like.v1", SUBJECT, recovered), 2);
  assert.deepEqual(store.participantsFor("woco.like.v1", SUBJECT), [OWNER, OWNER_2]);
});

test("restoring twice adds nobody twice", () => {
  store.mergeParticipants("woco.like.v1", SUBJECT, [OWNER, OWNER_2]);
  assert.equal(store.mergeParticipants("woco.like.v1", SUBJECT, [OWNER, OWNER_2, OWNER]), 0);
  assert.deepEqual(store.participantsFor("woco.like.v1", SUBJECT), [OWNER, OWNER_2]);
});

test("a restore normalises case and skips entries that are not addresses", () => {
  const added = store.mergeParticipants("woco.like.v1", SUBJECT, [
    OWNER.toUpperCase(),
    "0xnope",
    "",
    OWNER_2,
  ]);
  assert.equal(added, 2);
  assert.deepEqual(store.participantsFor("woco.like.v1", SUBJECT), [OWNER, OWNER_2]);
});

test("a restore re-validates format and subject rather than trusting the caller", () => {
  // The operator surface passes these through from a request body, so this is
  // the check standing between a manifest and an arbitrary registry key.
  assert.equal(store.mergeParticipants("woco.post.v1", SUBJECT, [OWNER]), 0);
  assert.equal(store.mergeParticipants("woco.like.v1", SUBJECT.toUpperCase(), [OWNER]), 0);
  assert.equal(store.mergeParticipants("woco.like.v1", "0x1234", [OWNER]), 0);
  assert.deepEqual(store.knownSubjects("woco.like.v1"), []);
});
