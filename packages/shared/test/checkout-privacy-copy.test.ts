/**
 * The checkout privacy notes are point-of-collection disclosures, shown in the
 * app, on organiser websites and in the embed widget. Two ways they went wrong:
 * the order details read as "public" (they are sealed - only the network is
 * public), and "anything you enter here ... WoCo cannot read it" covered the
 * email, which reaches WoCo and Stripe in plaintext (DATA_INVENTORY §4).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHECKOUT_PRIVACY_DETAIL, CHECKOUT_PRIVACY_SUMMARY, PAY_PANEL_PRIVACY_SUMMARY } from "../src/legal/consent.js";

const NOTES = { CHECKOUT_PRIVACY_SUMMARY, PAY_PANEL_PRIVACY_SUMMARY };

test("only the onchain record is called public; buyer details never are", () => {
  for (const [name, note] of Object.entries(NOTES)) {
    for (const m of note.matchAll(/\bpublic\b/gi)) {
      assert.match(note.slice(m.index - 30, m.index + 20), /onchain record is public and permanent/, name);
    }
  }
  assert.match(CHECKOUT_PRIVACY_SUMMARY, /stored sealed on a decentralised network/);
});

test("both notes say WoCo and Stripe receive the email", () => {
  for (const [name, note] of Object.entries(NOTES)) {
    assert.match(note, /WoCo uses your email to send your ticket, and Stripe receives it with your payment\./, name);
  }
  assert.doesNotMatch(CHECKOUT_PRIVACY_SUMMARY, /anything you enter/i);
});

test("the order-form summary is the organiser sentence plus the detail, so a named organiser loses nothing", () => {
  assert.ok(CHECKOUT_PRIVACY_SUMMARY.endsWith(` ${CHECKOUT_PRIVACY_DETAIL}`));
  assert.match(CHECKOUT_PRIVACY_SUMMARY, /^Your details go to the event organiser, who is responsible for them\. /);
});
