/**
 * What the chain says about a name, read in one batch for the share sheet.
 *
 * Every decision here fails closed: a name whose holder cannot be read has no
 * holder, a name whose contenthash cannot be read does not load, and a read
 * that failed as a whole is unknown (null), never "nobody holds these".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readNameRecords, type RawRecord } from "../src/lib/sub-ens/name-records.js";

const HOLDER = "0xAbCdEf0000000000000000000000000000000001";
const CONTENT = "0xe40101fa011b20" + "ab".repeat(32);
const ok = (result: string) => ({ status: "success" as const, result });
const failed = { status: "failure" as const };
const answer = (raw: RawRecord[]) => async () => raw;

test("a held name that points somewhere", async () => {
  const records = await readNameRecords(["punkpub"], answer([{ owner: ok(HOLDER), contenthash: ok(CONTENT) }]));
  assert.deepEqual(records, [{ label: "punkpub", owner: HOLDER.toLowerCase(), points: true }]);
});

test("an unset contenthash does not load", async () => {
  const records = await readNameRecords(["spare"], answer([{ owner: ok(HOLDER), contenthash: ok("0x") }]));
  assert.equal(records?.[0]?.points, false);
});

test("a name whose owner lookup reverted has no holder", async () => {
  const records = await readNameRecords(["released"], answer([{ owner: failed, contenthash: ok(CONTENT) }]));
  assert.equal(records?.[0]?.owner, null);
});

test("a contenthash that could not be read does not load", async () => {
  const records = await readNameRecords(["punkpub"], answer([{ owner: ok(HOLDER), contenthash: failed }]));
  assert.equal(records?.[0]?.points, false);
});

test("a read that fails as a whole is unknown, not empty", async () => {
  const records = await readNameRecords(["punkpub"], async () => { throw new Error("rpc down"); });
  assert.equal(records, null);
});

test("an answer that does not cover every name is refused", async () => {
  const records = await readNameRecords(["one-name", "two-name"], answer([{ owner: ok(HOLDER), contenthash: ok(CONTENT) }]));
  assert.equal(records, null);
});

test("each name is asked once, in lower case", async () => {
  const asked: string[][] = [];
  await readNameRecords(["PunkPub", "punkpub", "spare"], async (labels) => {
    asked.push([...labels]);
    return labels.map(() => ({ owner: ok(HOLDER), contenthash: ok(CONTENT) }));
  });
  assert.deepEqual(asked, [["punkpub", "spare"]]);
});

test("no names means no read", async () => {
  let called = false;
  const records = await readNameRecords([], async () => { called = true; return []; });
  assert.deepEqual(records, []);
  assert.equal(called, false);
});
