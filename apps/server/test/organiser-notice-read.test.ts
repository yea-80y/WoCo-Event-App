/**
 * Whose privacy notice a public page shows, and under which signer
 * (`lib/legal/organiser-notice.ts`, `routes/privacy-notice.ts`).
 *
 * MUTATION: make `carrierFromEventKeys` return the legacy feed's own creator and
 * "a legacy event names nobody" goes red; read the record's signer for a ring and
 * "the ring's signer wins" goes red; skip `validateOrganiserNotice` and "a notice
 * naming another account reads as absent" goes red; let `businessProfileForNotice`
 * read `individual` and "never KYC data" goes red; drop the notice format from the
 * relay gate and "the relay gates notice writes" goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ORGANISER_NOTICE_FORMAT, organiserNoticeContentTopic, type VersionedFeedRead } from "@woco/shared";
import {
  readOrganiserNotice,
  carrierFromEventKeys,
  businessProfileForNotice,
} from "../src/lib/legal/organiser-notice.js";
import { isPrivacyNoticePayload, isSocialPayload } from "../src/lib/swarm/soc-relay-limits.js";

const CREATOR = "0x" + "11".repeat(20);
const SIGNER = "0x" + "22".repeat(20);

function found(obj: unknown): VersionedFeedRead {
  return { status: "found", bytes: new TextEncoder().encode(JSON.stringify(obj)), version: 0, scanClean: true } as VersionedFeedRead;
}
const good = {
  format: ORGANISER_NOTICE_FORMAT,
  address: CREATOR,
  organiserName: "Punk Pub Ltd",
  sharing: ["venue"],
  orderRetentionMonths: 6,
  confirmedAt: "2026-10-11T09:00:00.000Z",
};

test("reads the creator's topic under the given signer, without 0x", async () => {
  const seen: string[][] = [];
  const res = await readOrganiserNotice(CREATOR, SIGNER.toUpperCase().replace("0X", "0x"), async (owner, topic) => {
    seen.push([owner, topic]);
    return found(good);
  });
  assert.equal(res.status, "found");
  assert.deepEqual(seen, [[SIGNER.slice(2), organiserNoticeContentTopic(CREATOR)]]);
});

test("a notice naming another account reads as absent, so the page pre-fills instead", async () => {
  const res = await readOrganiserNotice(CREATOR, SIGNER, async () => found({ ...good, address: "0x" + "33".repeat(20) }));
  assert.equal(res.status, "absent");
  const junk = await readOrganiserNotice(CREATOR, SIGNER, async () => ({
    status: "found", bytes: new TextEncoder().encode("not json"), version: 0, scanClean: true,
  }) as VersionedFeedRead);
  assert.equal(junk.status, "absent");
});

test("absent and unavailable pass through; a throwing reader is unavailable, not absent", async () => {
  assert.equal((await readOrganiserNotice(CREATOR, SIGNER, async () => ({ status: "absent" }))).status, "absent");
  assert.equal((await readOrganiserNotice(CREATOR, SIGNER, async () => ({ status: "unavailable", reason: "x" }))).status, "unavailable");
  assert.equal((await readOrganiserNotice(CREATOR, SIGNER, async () => { throw new Error("down"); })).status, "unavailable");
});

test("the ring's signer wins; a record stands without one; a legacy event names nobody", () => {
  assert.deepEqual(
    carrierFromEventKeys({ kind: "ring", creator: CREATOR, feedSigner: SIGNER }),
    { creator: CREATOR, signer: SIGNER },
  );
  assert.deepEqual(
    carrierFromEventKeys({ kind: "record", creator: CREATOR.toUpperCase().replace("0X", "0x"), feedSigner: SIGNER }),
    { creator: CREATOR, signer: SIGNER },
  );
  assert.equal(carrierFromEventKeys({ kind: "legacy" }), null);
  assert.equal(carrierFromEventKeys({ kind: "unavailable", creator: CREATOR, feedSigner: SIGNER }), "unavailable");
});

test("the route chooses the notice from eventKeys, never from the event feed's own fields", () => {
  const src = readFileSync(new URL("../src/routes/privacy-notice.ts", import.meta.url), "utf-8");
  assert.match(src, /carrierFromEventKeys\(keys\)/);
  // Through the sale gate's cache (lib/legal/notice-gate.ts), so page and checkout agree.
  assert.match(src, /organiserNoticeRead\(carrier\.creator, carrier\.signer\)/);
  assert.doesNotMatch(src, /(readOrganiserNotice|organiserNoticeRead)\([^)]*feed\./);
  assert.doesNotMatch(src, /creatorFeedSigner/);
});

test("prefill reads public business fields only - never KYC data", () => {
  const out = businessProfileForNotice({
    business_type: "company",
    business_profile: {
      name: "Punk Pub",
      support_email: "hello@punkpub.example",
      support_address: { line1: "1 High St", city: "London", postal_code: "E1 1AA", country: "GB", line2: null },
    },
    // @ts-expect-error - not part of the accepted shape, and must never be read
    individual: { address: { line1: "Home" }, email: "me@home.example" },
  });
  assert.deepEqual(out, { name: "Punk Pub", supportEmail: "hello@punkpub.example", supportAddress: "1 High St, London, E1 1AA, GB" });
  assert.deepEqual(businessProfileForNotice({ company: { name: "Punk Pub Ltd" } }), { name: "Punk Pub Ltd" });
  assert.deepEqual(businessProfileForNotice({}), {});
  // A sole trader's support address is often their home: never pre-filled.
  assert.deepEqual(
    businessProfileForNotice({ business_type: "individual", business_profile: { support_address: { line1: "Home" } } }),
    {},
  );
});

test("the relay gates notice writes like a profile save", () => {
  const hex = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("hex");
  assert.equal(isPrivacyNoticePayload(hex(good)), true);
  assert.equal(isPrivacyNoticePayload(hex({ format: "woco.like.v1" })), false);
  assert.equal(isSocialPayload(hex(good)), false);
  const swarm = readFileSync(new URL("../src/routes/swarm.ts", import.meta.url), "utf-8");
  assert.match(swarm, /isSocialPayload\(b\.payload\) \|\| isPrivacyNoticePayload\(b\.payload\)/);
});
