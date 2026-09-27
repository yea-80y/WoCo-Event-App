/**
 * Likes, follows and Interested on Etherna (#689), run for real.
 *
 * The REAL rail (social-core.ts), its verified writer, the banded subject-index
 * read-modify-write and the readers run against the faked network
 * (fake-swarm-net.ts); only the transport is swapped, for one that verifies the
 * signed chunk and stamps it where the server would. An Etherna-stamped version
 * reaches our bee only when a test says so.
 *
 * The statement itself is latest-wins, so a stale read of it costs a display.
 * The subject INDEX is a whole-list rewrite, so a stale read of it erases every
 * subject added since - that is what most of this file is about.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  LAST_VERSION_IN_BAND,
  LIKE_SUBJECT_INDEX_FORMAT,
  contentFeedSocIdentifier,
  followProfileSubject,
  likeSubjectIndexTopic,
  socialEventSubject,
  versionedSocIdentifier,
  type Hex0x,
} from "@woco/shared";
import { kindForVariant, readFollows, readStatement, readSubjects, writeStatement } from "../src/lib/social/social-core.js";
import { ETHERNA_GATEWAY_URL } from "../src/lib/swarm/gateways.js";
import {
  OWNER,
  OWNER_PRIV,
  install,
  propagate,
  resetNet,
  restoreNet,
  serverRequests,
  soc,
  transport,
  type Net,
  type StoredSoc,
} from "./fake-swarm-net.js";

beforeEach(resetNet);
afterEach(restoreNet);

const signer = { privKey: OWNER_PRIV, address: `0x${OWNER}` };
const event = (n: number): Hex0x => socialEventSubject(`0x${n.toString(16).padStart(2, "0").repeat(32)}`);
const A = event(0xa1);
const B = event(0xb2);
const C = event(0xc3);

const indexAt = (v: number) => versionedSocIdentifier(contentFeedSocIdentifier(likeSubjectIndexTopic(0)), v);
const index = (v: number, subjects: Hex0x[]): StoredSoc => soc(indexAt(v), { format: LIKE_SUBJECT_INDEX_FORMAT, subjects });
const put = (store: Map<string, StoredSoc>, chunk: StoredSoc) => void store.set(chunk.address, chunk);

/** The newest like-index version across BOTH stores - the truth, not a reader's view. */
function newestIndex(net: Net): Hex0x[] {
  let last: StoredSoc | undefined;
  for (let v = 0; ; v++) {
    const a = index(v, []).address;
    const chunk = net.ourBee.get(a) ?? net.etherna.get(a);
    if (!chunk) break;
    last = chunk;
  }
  assert.ok(last, "no like index was written");
  return (JSON.parse(new TextDecoder().decode(last.payload)) as { subjects: Hex0x[] }).subjects;
}

test("a like is stamped on Etherna - the statement and its index entry both", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  const { transport: send, log } = transport(net);

  const res = await writeStatement(signer, "like", A, true, { transport: send });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.ok && res.confirmation, "verified", "the read-back found our bytes on Etherna with our bee still empty");
  assert.equal(log.length, 2, "one statement, one index version");
  for (const s of log) assert.equal(s.gatewayUrl, ETHERNA_GATEWAY_URL);
  assert.equal(net.ourBee.size, 0, "nothing stamped on WoCo");
  assert.deepEqual(newestIndex(net), [A]);
});

test("an index entry written minutes ago on another device, still only on Etherna, survives the next like", async () => {
  // WoCo era: [A]. The other device then liked B: its index version sits on Etherna only.
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  put(net.ourBee, index(0, [A]));
  put(net.etherna, index(1, [A, B]));
  install(net);
  const { transport: send } = transport(net);

  const res = await writeStatement(signer, "like", C, true, { transport: send });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(newestIndex(net), [A, B, C]);
});

test("Etherna unreachable for the index read: the like stands, the index is left alone rather than rewritten from a guess", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  put(net.ourBee, index(0, [A]));
  put(net.etherna, index(1, [A, B]));
  const v1 = index(1, []).address;
  let askedV1 = 0;
  // Only the index read's question about version 1 goes unanswered; a writer
  // asking a moment later would get through - and would land [A, C] over [A, B].
  net.ethernaDown = (_nth, address) => address === v1 && askedV1++ === 0;
  install(net);
  const { transport: send, log } = transport(net);

  const res = await writeStatement(signer, "like", C, true, { transport: send });
  assert.equal(res.ok, true, "the statement itself was written");
  assert.equal(log.length, 1, "no index version was written");
  assert.deepEqual(newestIndex(net), [A, B]);
  assert.equal(await readStatement(signer, "like", C), true);
});

test("an unlike is a written `false`, and the subject stays in the index", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  const { transport: send } = transport(net);
  await writeStatement(signer, "like", A, true, { transport: send });
  await writeStatement(signer, "like", A, false, { transport: send });
  assert.equal(await readStatement(signer, "like", A), false);
  assert.deepEqual(await readSubjects(signer, "like"), [A]);
});

test("another device, with no version hint, still shows the state from before the like until our bee has it - the accepted lag", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  const { transport: send } = transport(net);
  await writeStatement(signer, "like", A, true, { transport: send });

  resetNet(); // the other device
  install(net);
  assert.equal(await readStatement(signer, "like", A), null, "a display read trusts our gateway's 404");
  assert.equal((await readFollows(signer)).status, "found");

  for (const [address, chunk] of net.etherna) net.ourBee.set(address, chunk);
  assert.equal(await readStatement(signer, "like", A), true, "and catches up once our bee has it");
});

test("a follow is listed on the device that made it at once, and on another once our bee has it", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  const { transport: send } = transport(net);
  const account = `0x${"d4".repeat(20)}` as Hex0x;
  await writeStatement(signer, "follow", followProfileSubject(account), true, { transport: send });
  assert.equal(net.ourBee.size, 0);

  assert.deepEqual(await readFollows(signer), { status: "found", accounts: [account], unreadable: 0 });

  resetNet(); // another device
  install(net);
  assert.deepEqual(await readFollows(signer), { status: "found", accounts: [], unreadable: 0 }, "the accepted lag");
  propagate(net);
  assert.deepEqual(await readFollows(signer), { status: "found", accounts: [account], unreadable: 0 });
});

// ---------------------------------------------------------------------------
// The writing device reads its own write, without making display reads dear
// ---------------------------------------------------------------------------

test("a FIRST like (version 0) reads back as liked on the device that made it, before our bee has it", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  const { transport: send } = transport(net);
  await writeStatement(signer, "like", A, true, { transport: send });
  assert.equal(await readStatement(signer, "like", A), true);
  assert.deepEqual(await readSubjects(signer, "like"), [A]);
});

test("a subject never liked costs no server request - display reads stay on the cheap path", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  const { transport: send } = transport(net);
  await writeStatement(signer, "like", A, true, { transport: send }); // hints exist for A, none for B
  propagate(net);
  const before = serverRequests().length;
  assert.equal(await readStatement(signer, "like", B), null);
  assert.equal(await readStatement(signer, "like", A), true);
  assert.equal(serverRequests().length, before, "a read asked the server");
});

test("a paged index (59+ subjects) written moments ago reads whole on this device - its pages are not a torn write", async () => {
  const many = Array.from({ length: 58 }, (_, i) => event(i + 1));
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  put(net.ourBee, index(0, many)); // 58 subjects: the last single-chunk size
  install(net);
  const { transport: send, log } = transport(net);

  await writeStatement(signer, "like", event(0xf0), true, { transport: send });
  assert.ok(log.length > 3, `the 59-subject index should page (sent ${log.length} chunks)`);
  const subjects = await readSubjects(signer, "like");
  assert.equal(subjects.length, 59);
});

test("another device's index write landing between our read and our write is kept - both subjects survive", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  put(net.ourBee, index(0, [A]));
  const v1 = index(1, []).address;
  let asked = 0;
  // The other device lands version 1 right after our base read asked about it.
  net.afterServerAnswer = (address) => {
    if (address === v1 && asked++ === 0) put(net.etherna, index(1, [A, B]));
  };
  install(net);
  const { transport: send } = transport(net);

  const res = await writeStatement(signer, "like", C, true, { transport: send });
  assert.equal(res.ok, true);
  assert.deepEqual(newestIndex(net), [A, B, C]);
});

test("a like that opens a new index band reads back on this device before our bee has the new band", async () => {
  // Band 0 full on our bee (WoCo era); the next like writes version 0 of band 1
  // on Etherna. Nothing records a BAND hint on a write, so the new band's
  // opener is known only through the version hint the write stored for it.
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  for (let v = 0; v <= LAST_VERSION_IN_BAND; v++) put(net.ourBee, index(v, [A, B]));
  install(net);
  const { transport: send, log } = transport(net);

  await writeStatement(signer, "like", C, true, { transport: send });
  const band1 = soc(versionedSocIdentifier(contentFeedSocIdentifier(likeSubjectIndexTopic(1)), 0), {}).address;
  assert.ok(log.some((s) => s.address === band1), "the index rolled over into band 1");
  assert.deepEqual(await readSubjects(signer, "like"), [A, B, C]);
});

test("Interested is a like", () => {
  assert.equal(kindForVariant("interested"), "like");
  assert.equal(kindForVariant("follow"), "follow");
});
