/**
 * Likes and follows need the same unlock as a name (the relay refuses them
 * with `ticket_required`, apps/server/src/routes/swarm.ts). The one entry point
 * for both, `toggleSocial`, must open the unlock popup rather than surface a
 * failed write: up front when the status is known to be locked, and on the
 * server's refusal otherwise, retrying once after an unlock.
 *
 * SOURCE SCAN: toggleSocial reads rune stores, which Node cannot run.
 *
 * MUTATION: drop the up-front check, drop the refusal fallback, or write before
 * asking, and a case below goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const read = (rel: string) => readFileSync(`${SRC}/${rel}`, "utf-8");

const api = read("lib/api/social.ts");
const toggle = api.slice(api.indexOf("export async function toggleSocial"));
const body = toggle.slice(0, toggle.indexOf("\n}\n"));

test("a known locked account is asked to unlock before anything is written", () => {
  const ask = body.indexOf("if (status && !status.gated && !(await gate.request())) return null;");
  const write = body.indexOf("writeMyStatement(");
  assert.notEqual(ask, -1, "toggleSocial no longer checks the unlock up front");
  assert.ok(ask < write, "the unlock must be asked for before the first write");
});

test("the server's refusal opens the unlock popup and retries once", () => {
  assert.match(
    body,
    /if \(!res\.ok && isTicketRequired\(res\.error\)\) \{\s*if \(!\(await gate\.request\(\)\)\) return null;\s*res = await writeMyStatement\(kind, subject, next\);\s*\}/,
  );
});

test("the unlock popup names follows and likes", () => {
  assert.match(read("lib/attendee/gate/TicketGateModal.svelte"), /unlocksWhen\("Following, likes, and your name, photo and bio", true\)/);
});
