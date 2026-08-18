/**
 * A ratchet, not a unit test: the credits write path must resolve the rider's
 * POD material through the auth store's BOUND accessors, never by passing an
 * address itself.
 *
 * The bug this pins cost a whole surface. The POD seed is stored under the POD
 * ADDRESS — the PRF-EOA for passkey, the Web3Auth EOA for web3auth — while
 * `auth.parent` is the KERNEL address for both (auth-store `_getPodAddress`,
 * invariant #1). `credits.ts` looked the seed up by parent, so for every
 * passkey and web3auth rider it read a slot that is never written:
 * `ensurePodIdentity()` would succeed, having just made the rider approve a
 * ceremony, and the very next line would fail with "could not unlock your
 * collection identity". The rail was dead for exactly the audience it is for,
 * and silently — the signed-out card is what a constant-false unlock check
 * renders, so it looks like a rider who simply has not collected yet.
 *
 * `auth.getPodKeypair()` carries the comment "so callers don't need to pass it
 * (and can't pass the wrong one)". This module was the sole caller in the
 * codebase reaching past it. A unit test cannot catch the regression — the
 * module reaches the auth store, which is why the pure logic was split into
 * `next-statement.ts` in the first place — so the import is what gets pinned.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/credits/credits.ts", import.meta.url)),
  "utf8",
);

/**
 * Comments stripped, because this file's comments NAME the wrong call in order
 * to warn about it — a ratchet that reads prose would fire on the warning and
 * be silenced by deleting it, which is precisely backwards. Crude (it would
 * also blank a `//` inside a string literal), and that is acceptable: over-
 * stripping can only cost a false PASS on a line no such literal appears on,
 * while the imports these tests actually guard are matched on the raw source.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("credits never imports the address-taking POD helpers directly", () => {
  // Importing them is the only way to call them with the wrong address, so the
  // import is the tripwire. If a future caller genuinely needs one, bind it in
  // the auth store next to getPodKeypair/getPodSeed rather than widening this.
  assert.doesNotMatch(
    SOURCE,
    /import\s*\{[^}]*\b(getPodKeypair|restorePodSeed)\b[^}]*\}\s*from\s*["'][^"']*pod-identity/,
  );
});

test("credits resolves POD material through the bound accessors", () => {
  assert.match(SOURCE, /auth\.getPodKeypair\(\)/);
  assert.match(SOURCE, /auth\.getPodSeed\(\)/);
});

test("credits never keys POD material by auth.parent", () => {
  // `auth.parent` is still legitimately read here (it is the "is anyone signed
  // in" check), so what is pinned is the narrower thing: it is never handed to
  // a POD lookup as an address.
  assert.doesNotMatch(CODE, /(getPodKeypair|restorePodSeed|getPodSeed)\(\s*parent\s*\)/);
});

// ---------------------------------------------------------------------------
// The property that makes the fix sound, not merely correct today
// ---------------------------------------------------------------------------
//
// The bug was not "the wrong constant". It was TWO RESOLVERS: the store side
// resolved the address with `_getPodAddress()` while the read side used
// `auth.parent`, so for passkey and web3auth they were guaranteed to disagree.
// What makes the repair robust is that every side now asks the same function —
// so even where that function falls back (`_podAddress ?? _parent`), the write
// and the read still agree, and no address can be right for one and wrong for
// the other.
//
// Pinned at source because there is no seam to assert it through: these are
// module-private resolvers inside a runes module the credits tests deliberately
// do not load.

const AUTH_STORE = readFileSync(
  fileURLToPath(new URL("../src/lib/auth/auth-store.svelte.ts", import.meta.url)),
  "utf8",
);

test("both bound POD accessors resolve the address through _getPodAddress()", () => {
  for (const accessor of ["getPodKeypair", "getPodSeed"]) {
    const line = AUTH_STORE.split("\n").find(
      (l) => l.trimStart().startsWith(`${accessor}: () =>`),
    );
    assert.ok(line, `${accessor} must be exported as a bound accessor`);
    assert.match(
      line,
      /_getPodAddress\(\)/,
      `${accessor} must resolve the POD address the same way ensurePodIdentity ` +
        `stores it — two resolvers is the bug, not the wrong constant`,
    );
  }
});

test("ensurePodIdentity stores under the same resolver the accessors read by", () => {
  const body = AUTH_STORE.slice(
    AUTH_STORE.indexOf("async function ensurePodIdentity"),
  ).slice(0, 3000);
  assert.match(body, /const podAddr = _getPodAddress\(\)/);
  // And it is podAddr, never _parent, that the seed is written under.
  assert.match(body, /requestPodIdentity\(podAddr,/);
});
