/**
 * The pairing channel (#746 step 4): what the two devices can rely on whatever
 * carries their messages.
 *
 *  - a code has exactly one spelling, survives the usual misreads, and the QR is
 *    not a URL;
 *  - a message opens only under the code it was sealed with, in the slot it was
 *    sealed for, unaltered;
 *  - the seed opens only with the one-pairing key, for the grantee it was sealed
 *    to, and that key can be wiped;
 *  - waiting ends on the message, on expiry or on cancel - never on a blip.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  PAIRING_QR_PREFIX,
  PairingExpiredError,
  formatPairingCode,
  httpPairingTransport,
  newPairingCode,
  newPairingRecipient,
  openLinkSecret,
  pairingChannel,
  pairingQrPayload,
  parsePairingCode,
  sealLinkSecret,
  waitForSlot,
  type PairingTransport,
} from "../src/lib/auth/pairing-channel.ts";

const code = Uint8Array.from({ length: 16 }, (_, i) => i * 17);

test("code: formats, parses back, tolerates misreads, one spelling only", () => {
  const typed = formatPairingCode(code);
  assert.match(typed, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}-[0-9A-Z]{6}$/);
  assert.doesNotMatch(typed, /[ILOU]/);
  assert.deepEqual(parsePairingCode(typed), code);
  assert.deepEqual(parsePairingCode(` ${typed.toLowerCase().replace(/-/g, " ")} `), code);
  assert.deepEqual(parsePairingCode(typed.replace(/0/g, "O").replace(/1/g, "l")), code);
  assert.deepEqual(parsePairingCode(pairingQrPayload(code)), code);
  assert.ok(pairingQrPayload(code).startsWith(PAIRING_QR_PREFIX));
  assert.doesNotMatch(pairingQrPayload(code), /^https?:/);

  const plain = typed.replace(/-/g, "");
  assert.equal(parsePairingCode(plain.slice(1)), null);
  assert.equal(parsePairingCode(plain + "0"), null);
  assert.equal(parsePairingCode(plain.slice(0, -1) + "U"), null);
  // The last character's two padding bits must be zero.
  const last = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".indexOf(plain.at(-1)!);
  const padded = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[last ^ 1];
  assert.equal(parsePairingCode(plain.slice(0, -1) + padded), null);

  for (let i = 0; i < 50; i++) {
    const c = newPairingCode();
    assert.deepEqual(parsePairingCode(formatPairingCode(c)), c);
  }
});

test("channel: one code, one mailbox id; a message opens only where it was sealed", async () => {
  const a = pairingChannel(code);
  assert.match(a.id, /^[0-9a-f]{64}$/);
  assert.equal(pairingChannel(code).id, a.id);
  const other = pairingChannel(newPairingCode());
  assert.notEqual(other.id, a.id);

  const box = await a.seal("offer", { hello: "x" });
  assert.deepEqual(await pairingChannel(code).open("offer", box), { hello: "x" });
  await assert.rejects(other.open("offer", box));
  await assert.rejects(a.open("answer", box));

  const bytes = Buffer.from(box.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  bytes[bytes.length - 20] ^= 1;
  const tampered = bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await assert.rejects(a.open("offer", tampered));
  await assert.rejects(a.open("offer", "AAAA"));
  assert.notEqual(await a.seal("offer", { hello: "x" }), box);
});

test("link secret: opens only with the one-pairing key, for its grantee and mailbox", async () => {
  const id = pairingChannel(code).id;
  const grantee = "0x" + "ab".repeat(20);
  const secret = { parent: "0x" + "cd".repeat(20), seed: "11".repeat(32) };
  const recipient = newPairingRecipient();
  const box = await sealLinkSecret(recipient.publicKeyHex, secret, { id, grantee });
  assert.deepEqual(await openLinkSecret(recipient, box, { id, grantee: grantee.toUpperCase().replace("0X", "0x") }), secret);
  await assert.rejects(openLinkSecret(recipient, box, { id, grantee: "0x" + "ef".repeat(20) }));
  await assert.rejects(openLinkSecret(recipient, box, { id: "0".repeat(64), grantee }));

  // A box sealed to any other key - a substituted recipient - does not open here.
  const stranger = newPairingRecipient();
  const theirs = await sealLinkSecret(stranger.publicKeyHex, secret, { id, grantee });
  await assert.rejects(openLinkSecret(recipient, theirs, { id, grantee }));

  recipient.forget();
  assert.ok(recipient.secretKey.every((b) => b === 0));
  await assert.rejects(openLinkSecret(recipient, box, { id, grantee }));
});

test("link secret: a well-sealed box with the wrong shape is refused", async () => {
  const { sealBox } = await import("@woco/shared/crypto/sealed-box");
  const id = pairingChannel(code).id;
  const grantee = "0x" + "ab".repeat(20);
  const recipient = newPairingRecipient();
  const ctx = { info: "woco/device-pairing/v1/link", aad: `woco/device-pairing/v1/link:${id}:${grantee}` };
  const good = { v: 1, parent: "0x" + "cd".repeat(20), seed: "11".repeat(32) };
  for (const change of [{ v: 2 }, { parent: "0x" + "cd".repeat(19) }, { parent: 7 }, { seed: "11" }, { seed: null }]) {
    const bad = await sealBox(recipient.publicKeyHex, new TextEncoder().encode(JSON.stringify({ ...good, ...change })), ctx);
    await assert.rejects(openLinkSecret(recipient, bad, { id, grantee }), /expected shape/, JSON.stringify(change));
  }
});

function fakeTransport(script: Array<string | null | "gone" | Error>): PairingTransport & { reads: number } {
  const t = {
    reads: 0,
    async post() {},
    async read() {
      const next = script[Math.min(t.reads++, script.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return t;
}

const noSleep = async () => {};

test("waiting: returns the message, retries blips, ends on expiry and cancel", async () => {
  const t = fakeTransport([null, new Error("offline"), null, "box!"]);
  assert.equal(await waitForSlot(t, "id", "answer", { sleep: noSleep }), "box!");
  assert.equal(t.reads, 4);

  await assert.rejects(waitForSlot(fakeTransport([null, "gone"]), "id", "answer", { sleep: noSleep }), PairingExpiredError);
  await assert.rejects(
    waitForSlot(fakeTransport([null]), "id", "answer", { sleep: noSleep, deadline: Date.now() - 1 }),
    PairingExpiredError,
  );
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(waitForSlot(fakeTransport([null]), "id", "answer", { sleep: noSleep, signal: ac.signal }), {
    name: "AbortError",
  });
});

test("http transport: no credentials; expiry and conflicts read as expired", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const replies: Response[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return replies.shift()!;
  }) as unknown as typeof fetch;
  const t = httpPairingTransport("https://api.example", fetchFn);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  replies.push(json(200, { ok: true }));
  await t.post("ab", "offer", "box");
  assert.equal(calls[0].url, "https://api.example/api/pairing/ab/offer");
  assert.equal(calls[0].init?.credentials, "omit");
  assert.equal(calls[0].init?.body, JSON.stringify({ box: "box" }));

  replies.push(json(409, { ok: false }), json(410, { ok: false }));
  await assert.rejects(t.post("ab", "answer", "x"), PairingExpiredError);
  await assert.rejects(t.post("ab", "answer", "x"), PairingExpiredError);

  replies.push(json(200, { ok: true, data: { box: null } }), json(200, { ok: true, data: { box: "b" } }), json(410, {}));
  assert.equal(await t.read("ab", "answer"), null);
  assert.equal(await t.read("ab", "answer"), "b");
  assert.equal(await t.read("ab", "answer"), "gone");
});
