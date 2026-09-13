/**
 * A release BURNS a name irreversibly, so it must never be reachable by a key
 * that signs without a gesture.
 *
 * A scoped session key lives on a device for 30 days and signs silently. That
 * was safe for the two the platform ever shipped — the sub-ENS mint key
 * (`registerWithPermit` mints a name to its holder and needs the server's permit
 * anyway) and the referral campaign's attest/revoke key. It would not be safe
 * for `release`: a stolen or exfiltrated device could destroy every name the
 * holder owns, with no gesture from the user and nothing to notice it by.
 *
 * So the release rails are deliberately the ones that COST a gesture — a sudo
 * userOp (passkey prompt) or the wallet's own confirmation.
 *
 * #501 deleted the sub-ENS session key with the gasless mint rail, and with it
 * the three tests here that pinned that key's call policy; #476 then deleted the
 * campaign's, so no scoped key is left on any device. This one outlives both
 * because it guards the OTHER side: the release module, which is still live, and
 * which must not reach for a scoped key — including one nobody has written yet.
 * The names below are deliberately kept after their definitions went: reaching
 * for a silent signer is the regression, whatever it ends up being called.
 *
 * A source-level test on purpose: the rails are chosen inside a module that
 * dynamically imports ZeroDev, so asserting on behaviour would need the SDK, a
 * bundler and a network. What regresses here is someone reaching for a session
 * key, and that is visible in the source.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the release client never routes through a scoped session key", () => {
  const release = readFileSync(new URL("../src/lib/sub-ens/release.ts", import.meta.url), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
  // Every session-key entry point. `sendSudoUserOp` (a passkey prompt) and a
  // wallet transaction are the sanctioned rails; a scoped key is not.
  assert.doesNotMatch(release, /sendSessionUserOp|ensureEasSessionKey|getEasSessionClient/);
});
