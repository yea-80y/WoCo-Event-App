/**
 * Marketing consent records are kept "while the organiser can still mail you on
 * that basis, plus 6 months" (Privacy Policy §10, #547). The basis ends at the
 * suppression that made the address unmailable; nothing else ends it.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let originalCwd: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let consent: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let suppression: any;

const ORG = "0x" + "aa".repeat(20);
const OTHER = "0x" + "bb".repeat(20);
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-06T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const record = (ts: string) => ({ ts, source: "checkout" as const, notice: "Yes, send me news", version: 1 });

before(async () => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "woco-547-"));
  // Both stores capture `join(process.cwd(), ".data")` at module load.
  process.chdir(dir);
  consent = await import("../src/lib/marketing/consent-store.js");
  suppression = await import("../src/lib/marketing/suppression-store.js");
});

after(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

test("suppressedSince: none, per-organiser, the earlier of global and per-organiser, never a lifted mark", () => {
  assert.equal(suppression.suppressedSince("h-none", ORG), null);
  suppression.suppressOrg("h-org", ORG, "unsub", ago(10));
  assert.equal(suppression.suppressedSince("h-org", ORG), ago(10));
  assert.equal(suppression.suppressedSince("h-org", OTHER), null, "per-organiser marks stay with that organiser");

  suppression.suppressOrg("h-both", ORG, "unsub", ago(3));
  suppression.suppressGlobal("h-both", "bounce"); // stamped now: later than the org mark
  assert.equal(suppression.suppressedSince("h-both", ORG), ago(3));

  suppression.suppressOrg("h-lifted", ORG, "declined", ago(400));
  assert.equal(suppression.liftDeclineOnConsent("h-lifted", ORG, ago(300)), true);
  assert.equal(suppression.suppressedSince("h-lifted", ORG), null, "a decline superseded by consent is not an end");
});

test("the sweep drops only records whose basis ended more than six months ago", () => {
  const ends: Record<string, string | null> = {
    "c-ended-7m": ago(213),
    "c-ended-5m": ago(150),
    "c-standing-5y": null,
  };
  consent.recordConsent("c-ended-7m", ORG, record(ago(400)));
  consent.recordConsent("c-ended-5m", ORG, record(ago(400)));
  consent.recordConsent("c-standing-5y", ORG, record(ago(5 * 365)));

  const dropped = consent.sweepExpiredConsents((h: string) => ends[h] ?? null, NOW);
  assert.equal(dropped, 1);
  assert.equal(consent.getConsent("c-ended-7m", ORG), null);
  assert.ok(consent.getConsent("c-ended-5m", ORG), "inside the six months: kept");
  assert.ok(consent.getConsent("c-standing-5y", ORG), "a basis that still stands is kept however old");

  const onDisk = JSON.parse(readFileSync(join(dir, ".data", "marketing-consent.json"), "utf-8"));
  assert.equal(onDisk[ORG.toLowerCase()]["c-ended-7m"], undefined, "the drop is persisted");
});

test("end to end: an unsubscribe over six months old ends the record; another organiser's record stays", () => {
  consent.recordConsent("c-e2e", ORG, record(ago(500)));
  consent.recordConsent("c-e2e", OTHER, record(ago(500)));
  suppression.suppressOrg("c-e2e", ORG, "unsub", ago(200));

  consent.sweepExpiredConsents(undefined, NOW);
  assert.equal(consent.getConsent("c-e2e", ORG), null);
  assert.ok(consent.getConsent("c-e2e", OTHER), "an unsubscribe from one organiser ends only that basis");
});
