/**
 * The live wiring of ticket-receipt copies, pinned on its source: the feed I/O reads
 * thorough on the `holding` route and counts only verified writes; a passkey removal and
 * an upgrade to a passkey carry every saved receipt, and stop on a partial read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const IO = src("../src/lib/holding/holding-io.ts");
const ROTATE = src("../src/lib/keyring/rotate-live.ts");
const UPGRADE = src("../src/lib/auth/upgrade-to-passkey-live.ts");

function body(text: string, sig: string): string {
  const start = text.indexOf(sig);
  assert.ok(start >= 0, `${sig} must exist`);
  return text.slice(start, text.indexOf("\n      },\n", start));
}

test("feed I/O: the holding route, thorough reads, and only a verified write counts", () => {
  assert.match(IO, /const ROUTE = FEED_ROUTES\.holding;/);
  assert.doesNotMatch(IO, /FEED_ROUTES\.(?!holding)/);
  assert.match(IO, /readContentFeedWriteBase\(owner, topic, \{ route: ROUTE, skipLegacy: true \}\)/);
  assert.match(IO, /readContentFeedResult\(owner, topic, \{ route: ROUTE, skipLegacy: true, thorough: true \}\)/);
  assert.match(IO, /writeAtNextVersion\(\{[\s\S]*route: ROUTE,[\s\S]*base,[\s\S]*build,/);
  assert.match(IO, /return written\.status === "verified" \? "verified" : "unconfirmed";/);
});

test("passkey removal runs a receipts step after the flip", async () => {
  const { AFTER_STEPS } = await import("../src/lib/keyring/rotate.ts");
  assert.ok(AFTER_STEPS.includes("receipts"));
});

test("passkey removal: every generation this device holds, to the new secret, dark while the flag is off", () => {
  const step = body(ROTATE, "receipts: async (keys: NewKeys) => {");
  assert.match(step, /if \(!FEATURES\.holdingReceiptsAllowed\) return;/);
  assert.match(step, /h\.oldSecrets\.map\(\(s\) => holdingGenKeysOf\(s\)\)/);
  // moveHoldingCopies refuses a partial read: nothing is left behind the old keys.
  assert.match(step, /await moveHoldingCopies\(from, await holdingGenKeysOf\(keys\.secret\), liveHoldingFeedIO\);/);
});

test("upgrade: the old seed's receipts read whole or not at all, saved with the keys handed in", () => {
  const read = body(UPGRADE, "readReceipts: async (oldSeed) => {");
  assert.match(read, /if \(!FEATURES\.holdingReceiptsAllowed\) return null;/);
  assert.match(read, /const gen = await holdingGenKeysOf\(oldSeed\);/);
  // A save under the old seed already going in this browser finishes before the read (Fable 3c PR 2, 4).
  const pass = read.indexOf("await liveHoldingFeedIO.exclusive?.(gen.signer.address, async () => {});");
  assert.ok(pass > 0 && pass < read.indexOf("readAllHoldingCopies([gen], liveHoldingFeedIO)"));
  assert.match(read, /if \(!complete\) return "unavailable";/);
  const write = body(UPGRADE, "writeReceipts: async (to, saved) => {");
  assert.match(write, /await writeHoldingCopies\(to, saved, liveHoldingFeedIO\);/);
  assert.doesNotMatch(write, /seed/i, "handed keys, never a seed");
});
