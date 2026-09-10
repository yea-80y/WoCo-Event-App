/**
 * A ratchet, not a unit test: the credits write path must resolve the rider's
 * seed material through the auth store's BOUND accessors, never by passing an
 * address itself.
 *
 * The bug this pins cost a whole surface. The identity seed is stored under the seed
 * ADDRESS — the PRF-EOA for passkey, the Web3Auth EOA for web3auth — while
 * `auth.parent` is the KERNEL address for both (auth-store `_getSeedAddress`,
 * invariant #1). `credits.ts` looked the seed up by parent, so for every
 * passkey and web3auth rider it read a slot that is never written:
 * `ensureIdentitySeed()` would succeed, having just made the rider approve a
 * ceremony, and the very next line would fail with "could not unlock your
 * collection identity". The rail was dead for exactly the audience it is for,
 * and silently — the signed-out card is what a constant-false unlock check
 * renders, so it looks like a rider who simply has not collected yet.
 *
 * `auth.getIdentitySeed()` carries the comment "so callers don't need to pass it
 * (and can't pass the wrong one)". This module was the sole caller in the
 * codebase reaching past it. A unit test cannot catch the regression — the
 * module reaches the auth store, which is why the pure logic was split into
 * `next-statement.ts` in the first place — so the import is what gets pinned.
 *
 * Since #518 the credits rail also OWNS the ed25519 holder key: no launch path
 * derives one, so `holder-key.ts` moved here and this file is where the frozen
 * `seed → holder pubkey` vectors live.
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

test("credits never imports the address-taking object helpers directly", () => {
  // Importing them is the only way to call them with the wrong address, so the
  // import is the tripwire. If a future caller genuinely needs one, bind it in
  // the auth store next to getIdentitySeed rather than widening this.
  assert.doesNotMatch(
    SOURCE,
    /import\s*\{[^}]*\brestoreIdentitySeed\b[^}]*\}\s*from\s*["'][^"']*identity-seed/,
  );
});

test("credits resolves the seed through the bound accessor", () => {
  assert.match(SOURCE, /auth\.getIdentitySeed\(\)/);
});

test("credits never keys seed material by auth.parent", () => {
  // `auth.parent` is still legitimately read here (it is the "is anyone signed
  // in" check), so what is pinned is the narrower thing: it is never handed to
  // a seed lookup as an address.
  assert.doesNotMatch(CODE, /(restoreIdentitySeed|getIdentitySeed)\(\s*parent\s*\)/);
});

// ---------------------------------------------------------------------------
// The property that makes the fix sound, not merely correct today
// ---------------------------------------------------------------------------
//
// The bug was not "the wrong constant". It was TWO RESOLVERS: the store side
// resolved the address with `_getSeedAddress()` while the read side used
// `auth.parent`, so for passkey and web3auth they were guaranteed to disagree.
// What makes the repair robust is that every side now asks the same function —
// so even where that function falls back (`_seedAddress ?? _parent`), the write
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

test("the bound seed accessor resolves the address through _getSeedAddress()", () => {
  const line = AUTH_STORE.split("\n").find((l) => l.trimStart().startsWith("getIdentitySeed: () =>"));
  assert.ok(line, "getIdentitySeed must be exported as a bound accessor");
  assert.match(
    line,
    /_getSeedAddress\(\)/,
    "getIdentitySeed must resolve the seed address the same way ensureIdentitySeed " +
      "stores it — two resolvers is the bug, not the wrong constant",
  );
});

test("the auth store exposes NO key accessor to reach past the seed", () => {
  // #518. `getSeedKeypair` was the second resolver's twin: it handed callers a
  // derived ed25519 pair, so a rail could take a key without ever touching the
  // seed — and the launch paths that did so were signing nothing with it.
  assert.doesNotMatch(AUTH_STORE, /getSeedKeypair/);
  assert.doesNotMatch(AUTH_STORE, /seedPublicKeyHex/);
});

test("the seed is stored under the same resolver the accessor reads by", () => {
  // `ensureIdentitySeed` is a one-line wrapper; `_ensureIdentitySeed` is where the
  // address is resolved and the seed written, so that is what gets pinned.
  const start = AUTH_STORE.indexOf("async function _ensureIdentitySeed");
  assert.ok(start > 0, "_ensureIdentitySeed must exist — a rename would make this pass vacuously");
  // To the function's own closing brace, not a byte budget: the body grew past a
  // fixed slice once already, and a slice that falls short passes for the wrong
  // reason (the text simply is not in it).
  const end = AUTH_STORE.indexOf("\n}\n", start);
  assert.ok(end > start, "could not find the end of _ensureIdentitySeed");
  const body = AUTH_STORE.slice(start, end);
  assert.match(body, /const seedAddr = _getSeedAddress\(\)/);
  // And it is seedAddr, never _parent, that the seed is written under.
  assert.match(body, /requestIdentitySeed\(seedAddr,/);
});

// ---------------------------------------------------------------------------
// The holder format — the SECOND dead-path bug (#172)
// ---------------------------------------------------------------------------
//
// Fixing the address binding exposed this one, because it lived one line
// further down a path nothing could reach: `deriveHolderKeypair` returns an
// 0x-PREFIXED hex string, `woco.credit.v1` validates `holder` against bare
// 64-hex, and `riderKeys` passed the prefixed value straight through. Every
// signing attempt threw "invalid woco.credit.v1 unsigned statement".
//
// Two independent sources of truth are pinned against each other here, which
// is what makes this a test rather than a restatement: what the holder-key
// derivation actually emits, and what the frozen schema actually accepts.

const { deriveHolderKeypair } = await import("../src/lib/credits/holder-key.ts");
const { creditStatementDigest, CREDIT_STATEMENT_FORMAT } = await import("@woco/shared");

test("holder derivation emits an 0x prefix that the credit schema rejects", async () => {
  const kp = await deriveHolderKeypair("77".repeat(32));
  // If this ever stops being true, the strip in credits.ts becomes a no-op
  // rather than a bug — but silently, so it is worth knowing.
  assert.match(kp.publicKeyHex, /^0x[0-9a-f]{64}$/);

  const unsigned = {
    format: CREDIT_STATEMENT_FORMAT,
    subject: `0x${"11".repeat(32)}`,
    holder: kp.publicKeyHex, // the prefixed form — what the bug shipped
    seq: 0,
    total: 1,
    session: { date: "2026-08-18", count: 1 },
  };
  assert.throws(
    () => creditStatementDigest(unsigned as never),
    /invalid woco\.credit\.v1 unsigned statement/,
    "the prefixed holder must be rejected — this is the exact throw riders saw",
  );
});

test("the stripped holder is what the credit schema accepts", async () => {
  const kp = await deriveHolderKeypair("77".repeat(32));
  const unsigned = {
    format: CREDIT_STATEMENT_FORMAT,
    subject: `0x${"11".repeat(32)}`,
    holder: kp.publicKeyHex.slice(2),
    seq: 0,
    total: 1,
    session: { date: "2026-08-18", count: 1 },
  };
  const digest = creditStatementDigest(unsigned as never);
  assert.equal(digest.length, 32);
});

test("credits strips the prefix before it reaches the statement", () => {
  // Source-level, because riderKeys reaches the auth store and cannot be
  // loaded here. Pins the call, not the comment.
  assert.match(CODE, /holder:\s*stripHexPrefix\(/);
});

test("credits derives the holder key from the SEED, in this file", () => {
  // #518: no auth-store accessor hands out a keypair any more, so the rail that
  // still needs one derives it itself and drops it. If this stops being true the
  // key has gone somewhere longer-lived than a single call.
  assert.match(SOURCE, /from\s+["']\.\/holder-key\.js["']/);
  assert.match(CODE, /deriveHolderKeypair\(seed\)/);
});

// ---------------------------------------------------------------------------
// The holder key IS the seed — frozen vectors
// ---------------------------------------------------------------------------
//
// Moved here from identity-seed.test.ts with #518: the seed no longer derives an
// ed25519 key on any launch path, so the vectors belong to the rail that still
// does. They pin seed → public key to fixed bytes, so a crypto-library change
// that alters the holder identity FAILS LOUDLY instead of silently orphaning
// every credit statement and cert challenge ever signed.
//
// The first vector is the RFC 8032 §7.1 TEST 1 standard ed25519 vector (all-zero
// secret key), so any correct implementation MUST reproduce it. Divergence means
// the library is wrong, or the derivation changed. The rest were produced by
// this same derivation and are pinned as a self-consistency ratchet.
//
// Do NOT "fix" these by pasting in new values. If they fail, every existing
// holder identity just changed — that is a migration, not a test update.
const HOLDER_GOLDEN: ReadonlyArray<readonly [seed: string, publicKeyHex: string]> = [
  ["00".repeat(32), "0x3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29"],
  ["11".repeat(32), "0xd04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737"],
  ["22".repeat(32), "0xa09aa5f47a6759802ff955f8dc2d2a14a5c99d23be97f864127ff9383455a4f0"],
  ["deadbeef".repeat(8), "0xff57575dc7af8bfc4d0837cc1ce2017b686a88145dc5579a958e3462fe9a908e"],
  ["00".repeat(31) + "01", "0x4cb5abf6ad79fbf5abbccafcc269d85cd2651ed4b885b5869f241aedf0a5ba29"],
];

test("the holder key matches its golden vectors", async () => {
  for (const [seed, expected] of HOLDER_GOLDEN) {
    const kp = await deriveHolderKeypair(seed);
    assert.equal(
      kp.publicKeyHex,
      expected,
      `seed ${seed.slice(0, 16)}… must derive ${expected} — a mismatch means every ` +
        `existing holder identity has changed and every signed statement is orphaned`,
    );
  }
});

test("the holder secret IS the seed, verbatim — no KDF stands between them", async () => {
  // The frozen credit/cert vectors depend on this exactly as much as on the
  // curve. Checked against an INDEPENDENT ed25519 implementation (@noble/curves,
  // a different package from the @noble/ed25519 holder-key.ts uses) so this
  // cannot pass by agreeing with itself. NO `.js` on the specifier: apps/web
  // hoists a @noble/curves whose exports map has no `./ed25519.js` (the same
  // trap spot-check.test.ts documents).
  const { ed25519 } = await import("@noble/curves/ed25519");
  const seedHex = "77".repeat(32);
  const kp = await deriveHolderKeypair(seedHex);
  assert.deepEqual(Array.from(kp.privateKey), Array.from(Buffer.from(seedHex, "hex")));
  assert.equal(
    kp.publicKeyHex,
    "0x" + Buffer.from(ed25519.getPublicKey(Buffer.from(seedHex, "hex"))).toString("hex"),
  );
  // 0x-prefixed seeds are the form the auth store stores, and must derive the same key.
  assert.equal((await deriveHolderKeypair("0x" + seedHex)).publicKeyHex, kp.publicKeyHex);
});

test("a seed that is not 32 bytes is refused, never truncated or padded", async () => {
  await assert.rejects(() => deriveHolderKeypair("77".repeat(31)), /expected 32 bytes/);
  await assert.rejects(() => deriveHolderKeypair("77".repeat(33)), /expected 32 bytes/);
});
