/**
 * The audience screens tell the truth about a soft-opt-in contact (2026-10-14):
 * a fourth state, not "opted in"; the import brings them in; the composer says
 * the permission covers the organiser's own events. By SOURCE SCAN - the
 * components declare `$state`, which Node cannot load.
 *
 * MUTATIONS (each went red, then restored): ContactSearch or AudienceScreen
 * dropping the soft-opt-in set (the contact reads "imported"); the import (now
 * the automatic sync, audience-sync.ts) leaving soft-opt-in buyers out; the
 * composer line shown without a soft-opt-in recipient, or never; the footer note
 * going back to "you opted in" for all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = new URL("../src/lib/creator/audience/", import.meta.url).pathname;
const read = (p: string) => readFileSync(SRC + p, "utf-8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

test("every state reader passes the soft-opt-in set, so such a contact never reads as 'imported'", () => {
  for (const f of ["AudienceScreen.svelte", "ContactSearch.svelte"]) {
    assert.match(code(read(f)), /contactConsentState\(c\.email, suppressedEmails, consentedEmails, softOptInEmails\)/, f);
  }
  const screen = code(read("AudienceScreen.svelte"));
  assert.match(screen, /softOptInEmails = new Set\(res\.softOptIn \?\? \[\]\)/);
  assert.match(screen, /"soft-opt-in": 0,/);
  assert.match(screen, /<ContactSearch[\s\S]*?\{softOptInEmails\}/);
  assert.match(screen, /<MarketingComposer [^>]*\{softOptInEmails\}/);
});

test("the fourth state has its own words: bought a ticket and didn't opt out, own similar events only", () => {
  const detail = code(read("ContactDetail.svelte"));
  assert.match(detail, /"soft-opt-in":\s*"Bought a ticket and didn't tick \\"Don't email me\\" at checkout\. Email them only about your own similar events\. "/);
  assert.match(detail, /"soft-opt-in": "didn't opt out"/);
  assert.doesNotMatch(detail, /consent\.replace\(/, "the tag is a label, never the raw state name");
  const ledger = code(read("ConsentLedger.svelte"));
  assert.match(ledger, /state: "soft-opt-in",\s*label: "Didn't opt out",/);
  assert.match(ledger, /Email them only about your own similar events/);
  const search = code(read("ContactSearch.svelte"));
  assert.match(search, /\{:else if s === "soft-opt-in"\}\s*<span class="chip chip--in">didn't opt out<\/span>/);
});

test("the automatic add takes soft-opt-in buyers, and its copy no longer says buying is never permission", () => {
  // The manual per-event import became the automatic sync (2026-10-14); the same basis rule moved with it.
  const sync = code(read("audience-sync.ts"));
  assert.match(sync, /\[\.\.\.lower\(answer\.consented\), \.\.\.lower\(answer\.softOptIn\)\]\.filter\(\(e\) => !suppressed\.has\(e\)\)/);
  const status = code(read("AudienceSyncStatus.svelte"));
  assert.doesNotMatch(status, /not permission to market|ticked the marketing box at checkout can join/);
  assert.match(status, /those who didn't tick\s+"Don't email me"/);
});

test("the composer: one line when the audience includes soft-opt-in contacts, and a footer note true for both", () => {
  const c = code(read("MarketingComposer.svelte"));
  assert.match(c, /recipients\.filter\(\(r\) => softOptInEmails\.has\(r\.email\.trim\(\)\.toLowerCase\(\)\)\)\.length/);
  const block = c.slice(c.indexOf("{#if softOptInCount > 0}"));
  assert.ok(c.includes("{#if softOptInCount > 0}"));
  assert.match(block.slice(0, block.indexOf("{/if}")), /Only about your own events/);
  assert.doesNotMatch(c, /carries a "you opted in to updates from/);
  assert.match(c, /or bought a ticket and didn't opt out/);
});

test("new audience copy keeps the register: spaced hyphen, never an em or en dash", () => {
  const lines = [
    ...read("ContactDetail.svelte").split("\n").filter((l) => /soft-opt-in|Don't email me/.test(l)),
    ...read("ConsentLedger.svelte").split("\n").filter((l) => /Don't email me|Didn't opt out/.test(l)),
    ...read("AudienceSyncStatus.svelte").split("\n").filter((l) => /said yes|said no|Don't email me/.test(l)),
    ...read("MarketingComposer.svelte").split("\n").filter((l) => /own events|didn't opt out|three things the law/.test(l)),
  ];
  assert.ok(lines.length >= 8);
  for (const l of lines) assert.doesNotMatch(l, /[–—]/, l);
});
