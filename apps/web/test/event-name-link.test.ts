/**
 * An announcement email links to the event's WoCo name only when that name's
 * content is THIS event's page feed (#576 follow-up). The fixture is the real
 * feed-manifest root chunk of hackathon.woco.eth (event 43becb36, 2026-10-06).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { eventNameUrl, feedOfManifestChunk, type EventNameDeps } from "../src/lib/sub-ens/event-name-link.js";

const HACKATHON_MANIFEST = Uint8Array.from(Buffer.from(
  "800100000000000000000000000000000000000000000000000000000000000000000000000000005768b3b6a7db56d21d1abff40d41cebfc83448fed8d7e9b06ec0d3b073f28f200000000000000000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000012012f00000000000000000000000000000000000000000000000000000000008504f2a107ca940beafc4ce2f6c9a9f0968c62a5b5893ff0e4e1e2983048d27600be7b22737761726d2d666565642d6f776e6572223a2264616332666637373163333836376436343633633237646461383238356137333831316538383334222c22737761726d2d666565642d746f706963223a2233386664633365323361393135376237646363303531363635303833396231373336363832383831383130363236383535643130623464653232393964323037222c22737761726d2d666565642d74797065223a2253657175656e6365227d0a0a0a0a0a0a0a0a0a0a0a0a",
  "hex",
));
const EVENT_ID = "43becb36-2b71-4d55-bf23-6c18b6bed32f";
const SIGNER = "0xDAC2ff771c3867d6463c27dda8285a73811e8834";
const HASH = "d24237682b360376b613321850e4e5e035823d68b2659392afea95162e7ca0b7";

function deps(names: { label: string; contentHash?: string; role?: string }[], chunks: Record<string, Uint8Array | null>): EventNameDeps {
  return {
    ownedNames: async () => names.map((n) => ({ ensName: `${n.label}.woco.eth`, ...n })) as never,
    chunk: async (h) => chunks[h] ?? null,
  };
}

test("reads the feed a real manifest chunk follows", () => {
  assert.deepEqual(feedOfManifestChunk(HACKATHON_MANIFEST), {
    owner: "dac2ff771c3867d6463c27dda8285a73811e8834",
    topic: "38fdc3e23a9157b7dcc0516650839b1736682881810626855d10b4de2299d207",
  });
  assert.equal(feedOfManifestChunk(new Uint8Array(64)), null);
});

test("an obfuscated manifest (non-zero key) or another feed type reads as no feed", () => {
  const obfuscated = HACKATHON_MANIFEST.map((b, i) => (i >= 40 ? b ^ 0x5a : b));
  assert.equal(feedOfManifestChunk(obfuscated), null);
  const epoch = new TextEncoder().encode(
    '{"swarm-feed-owner":"dac2ff771c3867d6463c27dda8285a73811e8834","swarm-feed-topic":"' + "ab".repeat(32) + '","swarm-feed-type":"Epoch"}',
  );
  assert.equal(feedOfManifestChunk(epoch), null);
});

test("the name whose content is this event's page feed is the link", async () => {
  const url = await eventNameUrl(
    { eventId: EVENT_ID, creatorFeedSigner: SIGNER },
    deps([{ label: "other" }, { label: "hackathon", contentHash: HASH, role: "url" }], { [HASH]: HACKATHON_MANIFEST }),
  );
  assert.match(url ?? "", /^https:\/\/hackathon\./);
});

test("a name on another event's page, another owner's feed, or a profile name is not", async () => {
  const names = [{ label: "hackathon", contentHash: HASH, role: "url" }];
  const chunks = { [HASH]: HACKATHON_MANIFEST };
  assert.equal(await eventNameUrl({ eventId: "another-event", creatorFeedSigner: SIGNER }, deps(names, chunks)), null);
  assert.equal(await eventNameUrl({ eventId: EVENT_ID, creatorFeedSigner: "0x" + "11".repeat(20) }, deps(names, chunks)), null);
  assert.equal(await eventNameUrl({ eventId: EVENT_ID, creatorFeedSigner: SIGNER }, deps([{ ...names[0], role: "profile" }], chunks)), null);
});

test("no feed signer, or an unreadable chunk, falls back (null) rather than guessing", async () => {
  const names = [{ label: "hackathon", contentHash: HASH, role: "url" }];
  assert.equal(await eventNameUrl({ eventId: EVENT_ID }, deps(names, { [HASH]: HACKATHON_MANIFEST })), null);
  assert.equal(await eventNameUrl({ eventId: EVENT_ID, creatorFeedSigner: SIGNER }, deps(names, {})), null);
});
