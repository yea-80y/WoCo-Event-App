/**
 * The service-notice taxonomy is shared because the server enforces it and the
 * composer renders it. These pin the properties that would break quietly if the
 * two drifted — a category with no label renders as a blank option in the
 * picker, and a subject the server composes differently from the one the
 * organiser was shown is a message they did not agree to send.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SERVICE_NOTICE_TYPES,
  SERVICE_NOTICE_LABELS,
  isServiceNoticeType,
  serviceNoticeSubject,
  serviceNoticeDisclosure,
} from "../../src/marketing/service-notice.js";

test("every category has a label — a new one cannot render as a blank option", () => {
  for (const t of SERVICE_NOTICE_TYPES) {
    const label = SERVICE_NOTICE_LABELS[t];
    assert.ok(label && label.trim().length > 0, `no label for "${t}"`);
  }
  assert.equal(
    Object.keys(SERVICE_NOTICE_LABELS).length,
    SERVICE_NOTICE_TYPES.length,
    "labels and categories are out of step",
  );
});

test("every category composes a non-empty subject naming the event", () => {
  for (const t of SERVICE_NOTICE_TYPES) {
    const subject = serviceNoticeSubject(t, "Basement Sessions 04");
    assert.ok(subject.includes("Basement Sessions 04"), `subject for "${t}" omits the event`);
    assert.ok(subject.length > "Basement Sessions 04".length, `subject for "${t}" adds nothing`);
  }
});

test("the guard accepts exactly the declared categories and nothing else", () => {
  for (const t of SERVICE_NOTICE_TYPES) assert.equal(isServiceNoticeType(t), true);
  for (const bad of ["other", "important_update", "", "CANCELLED", null, undefined, 1, {}]) {
    assert.equal(isServiceNoticeType(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

test("there is no catch-all category — a free-pick option would defeat the taxonomy", () => {
  for (const t of SERVICE_NOTICE_TYPES) {
    assert.ok(!/other|general|update|misc/i.test(t), `"${t}" reads as a catch-all`);
  }
});

test("the disclosure names the event and says plainly that it is not marketing", () => {
  const d = serviceNoticeDisclosure("Basement Sessions 04");
  assert.ok(d.includes("Basement Sessions 04"));
  assert.match(d, /not marketing/);
  assert.match(d, /hold a ticket/);
});
