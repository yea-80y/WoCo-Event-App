/**
 * A ratchet, not a unit test: a certificate badge's `certLogOwner` must come
 * from the CONTENT-FEED SIGNER and from nothing else.
 *
 * This cannot be a unit test — the value is produced by an async auth call
 * inside a Svelte component — and it cannot be caught downstream either, which
 * is why it is pinned here. The server checks that `certLogOwner` is a
 * well-formed address; it has no way to know whether it is the RIGHT one. A
 * badge minted under the wrong address mints fine, appears in the manager fine,
 * and has a certificate log at `keccak256(identifier ‖ wrongOwner)` that nobody
 * — including its own issuer on another device — will ever look at.
 *
 * The specific mistake this guards is a plausible one, because it is what every
 * other owner-stamped surface in the codebase does: reaching for `auth.parent`.
 * The parent is the account address (the Kernel address for passkey and
 * web3auth users); the feed signer is a separate sign-to-derive secp256k1 key,
 * and it is the one the issuing client actually writes SOCs under.
 *
 * Same shape and same reasoning as `credits-key-binding.test.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/components/pod/PodCreateModal.svelte", import.meta.url)),
  "utf8",
);

/**
 * Comments stripped before matching, because the comments here NAME the wrong
 * call in order to warn about it — a ratchet that read prose would fire on the
 * warning and be silenced by deleting it, which is precisely backwards.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("certLogOwner is assigned from the content-feed signer", () => {
  assert.match(
    CODE,
    /getContentFeedSigner\(\)/,
    "the cert mint must resolve the signer whose address it will write under",
  );
  assert.match(
    CODE,
    /certLogOwner\s*=\s*signer\.address/,
    "certLogOwner must be the signer's own address, not a value from anywhere else",
  );
});

test("certLogOwner is NEVER taken from the account address", () => {
  // `auth.parent` is the Kernel address for passkey and web3auth users and is
  // not a feed owner at all. It type-checks perfectly as this parameter.
  assert.doesNotMatch(
    CODE,
    /certLogOwner\s*[:=]\s*[^;\n]*auth\.parent/,
    "auth.parent is the account, not the feed signer — the log would be unfindable",
  );
  assert.doesNotMatch(
    CODE,
    /certLogOwner\s*[:=]\s*[^;\n]*organiserAddress/,
    "organiserAddress is auth.parent lowercased — same mistake, one rename away",
  );
});

test("a certificate mint cannot proceed without one", () => {
  // Belt to the server's braces: the route refuses a cert mint with no
  // certLogOwner, but failing HERE is what keeps the user from a confusing
  // round trip, and keeps the failure attached to its cause.
  assert.match(
    CODE,
    /if\s*\(!signer\)/,
    "an unavailable feed signer must stop the mint, not fall through",
  );
});

test("the certificate rail is carried by holdingSource, not by a new PodKind", () => {
  // `kind` stays "badge" downstream — the directory, the gate picker and the
  // manager all key on the rail via `certLogOwner` / `holdingSource`. A fourth
  // PodKind would need a migration and a new case in every switch.
  assert.match(CODE, /holdingSource:\s*"pod-cert"/);
  assert.match(
    CODE,
    /kind:\s*isCert\s*\?\s*"badge"/,
    "a certificate badge IS a badge to everything downstream",
  );
});

test("the two rails use their own builders — no shared flag decides body count", () => {
  assert.match(CODE, /buildCertBadgeManifest\(/);
  assert.match(CODE, /buildEventManifests\(/);
  assert.doesNotMatch(
    CODE,
    /bodyCount/,
    "body count must never become a parameter — see pod/seal.ts for why",
  );
});
