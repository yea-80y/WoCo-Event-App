/**
 * The sign-in window's ceremonies (src/auth-window/ceremonies.ts): the same WebAuthn
 * options and checks the app ran in-page, ending in derived keys, never the PRF output.
 *
 * MUTATIONS (each turns this file red):
 *  - derive before the backup-handle check -> "a backup passkey is refused before anything is derived";
 *  - drop the cross-platform check -> "an answer from another device without a PRF value";
 *  - drop the quick-refusal timing -> "a refusal faster than any sheet is quick";
 *  - restore: retry without `fallback` -> "restore without fallback stays refused";
 *  - treat `enabled: false` as maybe -> "enabled false is a no, with no second tap";
 *  - skip the second tap -> "a creation with no PRF value asks for one more tap";
 *  - add: drop platform attachment, the exclude list or the cross-platform refusal -> the add tests;
 *  - backup: drop the backup handle -> "a backup passkey is tagged";
 *  - keep the PRF buffer -> "the PRF output is zeroed once derived".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  PASSKEY_PRF_SALT_INPUT,
  isAddedUserHandle,
  isBackupUserHandle,
  passkeyAccountKeys,
  passkeyGuardianKeys,
  type PasskeyWindowAccountResult,
  type PasskeyWindowGuardianResult,
  type PasskeyWindowRequest,
} from "@woco/shared";
import { WindowCeremonyError, runCeremony, type CeremonyDeps } from "../src/auth-window/ceremonies.js";

const PRF = () => new Uint8Array(32).fill(0xcd);
const RAW_ID = new Uint8Array(20).fill(9);
const RAW_ID_B64 = Buffer.from(RAW_ID).toString("base64url");
const SALT = new Uint8Array(createHash("sha256").update(PASSKEY_PRF_SALT_INPUT).digest());
/** Authenticator data carrying an AAGUID (flags 0x40 set). */
const AUTH_DATA = (() => {
  const d = new Uint8Array(53);
  d[32] = 0x40;
  d.set(new Uint8Array(16).fill(0xab), 37);
  return d;
})();

interface FakeCred {
  prf?: Uint8Array | null;
  enabled?: boolean;
  handle?: Uint8Array | null;
  attachment?: string | null;
}

function cred(o: FakeCred = {}) {
  const prf = o.prf === undefined ? PRF() : o.prf;
  return {
    rawId: RAW_ID.slice().buffer,
    authenticatorAttachment: o.attachment === undefined ? "platform" : o.attachment,
    response: { userHandle: o.handle ? o.handle.slice().buffer : null, getAuthenticatorData: () => AUTH_DATA.slice().buffer },
    getClientExtensionResults: () => ({ prf: prf ? { results: { first: prf } } : o.enabled === undefined ? {} : { enabled: o.enabled } }),
    _prf: prf,
  };
}

type Step = ReturnType<typeof cred> | Error | null;

function deps(script: { get?: Step[]; create?: Step[] }, opts: { slowMs?: number; tap?: "ok" | "cancel" } = {}) {
  const calls: Array<{ kind: "get" | "create"; options: any }> = [];
  let clock = 0;
  let taps = 0;
  const next = (kind: "get" | "create") => async (options: any) => {
    calls.push({ kind, options });
    const step = (script[kind] ?? []).shift();
    clock += opts.slowMs ?? 0;
    if (step instanceof Error) throw step;
    if (step === undefined) throw new Error(`unexpected ${kind}`);
    return step;
  };
  const d: CeremonyDeps = {
    credentials: { get: next("get") as any, create: next("create") as any },
    rpId: "auth.woco.eth.limo",
    tapAgain: async () => {
      taps++;
      if (opts.tap === "cancel") throw new Error("cancelled");
    },
    now: () => clock,
  };
  return { d, calls, taps: () => taps };
}

const req = (action: PasskeyWindowRequest["action"], extra: Partial<PasskeyWindowRequest> = {}): PasskeyWindowRequest => ({
  v: 1, type: "request", nonce: "n".repeat(22), action, ...extra,
});
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof WindowCeremonyError, String(e));
    return e.reply;
  }
  assert.fail("expected a refusal");
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const domError = (name: string) => new DOMException("browser says no", name);

test("sign-in: a discoverable get with the frozen salt, answered with the derived keys only", async () => {
  const { d, calls } = deps({ get: [cred()] });
  const r = (await runCeremony(req("signin"), d)) as PasskeyWindowAccountResult;
  const o = calls[0]!.options.publicKey;
  assert.equal(o.rpId, "auth.woco.eth.limo");
  assert.equal(o.userVerification, "required");
  assert.equal(o.allowCredentials, undefined);
  assert.equal(hex(o.extensions.prf.eval.first), hex(SALT));
  assert.deepEqual(Object.keys(r).sort(), ["aaguid", "attachment", "credentialId", "handleKind", "keys"]);
  assert.equal(r.credentialId, RAW_ID_B64);
  assert.equal(r.attachment, "platform");
  assert.equal(r.handleKind, null);
  assert.equal(r.aaguid, null);
  const want = passkeyAccountKeys(PRF());
  for (const k of Object.keys(want) as Array<keyof typeof want>) assert.equal(hex(r.keys[k]), hex(want[k]), k);
});

test("the PRF output is zeroed once derived", async () => {
  const c = cred();
  const { d } = deps({ get: [c] });
  await runCeremony(req("signin"), d);
  assert.ok(c._prf!.every((b) => b === 0));
});

test("a backup passkey is refused before anything is derived", async () => {
  const c = cred({ handle: new TextEncoder().encode("woco-backup-v1:0123456789abcdef") });
  const { d } = deps({ get: [c] });
  assert.deepEqual(await refusal(runCeremony(req("signin"), d)), { name: "IsBackup" });
  assert.ok(c._prf!.some((b) => b !== 0), "nothing touched the PRF output");
});

test("an added passkey signs in as one", async () => {
  const { d } = deps({ get: [cred({ handle: new TextEncoder().encode("woco-added-v1:0123456789abcdef") })] });
  assert.equal(((await runCeremony(req("signin"), d)) as PasskeyWindowAccountResult).handleKind, "added");
});

test("an answer from another device without a PRF value goes to pairing; from this one, unsupported", async () => {
  assert.deepEqual(await refusal(runCeremony(req("signin"), deps({ get: [cred({ prf: null, attachment: "cross-platform" })] }).d)), { name: "FromAnotherDevice" });
  assert.deepEqual(await refusal(runCeremony(req("signin"), deps({ get: [cred({ prf: null })] }).d)), { name: "PrfUnsupported" });
  assert.equal(((await runCeremony(req("signin"), deps({ get: [cred({ attachment: "cross-platform" })] }).d)) as PasskeyWindowAccountResult).attachment, "cross-platform");
});

test("a refusal faster than any sheet is quick; a slow one is not", async () => {
  assert.deepEqual(await refusal(runCeremony(req("signin"), deps({ get: [domError("NotAllowedError")] }).d)), { name: "NotAllowedError", quick: true });
  assert.deepEqual(await refusal(runCeremony(req("signin"), deps({ get: [domError("NotAllowedError")] }, { slowMs: 600 }).d)), { name: "NotAllowedError", quick: false });
  assert.deepEqual(await refusal(runCeremony(req("signin"), deps({ get: [domError("SecurityError")] }).d)), { name: "SecurityError" });
  assert.deepEqual(await refusal(runCeremony(req("signin"), deps({ get: [null] }).d)), { name: "NotAllowedError", quick: false });
  const odd = await refusal(runCeremony(req("signin"), deps({ get: [new TypeError("boom")] }).d));
  assert.equal(odd.name, "Unexpected");
  assert.match(odd.detail!, /TypeError: boom/);
});

test("a PRF output that is not 32 bytes derives nothing", async () => {
  assert.deepEqual(await refusal(runCeremony(req("signin"), deps({ get: [cred({ prf: new Uint8Array(31).fill(1) })] }).d)), { name: "BadPrfLength", detail: "31" });
});

test("restore asks for the pinned passkey, and opens the picker after a refusal only when told to", async () => {
  const pinned = deps({ get: [cred()] });
  await runCeremony(req("restore", { credentialId: RAW_ID_B64, fallback: false }), pinned.d);
  assert.equal(hex(pinned.calls[0]!.options.publicKey.allowCredentials[0].id), hex(RAW_ID));

  const fallback = deps({ get: [domError("NotAllowedError"), cred()] });
  await runCeremony(req("restore", { credentialId: RAW_ID_B64, fallback: true }), fallback.d);
  assert.equal(fallback.calls.length, 2);
  assert.equal(fallback.calls[1]!.options.publicKey.allowCredentials, undefined);

  const stay = deps({ get: [domError("NotAllowedError")] });
  assert.equal((await refusal(runCeremony(req("restore", { credentialId: RAW_ID_B64, fallback: false }), stay.d))).name, "NotAllowedError");
  assert.equal(stay.calls.length, 1, "restore without fallback stays refused");
});

test("create: today's options, the AAGUID, and the keys", async () => {
  const { d, calls, taps } = deps({ create: [cred()] });
  const r = (await runCeremony(req("create"), d)) as PasskeyWindowAccountResult;
  const o = calls[0]!.options.publicKey;
  assert.deepEqual(o.rp, { name: "WoCo", id: "auth.woco.eth.limo" });
  assert.equal(o.user.name, "WoCo Account");
  assert.equal(o.user.id.length, 32);
  assert.deepEqual(o.authenticatorSelection, { residentKey: "required", userVerification: "required" });
  assert.deepEqual(o.pubKeyCredParams.map((p: { alg: number }) => p.alg), [-7, -257]);
  assert.equal(r.aaguid, "abababab-abab-abab-abab-abababababab");
  assert.equal(hex(r.keys.ownerKey), hex(passkeyAccountKeys(PRF()).ownerKey));
  assert.equal(taps(), 0);
});

test("a creation with no PRF value asks for one more tap, then reads it from this credential", async () => {
  const { d, calls, taps } = deps({ create: [cred({ prf: null })], get: [cred()] });
  await runCeremony(req("create"), d);
  assert.equal(taps(), 1);
  assert.equal(hex(calls[1]!.options.publicKey.allowCredentials[0].id), hex(RAW_ID));
});

test("enabled false is a no, with no second tap, naming the manager and the passkey", async () => {
  const { d, taps } = deps({ create: [cred({ prf: null, enabled: false })] });
  assert.deepEqual(await refusal(runCeremony(req("create"), d)), {
    name: "PrfUnsupported", aaguid: "abababab-abab-abab-abab-abababababab", label: "WoCo Account",
  });
  assert.equal(taps(), 0);
});

test("after a creation, a cancelled tap or a refused follow-up still says the passkey exists", async () => {
  assert.deepEqual(await refusal(runCeremony(req("create"), deps({ create: [cred({ prf: null })] }, { tap: "cancel" }).d)), { name: "CreatedWithoutSecret" });
  assert.deepEqual(await refusal(runCeremony(req("create"), deps({ create: [cred({ prf: null })], get: [domError("NotAllowedError")] }).d)), { name: "CreatedWithoutSecret" });
  assert.deepEqual(await refusal(runCeremony(req("create"), deps({ create: [cred({ prf: null })], get: [cred({ prf: null })] }).d)), {
    name: "PrfUnsupported", aaguid: "abababab-abab-abab-abab-abababababab", label: "WoCo Account",
  });
});

test("add: platform only, refusing every passkey the account has, tagged as added", async () => {
  const other = Buffer.from(new Uint8Array(20).fill(3)).toString("base64url");
  const { d, calls } = deps({ create: [cred()] });
  const r = (await runCeremony(req("add", { exclude: [other], createdOn: "21 Oct 2026" }), d)) as PasskeyWindowAccountResult;
  const o = calls[0]!.options.publicKey;
  assert.equal(o.authenticatorSelection.authenticatorAttachment, "platform");
  assert.deepEqual(o.excludeCredentials.map((c: { id: Uint8Array }) => hex(c.id)), [hex(new Uint8Array(20).fill(3))]);
  assert.equal(o.user.name, "WoCo Account - added 21 Oct 2026");
  assert.ok(isAddedUserHandle(o.user.id));
  assert.equal(r.handleKind, "added");
  assert.deepEqual(
    await refusal(runCeremony(req("add", { exclude: [], createdOn: "x" }), deps({ create: [cred({ attachment: "cross-platform" })] }).d)),
    { name: "NotOnThisDevice" },
  );
  assert.deepEqual(
    await refusal(runCeremony(req("add", { exclude: [], createdOn: "x" }), deps({ create: [domError("InvalidStateError")] }).d)),
    { name: "InvalidStateError" },
  );
  const unnamed = await refusal(runCeremony(req("add", { exclude: [], createdOn: "x" }), deps({ create: [cred({ prf: null, enabled: false })] }).d));
  assert.equal(unnamed.label, "WoCo Account - added x");
});

test("a backup passkey is tagged, and answers with guardian keys only", async () => {
  const { d, calls } = deps({ create: [cred()] });
  const r = (await runCeremony(req("backup-create"), d)) as PasskeyWindowGuardianResult;
  const o = calls[0]!.options.publicKey;
  assert.equal(o.user.name, "WoCo Backup");
  assert.ok(isBackupUserHandle(o.user.id));
  assert.deepEqual(Object.keys(r), ["keys"]);
  assert.equal(hex(r.keys.escrowMaster), hex(passkeyGuardianKeys(PRF()).escrowMaster));
  const got = (await runCeremony(req("backup-get"), deps({ get: [cred()] }).d)) as PasskeyWindowGuardianResult;
  assert.deepEqual(Object.keys(got.keys).sort(), ["escrowMaster", "ownerKey"]);
});
