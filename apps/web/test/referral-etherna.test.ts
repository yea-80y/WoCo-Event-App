/**
 * The referee's referral statement on Etherna (#689, family 3), run for real.
 *
 * The REAL records module, verified writer and subject-index read-modify-write
 * run against the faked network (fake-swarm-net.ts); only the transport is
 * swapped, for one that verifies the signed chunk and stamps it where the server
 * would. An Etherna-stamped version reaches our bee only when a test says so.
 *
 * What matters here beyond "it lands on Etherna": `writeReferralStatement` is
 * re-run on every sign-in until a write is confirmed, and its head read decides
 * whether to write at all. Read the way a display read is, it would take our
 * gateway's 404 for a statement still only in Etherna's store and append the
 * same statement again.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  REFERRAL_STATEMENT_FORMAT,
  campaignAccountSubject,
  contentFeedSocIdentifier,
  referralStatementTopic,
  versionedSocIdentifier,
  type Hex0x,
} from "@woco/shared";
import {
  liveDeps,
  readMyReferralStatement,
  writeReferralStatement,
  type CampaignRecordDeps,
} from "../src/lib/campaign/records.js";
import { writeContentFeedVerified } from "../src/lib/swarm/verified-write.js";
import { addToSubjectIndex } from "../src/lib/social/subject-index.js";
import { ETHERNA_GATEWAY_URL } from "../src/lib/swarm/gateways.js";
import {
  OWNER,
  OWNER_PRIV,
  install,
  propagate,
  resetNet,
  restoreNet,
  transport,
  type Net,
} from "./fake-swarm-net.js";

beforeEach(resetNet);
afterEach(restoreNet);

const signer = { privKey: OWNER_PRIV, address: `0x${OWNER}` };
const REFERRER = `0x${"4c".repeat(20)}` as Hex0x;
const SUBJECT = campaignAccountSubject(REFERRER);
const statementAt = (v: number) =>
  versionedSocIdentifier(contentFeedSocIdentifier(referralStatementTopic(SUBJECT)), v);

/** The live deps with the test transport under the writer and the index. */
function deps(send: ReturnType<typeof transport>["transport"]): CampaignRecordDeps {
  return {
    ...liveDeps,
    writeVerified: (args) => writeContentFeedVerified({ ...args, transport: send }),
    addToIndex: (s, subject, kind) => addToSubjectIndex(s, subject, kind, { transport: send }),
  };
}

test("the statement and its index entry are stamped on Etherna", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  const { transport: send, log } = transport(net);

  const res = await writeReferralStatement(signer, REFERRER, deps(send));
  assert.equal(res.status, "verified", JSON.stringify(res));
  assert.equal(log.length, 2, "one statement, one index version");
  for (const s of log) assert.equal(s.gatewayUrl, ETHERNA_GATEWAY_URL);
  assert.equal(net.ourBee.size, 0, "nothing stamped on WoCo");
  const stored = [...net.etherna.values()].find((c) =>
    Buffer.from(c.identifier).equals(Buffer.from(statementAt(0))),
  );
  assert.ok(stored, "the statement is version 0 of the referrer's topic");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(stored.payload)), {
    format: REFERRAL_STATEMENT_FORMAT,
    subject: SUBJECT,
    value: true,
  });
});

test("the next sign-in, before our bee has the statement, does not write it again", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  const { transport: send, log } = transport(net);
  await writeReferralStatement(signer, REFERRER, deps(send));
  const written = log.length;

  resetNet(); // a later sign-in: no version hints, nothing remembered
  install(net);
  const again = await writeReferralStatement(signer, REFERRER, deps(send));
  assert.equal(again.status, "verified");
  assert.equal(again.version, 0, "reported at the statement's own version");
  assert.equal(log.length, written, "no second version of a live statement, and no new index version");
});

test("Etherna unreachable at sign-in: nothing is written, rather than a statement written blind", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  const { transport: send, log } = transport(net);
  await writeReferralStatement(signer, REFERRER, deps(send));
  const written = log.length;

  resetNet();
  net.ethernaDown = true;
  install(net);
  await assert.rejects(writeReferralStatement(signer, REFERRER, deps(send)));
  assert.equal(log.length, written);
});

test("the banner's read: at once on the device that wrote it, on another once our bee has it", async () => {
  const net: Net = { ourBee: new Map(), etherna: new Map() };
  install(net);
  const { transport: send } = transport(net);
  await writeReferralStatement(signer, REFERRER, deps(send));
  assert.deepEqual(await readMyReferralStatement(signer.address), { referrer: REFERRER, subject: SUBJECT });

  resetNet(); // another device
  install(net);
  assert.equal(await readMyReferralStatement(signer.address), null, "a display read trusts our gateway's 404 - the accepted lag");
  propagate(net);
  assert.deepEqual(await readMyReferralStatement(signer.address), { referrer: REFERRER, subject: SUBJECT });
});
