/**
 * verifyAndPinIssuerBinding — the proof-of-possession check both create rails
 * run before anything is written (issuer-curve migration PR 5a).
 *
 * Every refusal here closes an impersonation or divergence path that would
 * otherwise be SILENT: a replayed foreign manifest binding a foreign issuer to
 * an attacker's parent, a garbled client signature pinning a random address,
 * or a divergent seed quietly minting a second issuer identity for one
 * account. Tested at the seam, with real signatures — no mocks.
 *
 * The module captures `join(process.cwd(), ".data")` at load, so the chdir to
 * a temp dir happens BEFORE the dynamic import — test writes never touch the
 * repo's `.data`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIssuerBindingMessage,
  deriveIssuingKey,
  signPersonalMessage,
} from "@woco/shared";

const PARENT = "0x1111111111111111111111111111111111111111";
const OTHER_PARENT = "0x3333333333333333333333333333333333333333";

const { privateKey: KEY, address: ISSUER } = deriveIssuingKey("0x" + "ab".repeat(32), 0);
const { privateKey: OTHER_KEY, address: OTHER_ISSUER } = deriveIssuingKey("0x" + "cd".repeat(32), 0);

function bindingFor(parent: string, key = KEY, issuer = ISSUER, gen = 0) {
  return { issuer, gen, sig: signPersonalMessage(buildIssuerBindingMessage(parent, gen), key) };
}

let originalCwd: string;
let binding: typeof import("../src/lib/issuer/binding.js");

before(async () => {
  originalCwd = process.cwd();
  process.chdir(mkdtempSync(join(tmpdir(), "woco-issuer-binding-")));
  binding = await import("../src/lib/issuer/binding.js");
});

after(() => {
  process.chdir(originalCwd);
});

test("a valid binding verifies and pins", () => {
  binding._resetIssuerBindings();
  const v = binding.verifyAndPinIssuerBinding(PARENT, bindingFor(PARENT), [ISSUER], "event-create");
  assert.deepEqual(v, { ok: true });
  const rec = binding.getIssuerBinding(PARENT);
  assert.equal(rec?.issuer, ISSUER);
  assert.equal(rec?.gen, 0);
});

test("the verified parent may arrive checksummed — the message is rebuilt lowercase", () => {
  // The client signs the LOWERCASE parent; auth middleware can carry mixed
  // (checksummed) case. A case difference must not read as a failed proof.
  binding._resetIssuerBindings();
  const lower = "0xabcdef1234abcdef1234abcdef1234abcdef1234";
  const checksummed = "0xABCDEF1234abcdef1234ABCDEF1234abcdef1234";
  const v = binding.verifyAndPinIssuerBinding(checksummed, bindingFor(lower), [ISSUER], "event-create");
  assert.deepEqual(v, { ok: true }, "mixed-case parent refused");
  assert.equal(binding.getIssuerBinding(lower)?.issuer, ISSUER, "pinned under the lowercase key");
});

test("a signature by a DIFFERENT key fails possession — the replayed-manifest attack", () => {
  // The attacker holds the victim's PUBLIC manifests and address, but not the
  // key: any signature they can produce recovers to their own address.
  binding._resetIssuerBindings();
  const forged = { issuer: ISSUER, gen: 0, sig: signPersonalMessage(buildIssuerBindingMessage(PARENT, 0), OTHER_KEY) };
  const v = binding.verifyAndPinIssuerBinding(PARENT, forged, [ISSUER], "event-create");
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /not made by the claimed issuer/);
  assert.equal(binding.getIssuerBinding(PARENT), null, "nothing may be pinned on a failed proof");
});

test("a binding signed for ANOTHER parent does not verify here", () => {
  // The parent is inside the signed message — the whole point. A binding
  // captured from someone else's create replays as garbage under this parent.
  binding._resetIssuerBindings();
  const v = binding.verifyAndPinIssuerBinding(PARENT, bindingFor(OTHER_PARENT), [ISSUER], "event-create");
  assert.equal(v.ok, false);
});

test("a manifest naming a different issuer than the binding is refused", () => {
  binding._resetIssuerBindings();
  const v = binding.verifyAndPinIssuerBinding(
    PARENT,
    bindingFor(PARENT),
    [ISSUER, OTHER_ISSUER],
    "event-create",
  );
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /different issuer than the binding/);
});

test("gen must be 0 until the registry exists", () => {
  binding._resetIssuerBindings();
  const v = binding.verifyAndPinIssuerBinding(PARENT, bindingFor(PARENT, KEY, ISSUER, 1), [ISSUER], "event-create");
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /gen must be 0/);
});

test("re-binding the SAME issuer is idempotent; a DIFFERENT issuer is refused loudly", () => {
  binding._resetIssuerBindings();
  assert.equal(binding.verifyAndPinIssuerBinding(PARENT, bindingFor(PARENT), [ISSUER], "event-create").ok, true);
  // Same again — the ordinary republish/second-event case.
  assert.equal(binding.verifyAndPinIssuerBinding(PARENT, bindingFor(PARENT), [ISSUER], "object-mint").ok, true);
  // A second identity for one account: either a client bug or the
  // seed-divergence class surfacing. Must refuse, never silently re-pin.
  const divergent = bindingFor(PARENT, OTHER_KEY, OTHER_ISSUER);
  const v = binding.verifyAndPinIssuerBinding(PARENT, divergent, [OTHER_ISSUER], "event-create");
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /already bound to a different issuer/);
  assert.equal(binding.getIssuerBinding(PARENT)?.issuer, ISSUER, "the original pin must stand");
});

test("malformed bindings are refused, never thrown on", () => {
  binding._resetIssuerBindings();
  for (const bad of [undefined, null, 42, "sig", [], {}, { issuer: ISSUER }, { issuer: "0xNOT", gen: 0, sig: "0x" }]) {
    const v = binding.verifyAndPinIssuerBinding(PARENT, bad, [ISSUER], "event-create");
    assert.equal(v.ok, false, `accepted: ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// ONE ISSUING ADDRESS, ONE PARENT — the global index (#457).
//
// Possession is not ownership: a second account CAN hold a valid proof for an
// issuing address (it derived the same one from a colliding seed, or it simply
// stole the key) and the per-parent rules above see nothing wrong, because they
// only ever look at the claimant's own record. These tests are the fence that
// makes the pin mean "this address names THIS account".
// ---------------------------------------------------------------------------

const THIRD_PARENT = "0x4444444444444444444444444444444444444444";
const GEN1 = deriveIssuingKey("0x" + "ab".repeat(32), 1);

test("a SECOND account cannot pin an issuing address the first one holds", () => {
  binding._resetIssuerBindings();
  assert.equal(binding.verifyAndPinIssuerBinding(PARENT, bindingFor(PARENT), [ISSUER], "event-create").ok, true);

  // A perfectly valid proof of possession — signed for OTHER_PARENT by the very
  // key that ISSUER is. Everything the pre-#457 checks look at passes.
  const claim = bindingFor(OTHER_PARENT, KEY, ISSUER);
  const v = binding.verifyAndPinIssuerBinding(OTHER_PARENT, claim, [ISSUER], "event-create");
  assert.equal(v.ok, false, "a cross-account claim must be refused even with a valid PoP");
  assert.match((v as { error: string }).error, /already bound to a different account/);

  assert.equal(binding.getIssuerBinding(OTHER_PARENT), null, "the claimant must get no record");
  assert.equal(binding.getIssuerBinding(PARENT)?.issuer, ISSUER, "the holder's pin must stand untouched");
  assert.equal(binding.getIssuerBinding(PARENT)?.gen, 0);

  const h = binding.issuerBindingHealth();
  assert.equal(h.crossClaimRefusals, 1, "the refusal has to be visible to an operator");
  assert.deepEqual(h.lastCrossClaim, { claimant: OTHER_PARENT, holder: PARENT });
  assert.equal(typeof h.lastCrossClaimAt, "string");
  assert.equal(h.pinnedParents, 1);
});

test("a RETIRED issuing address can never be pinned again, by anyone", () => {
  binding._resetIssuerBindings();
  assert.equal(binding.verifyAndPinIssuerBinding(PARENT, bindingFor(PARENT), [ISSUER], "event-create").ok, true);
  const gen1 = bindingFor(PARENT, GEN1.privateKey, GEN1.address, 1);
  assert.equal(binding.applyIssuerRotation(PARENT, GEN1.address, 1, gen1.sig).ok, true);
  assert.equal(binding.isRetiredIssuer(ISSUER), true);

  // A stranger claiming the retired address — the leaked-key case the
  // retirement seam exists for. Its PoP is genuine; it is still refused.
  const v = binding.verifyAndPinIssuerBinding(THIRD_PARENT, bindingFor(THIRD_PARENT, KEY, ISSUER), [ISSUER], "event-create");
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /retired by an account rotation/);
  assert.equal(binding.getIssuerBinding(THIRD_PARENT), null);

  // The ORIGINAL account is refused too, though by its own record's generation
  // rule — it never reaches the fresh-pin path while that record stands.
  const back = binding.verifyAndPinIssuerBinding(PARENT, bindingFor(PARENT), [ISSUER], "event-create");
  assert.equal(back.ok, false);
  assert.match((back as { error: string }).error, /generation 1/);
  assert.equal(binding.getIssuerBinding(PARENT)?.issuer, GEN1.address, "the rotation must stand");
  assert.equal(binding.issuerBindingHealth().retiredIssuers, 1);
});

test("a rotation cannot walk an account onto an issuer another account holds", () => {
  binding._resetIssuerBindings();
  assert.equal(binding.verifyAndPinIssuerBinding(PARENT, bindingFor(PARENT), [ISSUER], "event-create").ok, true);
  assert.equal(
    binding.verifyAndPinIssuerBinding(OTHER_PARENT, bindingFor(OTHER_PARENT, OTHER_KEY, OTHER_ISSUER), [OTHER_ISSUER], "event-create").ok,
    true,
  );

  // The registry has already verified the statement and the PoP by this point —
  // the only thing left to notice is that the address belongs to someone else.
  const stolen = signPersonalMessage(buildIssuerBindingMessage(PARENT, 1), OTHER_KEY);
  const v = binding.applyIssuerRotation(PARENT, OTHER_ISSUER, 1, stolen);
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /already bound to a different account/);

  const rec = binding.getIssuerBinding(PARENT);
  assert.equal(rec?.issuer, ISSUER, "a refused rotation must not move the record");
  assert.equal(rec?.gen, 0);
  assert.equal(binding.getIssuerBinding(OTHER_PARENT)?.issuer, OTHER_ISSUER, "nor disturb the holder");
  assert.deepEqual(binding.issuerBindingHealth().lastCrossClaim, { claimant: PARENT, holder: OTHER_PARENT });
});

test("the global index survives a restart — it is rebuilt from the store file", () => {
  binding._resetIssuerBindings();
  assert.equal(binding.verifyAndPinIssuerBinding(PARENT, bindingFor(PARENT), [ISSUER], "event-create").ok, true);

  // A fresh boot: nothing in memory, the pin only on disk. Without the reverse
  // index being rebuilt on load, the first claim after every restart would win.
  binding._resetIssuerBindings({ fromDisk: true });
  assert.equal(binding.getIssuerBinding(PARENT)?.issuer, ISSUER, "the record must reload at all");

  const v = binding.verifyAndPinIssuerBinding(OTHER_PARENT, bindingFor(OTHER_PARENT, KEY, ISSUER), [ISSUER], "event-create");
  assert.equal(v.ok, false, "a restart must not reopen the cross-account window");
  assert.match((v as { error: string }).error, /already bound to a different account/);
  assert.equal(binding.getIssuerBinding(OTHER_PARENT), null);
});

test("the health view carries addresses only — never a key or a signature", () => {
  binding._resetIssuerBindings();
  assert.equal(binding.verifyAndPinIssuerBinding(PARENT, bindingFor(PARENT), [ISSUER], "event-create").ok, true);
  const claim = bindingFor(OTHER_PARENT, KEY, ISSUER);
  binding.verifyAndPinIssuerBinding(OTHER_PARENT, claim, [ISSUER], "event-create");

  const serialised = JSON.stringify(binding.issuerBindingHealth());
  assert.doesNotMatch(serialised, new RegExp(claim.sig), "the PoP signature must not leak onto /api/health");
  assert.doesNotMatch(serialised, new RegExp(KEY.slice(2)), "nor anything key-shaped");
  assert.deepEqual(Object.keys(JSON.parse(serialised)).sort(), [
    "crossClaimRefusals",
    "lastCrossClaim",
    "lastCrossClaimAt",
    "pinnedParents",
    "retiredIssuers",
  ]);
});

// ---------------------------------------------------------------------------
// Route enforcement ratchets — the module above is only worth anything if the
// two create routes actually call it and stop on refusal. Neither route has a
// harness-level test (auth middleware + streaming), so the wiring is pinned at
// the source, the same pattern as the web payload ratchets.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const readSrc = (p: string) =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

test("both create routes verify the binding and stop on refusal", () => {
  for (const [name, path] of [
    ["events", "../src/routes/events.ts"],
    ["objects", "../src/routes/objects.ts"],
  ] as const) {
    const src = readSrc(path);
    const at = src.indexOf("verifyAndPinIssuerBinding(");
    assert.ok(at > 0, `${name}: the route must call verifyAndPinIssuerBinding`);
    const after = src.slice(at, at + 400);
    assert.match(after, /if \(!verdict\.ok\)/, `${name}: the verdict must be checked`);
    assert.match(after, /400/, `${name}: a refused binding must refuse the request`);
  }
});

test("the binding is checked against the VERIFIED parent, never a body value", () => {
  for (const path of ["../src/routes/events.ts", "../src/routes/objects.ts"]) {
    const src = readSrc(path);
    const at = src.indexOf("verifyAndPinIssuerBinding(");
    const call = src.slice(at, at + 200);
    assert.match(call, /parentAddress/, "the session-verified parent is the first argument");
    assert.doesNotMatch(call, /body\.creatorAddress|b\.creatorAddress/, "never the body's address");
  }
});

test("a legacy v1 blob yields no digest on the checkout path", async () => {
  const { digestOfManifestBlob } = await import("../src/lib/event/onchain-binding.js");
  const v1Blob = {
    v: 2,
    signedManifest: {
      body: {
        format: "woco.manifest.v1",
        eventId: `0x${"11".repeat(32)}`,
        totalSupply: 3,
        issuerPubkey: "ab".repeat(32),
        metadataRoot: `0x${"22".repeat(32)}`,
        encoding: "cbor-v1",
        treeScheme: "oz-simple-v1",
      },
      signature: "cd".repeat(64),
    },
    objectRefs: [],
    manifestDigestHex: `0x${"33".repeat(32)}`,
  };
  assert.equal(digestOfManifestBlob(v1Blob), null, "a v1 blob must not digest — the sale refuses");
  assert.equal(digestOfManifestBlob(null), null);
  assert.equal(digestOfManifestBlob({}), null);

  // Positive control — without it, a guard mutated to refuse EVERYTHING would
  // pass this test while stopping every sale.
  const { buildEditionTree, signManifestV2, manifestV2Digest, bytesToHex0x } = await import("@woco/shared");
  const body = {
    format: "woco.edition.v1" as const,
    seriesId: "ga",
    edition: 1,
    metadata: { name: "GA" },
    issuer: ISSUER,
  };
  const { root } = buildEditionTree([body]);
  const manifest = {
    format: "woco.manifest.v2" as const,
    totalSupply: 1,
    issuer: ISSUER,
    metadataRoot: root,
    encoding: "cbor-v1" as const,
    treeScheme: "oz-simple-v1" as const,
  };
  const v2Blob = { v: 2, signedManifest: signManifestV2(manifest, KEY), objectRefs: [], manifestDigestHex: "" };
  assert.equal(
    digestOfManifestBlob(v2Blob),
    bytesToHex0x(manifestV2Digest(manifest)).toLowerCase(),
    "a valid v2 blob must digest to its manifestRef",
  );
});

test("a rotation onto a RETIRED address is refused — rotating back is not a rotation", () => {
  binding._resetIssuerBindings();
  assert.equal(binding.verifyAndPinIssuerBinding(PARENT, bindingFor(PARENT), [ISSUER], "event-create").ok, true);
  const gen1 = bindingFor(PARENT, GEN1.privateKey, GEN1.address, 1);
  assert.equal(binding.applyIssuerRotation(PARENT, GEN1.address, 1, gen1.sig).ok, true);

  // The account's OWN gen-0 address, retired one step ago. A bumped-away key
  // is exactly the key a leak can still sign with, so it never comes back.
  const back = signPersonalMessage(buildIssuerBindingMessage(PARENT, 2), KEY);
  const v = binding.applyIssuerRotation(PARENT, ISSUER, 2, back);
  assert.equal(v.ok, false, "a rotation must not resurrect a retired address");
  assert.match((v as { error: string }).error, /retired by an account rotation/);
  const rec = binding.getIssuerBinding(PARENT);
  assert.equal(rec?.issuer, GEN1.address, "the record must not move");
  assert.equal(rec?.gen, 1);
  assert.equal(binding.isRetiredIssuer(ISSUER), true);
});

test("a rotation onto the account's OWN current address is refused — it would retire the live key", () => {
  binding._resetIssuerBindings();
  assert.equal(binding.verifyAndPinIssuerBinding(PARENT, bindingFor(PARENT), [ISSUER], "event-create").ok, true);

  const same = signPersonalMessage(buildIssuerBindingMessage(PARENT, 1), KEY);
  const v = binding.applyIssuerRotation(PARENT, ISSUER, 1, same);
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /NEW issuing address/);
  const rec = binding.getIssuerBinding(PARENT);
  assert.equal(rec?.gen, 0, "the record must not move");
  assert.equal(binding.isRetiredIssuer(ISSUER), false, "the live address must not become retired");
  assert.equal(binding.issuerBindingHealth().crossClaimRefusals, 0, "this is not a cross-account claim");
});
