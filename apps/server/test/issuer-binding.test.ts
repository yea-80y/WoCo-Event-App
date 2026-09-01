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
  assert.equal(binding.verifyAndPinIssuerBinding(PARENT, bindingFor(PARENT), [ISSUER], "pod-mint").ok, true);
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
    ["pod", "../src/routes/pod.ts"],
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
  for (const path of ["../src/routes/events.ts", "../src/routes/pod.ts"]) {
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
    podRefs: [],
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
  const v2Blob = { v: 2, signedManifest: signManifestV2(manifest, KEY), podRefs: [], manifestDigestHex: "" };
  assert.equal(
    digestOfManifestBlob(v2Blob),
    bytesToHex0x(manifestV2Digest(manifest)).toLowerCase(),
    "a valid v2 blob must digest to its manifestRef",
  );
});
