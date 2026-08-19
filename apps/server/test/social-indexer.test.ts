/**
 * The indexer — public feeds in, a recountable number out (`lib/social/indexer.ts`).
 *
 * The pure tally rules are covered in `packages/shared/test/statement/tally.test.ts`.
 * What is NOT covered there, and is covered here, is everything the indexer does
 * AROUND them — which is where the trust model actually lives:
 *
 *   - An unreadable feed is a GAP, never silence. A count computed over an
 *     incomplete read is the best available answer; presenting it as complete
 *     would be the lie the whole evidence apparatus exists to prevent. `absent`
 *     and `unavailable` therefore have to stay apart all the way out.
 *   - A statement is ACCEPTED or it is not counted. For credits that means
 *     `holderSig` verifying — the check standing between a count and anyone
 *     writing someone else's history into their own feed.
 *   - Credits are read at the PUBLIC salt only. A private credit is not merely
 *     skipped, it is unaddressable, and a test that lets the topic drift would
 *     let that property drift with it.
 *   - The manifest recounts. `recountManifest` over what the indexer publishes
 *     must reproduce the headline, or the published evidence does not support
 *     the number.
 *
 * Feeds are injected (`StatementFeedReader`) for the reason `site/service.ts`
 * injects its readers: a live Swarm read cannot be made to fail on demand, and
 * the failure paths are the ones worth pinning.
 *
 * The participant registry writes `.data/` relative to process.cwd(), so this
 * suite chdirs into a temp dir BEFORE importing anything that loads it.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  likeStatementTopic,
  followStatementTopic,
  creditStatementTopic,
  creditPublicSalt,
  creditPrivateSalt,
  signCreditStatement,
  recountManifest,
  type CarriedEvidenceLeaf,
  type BooleanEvidenceLeaf,
  type CreditStatementV1,
  type UnsignedCreditStatementV1,
  type EvidenceManifestV1,
  type VersionedFeedRead,
  type Hex0x,
} from "@woco/shared";
// Type-only: erased at runtime, so it cannot load the module before the chdir.
import type { StatementFeedReader } from "../src/lib/social/indexer.js";

let indexer: typeof import("../src/lib/social/indexer.js");
let participants: typeof import("../src/lib/social/participants.js");

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-social-indexer-")));
  participants = await import("../src/lib/social/participants.js");
  indexer = await import("../src/lib/social/indexer.js");
});

beforeEach(() => participants.__resetParticipants());

const SUBJECT = `0x${"a1".repeat(32)}` as Hex0x;
const ALICE = `0x${"11".repeat(20)}`;
const BOB = `0x${"22".repeat(20)}`;
const CAROL = `0x${"33".repeat(20)}`;

/**
 * ed25519 public key for a seed, via node:crypto rather than a curve library.
 *
 * Not preference: this workspace resolves `@noble/curves` to a v1 copy whose
 * exports map has no `./ed25519.js`, while `@woco/shared` resolves its own v2.
 * Signing therefore stays inside shared (`signCreditStatement`) and the test
 * only needs the public half — which the platform can derive, and which
 * `signCreditStatement` cross-checks by refusing a mismatched holder.
 */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
function publicKeyHex(seed: Uint8Array): string {
  const priv = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  return spki.subarray(spki.length - 32).toString("hex");
}

/** Deterministic holder keys — the same statement must digest identically on
 *  every run, since closure 5's tie-break is defined over that digest. */
const RIDER_KEY = new Uint8Array(32).fill(7);
const RIDER = publicKeyHex(RIDER_KEY);
const OTHER_KEY = new Uint8Array(32).fill(9);
const OTHER_RIDER = publicKeyHex(OTHER_KEY);

const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

function seed(format: string, owners: string[], subject: Hex0x = SUBJECT): void {
  participants.__resetParticipants({ [format]: { [subject]: owners } });
}

/**
 * A reader over a fixed owner -> answer map, recording the topics it was asked
 * for. An owner with no entry reads as `absent` — declared but silent.
 */
function readerOver(answers: Record<string, VersionedFeedRead | (() => Promise<never>)>) {
  const topics: string[] = [];
  // The indexer now asks for a topic FAMILY and walks to the open band itself.
  // These fixtures live in band 0, so recording `topicForBand(0)` keeps the
  // assertions about WHICH feed was read — the thing they exist to pin.
  const read: StatementFeedReader = async (owner, topicForBand) => {
    topics.push(topicForBand(0));
    const answer = answers[owner.toLowerCase()];
    if (typeof answer === "function") return answer();
    return { ...(answer ?? { status: "absent" as const }), band: 0 };
  };
  return { read, topics };
}

const found = (value: unknown, version: number): VersionedFeedRead => ({
  status: "found",
  bytes: encode(value),
  version,
});

const likeStatement = (value: boolean, subject: Hex0x = SUBJECT) => ({
  format: "woco.like.v1",
  subject,
  value,
});

function credit(over: Partial<UnsignedCreditStatementV1> = {}, key = RIDER_KEY): CreditStatementV1 {
  return signCreditStatement(
    {
      format: "woco.credit.v1",
      subject: SUBJECT,
      holder: publicKeyHex(key),
      seq: 1,
      total: 1,
      session: { date: "2026-09-01", count: 1 },
      ...over,
    } as UnsignedCreditStatementV1,
    key,
  );
}

const booleanLeaves = (m: EvidenceManifestV1<unknown>) => m.leaves as BooleanEvidenceLeaf[];
const carriedLeaves = (m: EvidenceManifestV1<unknown>) => m.leaves as CarriedEvidenceLeaf[];

// ── Boolean statements: likes and follows ────────────────────────────────────

test("a like counts once per feed owner, and a retraction is input that does not count", async () => {
  seed("woco.like.v1", [ALICE, BOB, CAROL]);
  const { read } = readerOver({
    [ALICE]: found(likeStatement(true), 3),
    [BOB]: found(likeStatement(false), 8),
    [CAROL]: found(likeStatement(true), 0),
  });

  const res = await indexer.indexSubject("woco.like.v1", SUBJECT, read);
  assert.equal(res.manifest.count, 2);
  // The retraction is PUBLISHED, not dropped: an auditor checking "was my
  // unlike read?" needs to see the `false`.
  assert.equal(res.manifest.leaves.length, 3);
  assert.deepEqual(
    booleanLeaves(res.manifest).map((l) => [l.feedOwner, l.value]),
    [
      [ALICE, true],
      [BOB, false],
      [CAROL, true],
    ],
  );
  assert.equal(recountManifest(res.manifest).consistent, true);
});

test("a leaf digest is keccak256 of the raw stored bytes, exactly as the recipe states", async () => {
  // A second indexer cannot produce a comparable manifest against a recipe only
  // our source knows, so the published recipe is what is asserted here.
  seed("woco.like.v1", [ALICE]);
  const raw = encode(likeStatement(true));
  const { read } = readerOver({ [ALICE]: { status: "found", bytes: raw, version: 2 } });

  const res = await indexer.indexSubject("woco.like.v1", SUBJECT, read);
  assert.equal(booleanLeaves(res.manifest)[0]!.digest, `0x${bytesToHex(keccak_256(raw))}`);
  assert.equal(booleanLeaves(res.manifest)[0]!.version, 2);
});

test("a payload that is not this exact statement format is not counted", async () => {
  seed("woco.like.v1", [ALICE, BOB, CAROL]);
  const { read } = readerOver({
    // A follow read at the like topic — right shape, wrong format.
    [ALICE]: found({ format: "woco.follow.v1", subject: SUBJECT, value: true }, 1),
    // The closed schema rejects an added field rather than ignoring it.
    [BOB]: found({ ...likeStatement(true), note: "hi" }, 1),
    // Bytes that are not JSON at all.
    [CAROL]: { status: "found", bytes: new TextEncoder().encode("<html>nope"), version: 1 },
  });

  const res = await indexer.indexSubject("woco.like.v1", SUBJECT, read);
  assert.equal(res.manifest.count, 0);
  assert.deepEqual(res.manifest.leaves, []);
  // Read fine, said nothing usable — that is silence, not a gap.
  assert.deepEqual(res.unreadable, []);
});

test("a statement naming another subject is not counted for this one", async () => {
  // The address binds it already, so this looks redundant — and for booleans it
  // nearly is, since a mislabelled write buys the one vote a correct write
  // would. It is checked anyway because the RULE has to be the same one a
  // reader applies: the page fetches an entry and compares its subject, so an
  // indexer that accepted what the page rejects would render a red
  // contradiction over an honest count.
  seed("woco.like.v1", [ALICE, BOB]);
  const { read } = readerOver({
    [ALICE]: found(likeStatement(true, `0x${"cc".repeat(32)}` as Hex0x), 1),
    [BOB]: found(likeStatement(true), 1),
  });

  const res = await indexer.indexSubject("woco.like.v1", SUBJECT, read);
  assert.equal(res.manifest.count, 1);
  assert.deepEqual(booleanLeaves(res.manifest).map((l) => l.feedOwner), [BOB]);
});

test("a credit naming another coaster cannot put its laps on this one", async () => {
  // The sharp version, and the reason the check is not optional. A rider signs
  // a statement about a DIFFERENT coaster with any total they like and stores
  // it at this coaster's head: signature valid, schema valid, and without this
  // the total lands in this coaster's count. It then fails the page's own
  // entry check, so an honest count gets a manufactured contradiction over it.
  seed("woco.credit.v1", [ALICE, BOB]);
  const elsewhere = credit({ subject: `0x${"cc".repeat(32)}` as Hex0x, total: 100_000 });
  const { read } = readerOver({
    [ALICE]: found(elsewhere, 1),
    [BOB]: found(credit({ total: 7 }, OTHER_KEY), 1),
  });

  const res = await indexer.indexSubject("woco.credit.v1", SUBJECT, read);
  assert.equal(res.manifest.count, 7);
  assert.deepEqual(carriedLeaves(res.manifest).map((l) => l.holder), [OTHER_RIDER]);
});


test("follows tally under their own topic, separately from likes", async () => {
  seed("woco.follow.v1", [ALICE]);
  const { read, topics } = readerOver({
    [ALICE]: found({ format: "woco.follow.v1", subject: SUBJECT, value: true }, 1),
  });

  const res = await indexer.indexSubject("woco.follow.v1", SUBJECT, read);
  assert.equal(res.manifest.count, 1);
  assert.deepEqual(topics, [followStatementTopic(SUBJECT)]);
  assert.notEqual(followStatementTopic(SUBJECT), likeStatementTopic(SUBJECT));
});

// ── Gaps: an incomplete read is never presented as a complete one ────────────

test("a feed that could not be read is a gap; one read and empty is not", async () => {
  seed("woco.like.v1", [ALICE, BOB, CAROL]);
  const { read } = readerOver({
    [ALICE]: found(likeStatement(true), 1),
    [BOB]: { status: "unavailable", reason: "bee timeout" },
    [CAROL]: { status: "absent" },
  });

  const res = await indexer.indexSubject("woco.like.v1", SUBJECT, read);
  assert.deepEqual(res.unreadable, [BOB]);
  assert.equal(res.manifest.count, 1);
  // The gap stays IN the declared input set: hiding it would make the count
  // look complete over a smaller set, which is the failure being avoided.
  assert.deepEqual(res.manifest.participants, [ALICE, BOB, CAROL].sort());
});

test("a reader that throws costs one participant, not the tally", async () => {
  seed("woco.like.v1", [ALICE, BOB]);
  const { read } = readerOver({
    [ALICE]: found(likeStatement(true), 1),
    [BOB]: async () => {
      throw new Error("socket hang up");
    },
  });

  const res = await indexer.indexSubject("woco.like.v1", SUBJECT, read);
  assert.equal(res.manifest.count, 1);
  assert.deepEqual(res.unreadable, [BOB]);
});

test("gaps are published in a stable order, however the reads raced", async () => {
  // Served as part of the same evidence object as the manifest; evidence that
  // reshuffles between two identical passes is not comparable.
  seed("woco.like.v1", [CAROL, ALICE, BOB]);
  const gaps: VersionedFeedRead = { status: "unavailable" };
  const { read } = readerOver({ [ALICE]: gaps, [BOB]: gaps, [CAROL]: gaps });

  const res = await indexer.indexSubject("woco.like.v1", SUBJECT, read);
  assert.deepEqual(res.unreadable, [ALICE, BOB, CAROL].sort());
});

test("a subject nobody is known to have written about is uncomputable-empty, not an error", async () => {
  const { read, topics } = readerOver({});
  const res = await indexer.indexSubject("woco.like.v1", SUBJECT, read);

  assert.equal(res.manifest.count, 0);
  assert.deepEqual(res.manifest.participants, []);
  assert.deepEqual(res.unreadable, []);
  assert.deepEqual(topics, [], "no participants means no addresses to read");
});

// ── Credits: the identity signature is the linchpin ──────────────────────────

test("credits are read at the PUBLIC salt, so a private credit is unaddressable", async () => {
  seed("woco.credit.v1", [ALICE]);
  const { read, topics } = readerOver({ [ALICE]: found(credit(), 1) });

  await indexer.indexSubject("woco.credit.v1", SUBJECT, read);
  assert.deepEqual(topics, [creditStatementTopic(creditPublicSalt(), SUBJECT, 0)]);
  assert.notEqual(
    topics[0],
    creditStatementTopic(creditPrivateSalt(new Uint8Array(32).fill(4)), SUBJECT, 0),
    "a private head derives from a salt only the rider holds — the indexer cannot address it",
  );
});

test("a statement naming a holder who did not sign it is refused", async () => {
  seed("woco.credit.v1", [ALICE, BOB]);
  const honest = credit({ total: 4 });
  // Signed by RIDER, then relabelled as OTHER_RIDER: the exact forgery the
  // holder signature exists to stop, and it is what stands between a count and
  // anyone writing anyone else's history into their own feed.
  const forged = { ...credit({ total: 900 }), holder: OTHER_RIDER };

  const { read } = readerOver({ [ALICE]: found(honest, 1), [BOB]: found(forged, 1) });
  const res = await indexer.indexSubject("woco.credit.v1", SUBJECT, read);

  assert.equal(res.manifest.count, 4);
  assert.deepEqual(carriedLeaves(res.manifest).map((l) => l.holder), [RIDER]);
});

test("a tampered total is refused, because the signature covers it", async () => {
  seed("woco.credit.v1", [ALICE]);
  const { read } = readerOver({ [ALICE]: found({ ...credit({ total: 2 }), total: 200 }, 1) });

  const res = await indexer.indexSubject("woco.credit.v1", SUBJECT, read);
  assert.equal(res.manifest.count, 0);
  assert.deepEqual(res.manifest.leaves, []);
});

test("totals are carried, never summed across a rider's own writes", async () => {
  // Eight taps must read as eight laps, not as the sum of eight running totals.
  seed("woco.credit.v1", [ALICE, BOB]);
  const { read } = readerOver({
    [ALICE]: found(credit({ seq: 3, total: 8 }), 3),
    // Same rider, second device, older statement.
    [BOB]: found(credit({ seq: 2, total: 5 }), 1),
  });

  const res = await indexer.indexSubject("woco.credit.v1", SUBJECT, read);
  assert.equal(res.manifest.count, 8);
  assert.equal(res.manifest.leaves.length, 1);
  assert.equal(carriedLeaves(res.manifest)[0]!.seq, 3);
});

test("two riders' totals add up, and the manifest recounts to the headline", async () => {
  seed("woco.credit.v1", [ALICE, BOB]);
  const { read } = readerOver({
    [ALICE]: found(credit({ total: 109 }), 1),
    [BOB]: found(credit({ total: 3 }, OTHER_KEY), 1),
  });

  const res = await indexer.indexSubject("woco.credit.v1", SUBJECT, read);
  assert.equal(res.manifest.count, 112);
  assert.deepEqual(recountManifest(res.manifest), { consistent: true, recounted: 112 });
  assert.deepEqual(res.equivocations, []);
});

test("a rider signing two different statements at one seq is surfaced, not smoothed", async () => {
  seed("woco.credit.v1", [ALICE, BOB]);
  const a = credit({ seq: 4, total: 10 });
  const b = credit({ seq: 4, total: 99 });
  const { read } = readerOver({ [ALICE]: found(a, 1), [BOB]: found(b, 1) });

  const res = await indexer.indexSubject("woco.credit.v1", SUBJECT, read);
  assert.deepEqual(res.equivocations, [RIDER]);
  // Deterministic and lossless: the lower canonical digest wins, so two honest
  // indexers resolve the same device race the same way.
  assert.equal(res.manifest.leaves.length, 1);
  assert.equal(recountManifest(res.manifest).consistent, true);
});

test("boolean tallies never report equivocation", async () => {
  // A SOC is immutable, so one feed cannot hold two statements at one version —
  // there is no tie to break and nothing to report.
  seed("woco.like.v1", [ALICE]);
  const { read } = readerOver({ [ALICE]: found(likeStatement(true), 1) });
  const res = await indexer.indexSubject("woco.like.v1", SUBJECT, read);
  assert.deepEqual(res.equivocations, []);
});
