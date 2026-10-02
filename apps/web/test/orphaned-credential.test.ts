/**
 * Honest failure for a credential orphaned by recovery (#255).
 *
 * The properties pinned here are the ones the fix stands on:
 *
 *  - only an ANSWERED foreign owner is proof of orphaning — a null read is
 *    silence, and silence never condemns a signer (#277's rule, client-side);
 *  - the refusal posts its explanation through the one-shot notice channel the
 *    login modal already reads, and a broken sink can never break the refusal;
 *  - the error is recognisable by NAME, so the check survives chunk boundaries.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  provenOrphanOwner,
  orphanedCredentialMessage,
  refuseOrphanedCredential,
  postOrphanedCredentialNotice,
  isOrphanedCredentialError,
  OrphanedCredentialError,
  type OrphanNoticeSink,
} from "../src/lib/auth/orphaned-credential.js";
import { AUTH_NOTICE_KEY } from "../src/lib/auth/auth-notice.js";

const EOA = "0xAaAaAAAAaaaAAaAAaaaaAAaaaaAaaaAaAaaAaAaA";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const KERNEL = "0xcccccccccccccccccccccccccccccccccccccccc";

function memSink(): OrphanNoticeSink & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, setItem: (k, v) => void map.set(k, v) };
}

test("a null owner read is silence, never proof", () => {
  assert.equal(provenOrphanOwner(null, EOA), null);
});

test("the credential's own EOA is never proof, whatever the casing", () => {
  assert.equal(provenOrphanOwner(EOA.toLowerCase(), EOA), null);
  assert.equal(provenOrphanOwner(EOA, EOA.toLowerCase()), null);
});

test("an answered foreign owner is proof, returned as read", () => {
  assert.equal(provenOrphanOwner(OTHER, EOA), OTHER);
});

test("both kinds explain the recovery; the passkey kind names the next step", () => {
  for (const kind of ["passkey", "web3auth"] as const) {
    assert.match(orphanedCredentialMessage(kind), /recovered on another device/i);
  }
  assert.match(orphanedCredentialMessage("passkey"), /new passkey/i);
});

test("the refusal returns the honest error and posts the same message as the notice", () => {
  const sink = memSink();
  const err = refuseOrphanedCredential("passkey", { boundKernel: KERNEL, onChainOwner: OTHER }, sink);
  assert.ok(isOrphanedCredentialError(err));
  assert.ok(err instanceof OrphanedCredentialError);
  assert.equal(err.message, orphanedCredentialMessage("passkey"));
  assert.equal(err.onChainOwner, OTHER);
  assert.equal(sink.map.get(AUTH_NOTICE_KEY), orphanedCredentialMessage("passkey"));
});

test("a broken notice sink never breaks the refusal", () => {
  const err = refuseOrphanedCredential(
    "web3auth",
    { boundKernel: KERNEL, onChainOwner: OTHER },
    { setItem: () => { throw new Error("quota"); } },
  );
  assert.ok(isOrphanedCredentialError(err));
  assert.equal(err.message, orphanedCredentialMessage("web3auth"));
});

test("posting the notice with no sink at all is a no-op, not a throw", () => {
  postOrphanedCredentialNotice("passkey", undefined);
});

test("the error is recognised by name, so the check survives chunk boundaries", () => {
  const foreign = new Error(orphanedCredentialMessage("passkey"));
  foreign.name = "OrphanedCredentialError";
  assert.ok(isOrphanedCredentialError(foreign));
  assert.ok(!isOrphanedCredentialError(new Error("anything else")));
  assert.ok(!isOrphanedCredentialError("not an error"));
});

test("a refusal can carry its own words (#746 step 4): the same ones in the notice and the error", async () => {
  const { refuseOrphanedCredential, MOVED_OR_RECOVERED_MESSAGE } = await import("../src/lib/auth/orphaned-credential.ts");
  const posted: string[] = [];
  const err = refuseOrphanedCredential(
    "passkey",
    { boundKernel: "0x" + "1".repeat(40), onChainOwner: "0x" + "2".repeat(40) },
    { setItem: (_k, v) => void posted.push(v) },
    MOVED_OR_RECOVERED_MESSAGE,
  );
  assert.equal(err.message, MOVED_OR_RECOVERED_MESSAGE);
  assert.equal(err.name, "OrphanedCredentialError");
  assert.deepEqual(posted, [MOVED_OR_RECOVERED_MESSAGE]);
  assert.match(MOVED_OR_RECOVERED_MESSAGE, /made another device your main passkey/);
  assert.match(MOVED_OR_RECOVERED_MESSAGE, /the passkey you chose when you recovered the account/);
  assert.doesNotMatch(MOVED_OR_RECOVERED_MESSAGE, /\u2014/);
});

test("sign-in with a passkey its envelope names but the chain does not: refused in words that fit both histories; no answer is no verdict", () => {
  const STORE = readFileSync(fileURLToPath(new URL("../src/lib/auth/auth-store.svelte.ts", import.meta.url)), "utf8");
  const start = STORE.indexOf('if ((verdict === "invalid" || verdict === "unreachable") && !added && start.onChainOwner) {');
  assert.ok(start > 0);
  const b = STORE.slice(start, STORE.indexOf("\n  }\n", start));
  const unreachable = b.indexOf('if (verdict === "unreachable") throw new Error(VERDICT_UNREACHABLE_MESSAGE);');
  assert.ok(unreachable > 0 && unreachable < b.indexOf("clearVerifiedBinding("), "an unanswered server forgets nothing");
  assert.match(b, /MOVED_OR_RECOVERED_MESSAGE,\s*\);/);
});
