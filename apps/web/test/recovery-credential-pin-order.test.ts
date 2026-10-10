/**
 * The recovery ceremony must pin the primary passkey credential AFTER the
 * rotation, not before it (#158).
 *
 * The pin (`StorageKeys.PASSKEY_CREDENTIAL`) is what makes a passkey THIS
 * device's login: `init()` restores a passkey session only when the pin, the
 * parent address and the seed address are all present, and the login screen
 * offers "Sign in" rather than "Create" on the strength of the pin alone.
 * `recoverAndRekey` used to write it at mint time, several irreversible and
 * several merely-failable steps before any of the rest — so an abort anywhere
 * after the mint (a refused guardian userOp, an unconfirmable rotation, a
 * collision found by the tail re-scan) left a device pinned to a credential that
 * owns no account, offering to sign in to nothing.
 *
 * ORDER IS THE WHOLE PROPERTY, so ORDER is what is asserted. A unit test would
 * have to drive the full ceremony (guardian wallet, escrow decrypt, bundler,
 * chain reads) to observe it, and the parts it would stub are exactly the parts
 * whose failure the ordering exists to survive. Reading the source is the
 * instrument that matches the claim — the same choice as no-eager-ed25519.test.ts.
 *
 * MUTATION: move the `pinPasskeyCredential` call above `_putRecoveryBinding`, or
 * swap `createPasskeyAccountUnpinned()` back to `createPasskeyAccount()`, and
 * this goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(
  new URL("../src/lib/auth/auth-store.svelte.ts", import.meta.url),
);
const TEXT = readFileSync(SRC, "utf-8");

/** The ceremony's own body, sliced at its declaration and at the next top-level
 *  banner. Scoping matters: `createPasskeyAccount` is still the right call in
 *  `loginPasskey("create")`, which lives above this in the same file. */
function ceremonyBody(): string {
  const start = TEXT.indexOf("async function recoverAndRekey(");
  assert.ok(start > 0, "recoverAndRekey must exist in auth-store.svelte.ts");
  const end = TEXT.indexOf("\n// ---", start);
  assert.ok(end > start, "expected a top-level banner after recoverAndRekey");
  return TEXT.slice(start, end);
}

test("the slice actually reaches the ceremony", () => {
  // Without this, renaming recoverAndRekey would empty the slice and every
  // assertion below would pass on an empty string — green, guarding nothing.
  const body = ceremonyBody();
  assert.ok(body.length > 4000, `the slice is only ${body.length} chars — it is not the ceremony`);
  assert.match(body, /recoverAccount\(\{/, "the slice must contain the on-chain rotation");
  assert.match(body, /_putRecoveryBinding\(/, "the slice must contain the commit block");
});

test("the ceremony never mints a PINNED passkey", () => {
  const body = ceremonyBody();
  assert.equal(
    body.includes("createPasskeyAccount("),
    false,
    "createPasskeyAccount() writes StorageKeys.PASSKEY_CREDENTIAL at mint time — the ceremony must use createPasskeyAccountUnpinned()",
  );
});

test("the passkey is minted BEFORE the on-chain rotation", () => {
  // Not an accident of ordering: the new Kernel owner IS the PRF-EOA, so there is
  // nothing to rotate to until the passkey exists. This is why the two halves had
  // to be split rather than simply moved.
  const body = ceremonyBody();
  const mint = body.indexOf("createPasskeyAccountUnpinned(");
  const rotate = body.indexOf("recoverAccount({");
  assert.ok(mint > 0, "the ceremony must mint via createPasskeyAccountUnpinned()");
  assert.ok(rotate > 0, "the ceremony must call recoverAccount({ … })");
  assert.ok(
    mint < rotate,
    "createPasskeyAccountUnpinned() must run before recoverAccount({ … }): the new owner address is the PRF-EOA",
  );
});

test("the pin is committed after the binding and the seed, and before AUTH_KIND", () => {
  const body = ceremonyBody();
  const binding = body.indexOf("_putRecoveryBinding(");
  const seed = body.indexOf("storeIdentitySeed(");
  const pin = body.indexOf("pinPasskeyCredential(");
  const authKind = body.indexOf("putKV(StorageKeys.AUTH_KIND");

  assert.ok(pin > 0, "the ceremony must pin the credential via pinPasskeyCredential()");
  assert.ok(binding > 0 && seed > 0 && authKind > 0, "the commit block must be intact");
  assert.ok(
    pin > binding,
    "pinPasskeyCredential() must run after _putRecoveryBinding(): the binding is the record nothing else recovers (#230)",
  );
  assert.ok(
    pin > seed,
    "pinPasskeyCredential() must run after storeIdentitySeed(): a pinned credential with no seed cannot decrypt the account it claims",
  );
  assert.ok(
    pin < authKind,
    "pinPasskeyCredential() must run before putKV(StorageKeys.AUTH_KIND): init()'s three-way requirement (pin + parent + seed address) must become satisfiable in one order only",
  );
});
