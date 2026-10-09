/**
 * A passkey a removal left without the account's keys gets them back (#186): its code
 * carries its member - public and self-authenticating - and another passkey on the
 * account puts it in the ring. Real code, channel and member crypto; an in-memory
 * mailbox stands in for the server's.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { memberOf, memberFromWire, memberToWire } from "../src/lib/keyring/members.ts";
import { parseKeysOffer, parsePairingOffer, readPairingOffer, runGetKeys, runGiveKeys } from "../src/lib/auth/device-link.ts";
import { PairingExpiredError, type PairingTransport } from "../src/lib/auth/pairing-channel.ts";

const PARENT = "0x" + "4a".repeat(20);

function passkey(seedByte: number) {
  const prf = "0x" + seedByte.toString(16).padStart(2, "0").repeat(32);
  const privateKey = "0x" + bytesToHex(keccak_256(new Uint8Array(32).fill(seedByte)));
  const pub = secp256k1.getPublicKey(Buffer.from(privateKey.slice(2), "hex"), false).slice(1);
  const address = "0x" + bytesToHex(keccak_256(pub).slice(-20));
  return { address, privateKey, prfSecret: prf };
}

function mailbox(): PairingTransport {
  const slots = new Map<string, string>();
  return {
    async post(id, slot, box) {
      if (slots.has(`${id}/${slot}`)) throw new PairingExpiredError();
      slots.set(`${id}/${slot}`, box);
    },
    async read(id, slot) {
      return slots.get(`${id}/${slot}`) ?? null;
    },
  };
}

test("a member travels and is checked: its own statement, its own box key, this account", async () => {
  const p = passkey(7);
  const wire = memberToWire(await memberOf(PARENT, p));
  const back = await memberFromWire(JSON.parse(JSON.stringify(wire)), PARENT);
  assert.equal(back?.statement.coOwner, p.address);

  const other = memberToWire(await memberOf(PARENT, passkey(8)));
  assert.equal(await memberFromWire({ ...wire, boxKey: other.boxKey }, PARENT), null, "someone else's box key");
  assert.equal(await memberFromWire(wire, "0x" + "5b".repeat(20)), null, "another account");
  const st = wire.statement as Record<string, unknown>;
  assert.equal(await memberFromWire({ ...wire, statement: { ...st, coOwner: passkey(9).address } }, PARENT), null, "a name it didn't sign");
  assert.equal(await memberFromWire({ ...wire, boxKey: "00" }, PARENT), null);
});

test("a keys offer is its own kind; the link parser still reads only links", async () => {
  const wire = memberToWire(await memberOf(PARENT, passkey(7)));
  const offer = { v: 1, kind: "keys", member: wire };
  assert.deepEqual(parseKeysOffer(offer), offer);
  assert.equal(parsePairingOffer(offer)?.kind, "keys");
  assert.equal(parseKeysOffer({ ...offer, kind: "link" }), null);
  assert.equal(parseKeysOffer({ ...offer, member: { boxKey: wire.boxKey } }), null);
});

test("both sides through the code: the asker returns only once the giver has saved", async () => {
  const m = mailbox();
  const wire = memberToWire(await memberOf(PARENT, passkey(7)));
  const given: unknown[] = [];
  let shown: { typed: string } | null = null;
  const asking = runGetKeys({ onCode: (c) => (shown = c) }, { apiBase: "", member: wire, transport: m });
  while (!shown) await new Promise((r) => setTimeout(r, 5));
  const read = await readPairingOffer(shown!.typed, { apiBase: "", transport: m });
  assert.equal(read.offer.kind, "keys");
  if (read.offer.kind !== "keys") return;
  await runGiveKeys(read.code, read.offer, { apiBase: "", transport: m, give: async (w) => void given.push(w) });
  await asking;
  assert.equal(given.length, 1);
  assert.deepEqual(given[0], wire);
});

test("giving keys: only a passkey already on the list, never this one, in one op, then held here", () => {
  const src = readFileSync(new URL("../src/lib/keyring/account-keys.ts", import.meta.url), "utf8");
  const give = src.slice(src.indexOf("export async function giveKeysTo("), src.indexOf("export async function requestKeys("));
  const listed = give.indexOf(".includes(who)");
  assert.ok(listed > 0 && listed < give.indexOf("await ringForChange(h, [member])"), "on the list BEFORE the ring is built");
  assert.match(give, /if \(who === self\) throw/);
  assert.match(give, /setKeyRingAlone\(kernel, \{ prev: ring\.prev, next: ring\.next \}\);\s*if \(!res\.confirmed\) throw[\s\S]*await adoptOwnRing\(h, ring\.chain\);/);
  const store = readFileSync(new URL("../src/lib/auth/auth-store.svelte.ts", import.meta.url), "utf8");
  assert.match(store, /giveKeys: async \(code: Uint8Array, offer: import\("\.\/device-link\.js"\)\.KeysOffer\) => \{\s*if \(_deviceRole\) throw new MainPasskeyRequiredError\(\);\s*await _freshMainPasskey\(\);/);
});
