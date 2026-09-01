/**
 * The issuer-registry relay (PR 5b): sequencing, rotation, retirement.
 *
 * The parent signatures here come from a REAL ethers Wallet's
 * `signTypedData` — which makes this suite double as the interop pin for
 * `eip712-digest`'s byte-identity claim on the ISSUER_REGISTRY_DOMAIN: if the
 * dependency-free digest ever drifted from ethers' encoding, every relay call
 * below would refuse the wallet's signature.
 *
 * No bee runs in tests, so every `published` comes back false through the
 * relay's own catch — which is itself the behaviour under test for the
 * republish-heals path. Backoff is collapsed via the feeds test hook.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import {
  ISSUER_REGISTRY_DOMAIN,
  ISSUER_STATEMENT_FORMAT,
  ISSUER_STATEMENT_TYPES,
  ZERO_ADDRESS,
  buildIssuerBindingMessage,
  buildIssuerRotationMessage,
  deriveIssuingKey,
  signPersonalMessage,
  type IssuerStatementV1,
} from "@woco/shared";

const WALLET = new Wallet("0x" + "07".repeat(32));
const PARENT = WALLET.address.toLowerCase() as `0x${string}`;
const OTHER_WALLET = new Wallet("0x" + "09".repeat(32));

const GEN0 = deriveIssuingKey("0x" + "ab".repeat(32), 0);
const GEN1 = deriveIssuingKey("0x" + "ab".repeat(32), 1);
const GEN2 = deriveIssuingKey("0x" + "ab".repeat(32), 2);
const STRANGER = deriveIssuingKey("0x" + "cd".repeat(32), 0);

async function statement(
  gen: number,
  over: Partial<IssuerStatementV1> & { signer?: Wallet } = {},
): Promise<IssuerStatementV1> {
  const key = [GEN0, GEN1, GEN2][gen]!;
  const base = {
    parent: over.parent ?? PARENT,
    issuer: over.issuer ?? key.address,
    gen,
    certLogOwner: over.certLogOwner ?? (ZERO_ADDRESS as `0x${string}`),
    reason: over.reason ?? (gen === 0 ? "seed" : "rotation"),
    issuedAt: over.issuedAt ?? "2026-09-01T12:00:00Z",
  };
  const parentSig = (await (over.signer ?? WALLET).signTypedData(
    { ...ISSUER_REGISTRY_DOMAIN },
    ISSUER_STATEMENT_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
    base,
  )) as `0x${string}`;
  return {
    format: ISSUER_STATEMENT_FORMAT,
    ...base,
    parentSig,
    bindingSig:
      over.bindingSig ??
      signPersonalMessage(buildIssuerBindingMessage(base.parent, base.gen), key.privateKey),
    ...(over.prevSig !== undefined ? { prevSig: over.prevSig } : {}),
  } as IssuerStatementV1;
}

let originalCwd: string;
let registry: typeof import("../src/lib/issuer/registry.js");
let binding: typeof import("../src/lib/issuer/binding.js");

before(async () => {
  originalCwd = process.cwd();
  process.chdir(mkdtempSync(join(tmpdir(), "woco-issuer-registry-")));
  const feeds = await import("../src/lib/swarm/feeds.js");
  feeds.__feedWriteTestHooks.setBaseBackoffMs(1);
  registry = await import("../src/lib/issuer/registry.js");
  binding = await import("../src/lib/issuer/binding.js");
});

after(() => {
  process.chdir(originalCwd);
});

function reset(): void {
  registry._resetIssuerRegistry();
  binding._resetIssuerBindings();
}

test("a seed statement signed by a REAL ethers wallet relays and pins — the EIP-712 interop pin", async () => {
  reset();
  const r = await registry.relayIssuerStatement(PARENT, await statement(0));
  assert.equal(r.ok, true, (r as { error?: string }).error);
  assert.equal(binding.getIssuerBinding(PARENT)?.issuer, GEN0.address);
  assert.equal(registry.getIssuerRegistry(PARENT).statements.length, 1);
});

test("a statement naming a different account than the session is refused", async () => {
  reset();
  const other = OTHER_WALLET.address.toLowerCase() as `0x${string}`;
  const s = await statement(0, { parent: other, signer: OTHER_WALLET });
  const r = await registry.relayIssuerStatement(PARENT, s);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /different account/);
});

test("a checksummed session parent still relays — the relay lowercases", async () => {
  reset();
  const r = await registry.relayIssuerStatement(WALLET.address, await statement(0));
  assert.equal(r.ok, true, (r as { error?: string }).error);
});

test("seed → co-signed rotation: record bumps, the outgoing issuer is RETIRED", async () => {
  reset();
  assert.equal((await registry.relayIssuerStatement(PARENT, await statement(0))).ok, true);
  const prevSig = signPersonalMessage(
    buildIssuerRotationMessage(PARENT, 0, 1, GEN1.address),
    GEN0.privateKey,
  );
  const r = await registry.relayIssuerStatement(PARENT, await statement(1, { prevSig }));
  assert.equal(r.ok, true, (r as { error?: string }).error);

  const rec = binding.getIssuerBinding(PARENT);
  assert.equal(rec?.issuer, GEN1.address);
  assert.equal(rec?.gen, 1);
  assert.equal(binding.isRetiredIssuer(GEN0.address), true, "the outgoing issuer must be retired");
  assert.equal(binding.isRetiredIssuer(GEN1.address), false);

  // The create rails now demand the CURRENT generation.
  const stale = {
    issuer: GEN0.address,
    gen: 0,
    sig: signPersonalMessage(buildIssuerBindingMessage(PARENT, 0), GEN0.privateKey),
  };
  const v = binding.verifyAndPinIssuerBinding(PARENT, stale, [GEN0.address], "event-create");
  assert.equal(v.ok, false);
  assert.match((v as { error: string }).error, /generation 1/);

  const current = {
    issuer: GEN1.address,
    gen: 1,
    sig: signPersonalMessage(buildIssuerBindingMessage(PARENT, 1), GEN1.privateKey),
  };
  assert.equal(binding.verifyAndPinIssuerBinding(PARENT, current, [GEN1.address], "event-create").ok, true);
});

test("a rotation with the WRONG co-signature is refused; without one it is accepted (break-glass)", async () => {
  reset();
  assert.equal((await registry.relayIssuerStatement(PARENT, await statement(0))).ok, true);

  const wrong = signPersonalMessage(
    buildIssuerRotationMessage(PARENT, 0, 1, GEN1.address),
    STRANGER.privateKey,
  );
  const refused = await registry.relayIssuerStatement(PARENT, await statement(1, { prevSig: wrong }));
  assert.equal(refused.ok, false);
  assert.match((refused as { error: string }).error, /not the outgoing issuer's co-signature/);

  const breakGlass = await registry.relayIssuerStatement(PARENT, await statement(1));
  assert.equal(breakGlass.ok, true, (breakGlass as { error?: string }).error);
  assert.equal(binding.getIssuerBinding(PARENT)?.gen, 1);
});

test("generation sequencing: skips, duplicates and pre-seed rotations are refused", async () => {
  reset();
  // Rotation before any published seed — even for an account pinned by a create.
  const pin = {
    issuer: GEN0.address,
    gen: 0,
    sig: signPersonalMessage(buildIssuerBindingMessage(PARENT, 0), GEN0.privateKey),
  };
  assert.equal(binding.verifyAndPinIssuerBinding(PARENT, pin, [GEN0.address], "event-create").ok, true);
  const early = await registry.relayIssuerStatement(PARENT, await statement(1));
  assert.equal(early.ok, false);
  assert.match((early as { error: string }).error, /generation-0 statement first/);

  assert.equal((await registry.relayIssuerStatement(PARENT, await statement(0))).ok, true);

  const skip = await registry.relayIssuerStatement(PARENT, await statement(2));
  assert.equal(skip.ok, false);
  assert.match((skip as { error: string }).error, /must declare generation 1/);

  // A DIFFERENT statement for a generation that already stands.
  const dupe = await registry.relayIssuerStatement(PARENT, await statement(0, { reason: "rewritten" }));
  assert.equal(dupe.ok, false);
  assert.match((dupe as { error: string }).error, /one statement per generation/);

  // The byte-identical republish is the FEED-HEAL path, not a duplicate.
  const same = await registry.relayIssuerStatement(PARENT, await statement(0));
  assert.equal(same.ok, true);
  assert.equal(registry.getIssuerRegistry(PARENT).statements.length, 1);
});

test("a seed statement carrying a rotation co-signature is refused", async () => {
  reset();
  const prevSig = signPersonalMessage(
    buildIssuerRotationMessage(PARENT, 0, 1, GEN1.address),
    GEN0.privateKey,
  );
  const r = await registry.relayIssuerStatement(PARENT, await statement(0, { prevSig }));
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /seed statement cannot carry/);
});

// ---------------------------------------------------------------------------
// The gate write boundary — retirement enforcement wiring (source ratchet,
// same pattern as the create-route binding ratchets in issuer-binding.test.ts)
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("validatePodGate's cert arm refuses a retired issuer", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/lib/pod/gate-check.ts", import.meta.url)),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const at = src.indexOf("loadVerifiedBadgeManifest(g, { bypassCache: true })");
  assert.ok(at > 0);
  const after = src.slice(at, at + 700);
  assert.match(
    after,
    /if \(isRetiredIssuer\(badgeManifest\.body\.issuer\)\)/,
    "the retirement check must BE the guard condition — a neutered call must fail this",
  );
  assert.match(after, /return\s*\{\s*ok:\s*false/, "and a retired issuer must refuse the gate");
});
