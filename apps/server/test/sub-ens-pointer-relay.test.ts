/**
 * Registrar v2.2 — the platform mints EMPTY names and relays pointer writes
 * the HOLDER signed. It holds no key that can change what a name says (Fable
 * sponsor-key consult §2).
 *
 * The on-chain check is the boundary: `setContenthashWithSignature` verifies
 * the holder's EIP-712 signature against a per-name nonce and the chain's
 * clock. What the server owes is everything around it, the same list the
 * release relay owes (`sub-ens-relay-release.test.ts`): a bounded expiration on
 * the chain's clock, simulation outside the shared queue, a per-node in-flight
 * lock, named refusals, and no signature in any log line. Plus two things only
 * this path has: the identity name points at the app and nowhere else, and the
 * key that pays for names is not the key that pays for tickets.
 *
 * Wiring is pinned as source guards (the route sits behind `requireAuth` and a
 * chain read the suite has no harness for); the decisions that can be pure
 * are tested as functions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Wallet } from "ethers";
import { sponsorKeysConflict } from "../src/lib/chain/sub-ens-contract.js";

function sourceOf(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
}

const ROUTE = sourceOf("../src/routes/sub-ens.ts");
const CHAIN = sourceOf("../src/lib/chain/sub-ens-contract.ts");

function between(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `${from} not found`);
  const end = src.indexOf(to, start + from.length);
  assert.ok(end > start, `the end of ${from} was not found`);
  return src.slice(start, end);
}

const POINTER = between(ROUTE, 'subEnsRoutes.post("/set-contenthash"', "\n});");
const CLAIM = between(ROUTE, 'subEnsRoutes.post("/claim"', "\n});");
const REGISTRAR_ABI = between(CHAIN, "const REGISTRAR_ABI", "];");
const RELAY_HELPER = between(CHAIN, "export async function relaySignedContenthash", "\n}\n");
const MINT_HELPER = between(CHAIN, "export async function mintSubEnsName", "\n}\n");

// ---------------------------------------------------------------------------
// The registrar surface the server can reach
// ---------------------------------------------------------------------------

test("the sponsor-only pointer setter is gone from the ABI, and cannot be re-added quietly", () => {
  // Registrar v2.2 deletes `setContenthash(string,bytes)`. A fragment left here
  // would compile against a contract that no longer has it and fail at runtime
  // as a generic revert — and would read as if the platform still held that power.
  assert.doesNotMatch(REGISTRAR_ABI, /function setContenthash\(string label, bytes contenthash\)/);
  assert.match(
    REGISTRAR_ABI,
    /"function setContenthashWithSignature\(string label, bytes contenthash, uint256 expiration, bytes signature\)"/,
  );
});

test("register takes a label and a holder, nothing a sponsor would choose", () => {
  assert.match(REGISTRAR_ABI, /"function register\(string label, address owner\) returns \(bytes32 node\)"/);
  assert.match(MINT_HELPER, /contract\.register\(label, ownerAddress, o\)/);
  assert.doesNotMatch(MINT_HELPER, /contenthash|textKeys|textValues/);
});

test("the claim route takes no pointer and no text records", () => {
  // The client used to send `swarmHash` and `description` here; both went into
  // the sponsor's mint. A field accepted and ignored would still read as a
  // promise, so they are not read at all.
  assert.doesNotMatch(CLAIM, /swarmHash|description|avatar|textKeys/);
  assert.match(CLAIM, /mintSubEnsName\(label, parentAddress\)/);
});

test("the registrar-wide mint cap is its own answer: 503 with the reset time", () => {
  assert.match(REGISTRAR_ABI, /"error GlobalMintCapExceeded\(uint64 windowResetsAt\)"/);
  assert.match(
    CLAIM,
    /name === "GlobalMintCapExceeded"\) \{[\s\S]*?windowResetsAt = Number\(revert\?\.args\?\.\[0\][\s\S]*?"mint_global_cap", data: \{ windowResetsAt \} \}, 503\)/,
  );
  // The per-recipient cap stays a 429 about the CALLER: two different stories.
  assert.match(CLAIM, /"mint_rate_cap", data: \{ windowResetsAt \} \}, 429\)/);
});

test("every refusal the signed write can raise has a fragment ethers can name", () => {
  for (const frag of [
    "error NotHolderSignature(bytes32 node)",
    "error LabelNotRegistered(string label)",
    "error SignatureExpired()",
    "error ExpirationTooFar()",
    "error EmptyContenthash()",
    "error InvalidLabel(string label)",
    "error LabelIsReserved(string label)",
    "error Unauthorized(bytes32 node)",
  ]) {
    assert.ok(REGISTRAR_ABI.includes(`"${frag}"`), `missing ${frag}`);
  }
});

// ---------------------------------------------------------------------------
// The relay route
// ---------------------------------------------------------------------------

test("the route relays the holder's signature over the validated label, nothing from the body beyond it", () => {
  assert.match(POINTER, /relaySignedContenthash\(label, swarmHash, expiration, signature\)/);
  assert.match(POINTER, /const validationError = validateLabel\(label\);/);
  assert.doesNotMatch(POINTER, /body\.node|body\.signer|body\.owner/);
});

test("the pointer is a lowercase 64-hex Swarm reference, checked before any chain work", () => {
  assert.match(POINTER, /\.toLowerCase\(\);\s*if \(!\/\^\[a-f0-9\]\{64\}\$\/\.test\(swarmHash\)\)/);
  assert.match(POINTER, /if \(!isWholeBytesHex\(signature\)\)/);
  const hashCheck = POINTER.indexOf("[a-f0-9]{64}");
  assert.ok(hashCheck > 0 && hashCheck < POINTER.indexOf("refuseUnlessExpiryInWindow"));
});

test("the expiration window is the chain-clock one both relays share", () => {
  assert.match(POINTER, /const expiryRefused = await refuseUnlessExpiryInWindow\(c, body\.expiration\);\s*if \(expiryRefused\) return expiryRefused;/);
});

test("ownership is a gas policy checked before anything is charged or sent", () => {
  const owner = POINTER.indexOf("refuseUnlessOwner(c, label, parentAddress)");
  const charge = POINTER.indexOf("pointerLimits.account.record");
  const relay = POINTER.indexOf("relaySignedContenthash(");
  assert.ok(owner > 0 && owner < charge && charge < relay);
});

test("the identity name may point at the app and nowhere else", () => {
  assert.match(
    POINTER,
    /if \(isProfileName\(parentAddress, label\) && swarmHash !== getApexContenthash\(\)\) \{\s*return c\.json\(\{ ok: false, error: "profile_name" \}, 409\);/,
  );
  // An unconfigured apex is null, so the comparison refuses EVERY target for a
  // profile name — the fail-closed direction.
  assert.ok(POINTER.indexOf("profile_name") < POINTER.indexOf("relaySignedContenthash("));
});

test("both pointer budgets are peeked before either is charged, apart from the release budget", () => {
  const peek = POINTER.indexOf("pointerLimits.global.peek");
  const record = POINTER.indexOf("pointerLimits.account.record");
  assert.ok(peek > 0 && peek < record);
  assert.doesNotMatch(POINTER, /releaseLimits/, "binding sites must not spend the budget a discard needs");
});

test("a pointer already in flight for the node is refused, and the lock is freed in a finally", () => {
  assert.match(POINTER, /^\s*const node = labelNode\(label\);\s*$/m);
  assert.match(POINTER, /pointersInFlight\.has\(node\)/);
  assert.match(POINTER, /"pointer_in_flight" \}, 409\)/);
  assert.match(POINTER, /finally\s*\{\s*pointersInFlight\.delete\(node\);/);
});

test("contract refusals are named, not 500s", () => {
  for (const [name, code, status] of [
    ["NotHolderSignature", "signature_not_authorised", 403],
    ["SignatureExpired", "signature_expired", 400],
    ["ExpirationTooFar", "expiration_too_far", 400],
    ["LabelNotRegistered", "label not found", 404],
    ["LabelIsReserved", "label is reserved", 409],
  ] as const) {
    assert.match(
      POINTER,
      new RegExp(`name === "${name}"\\)\\s*return c\\.json\\(\\{ ok: false, error: "${code}" \\}, ${status}\\);`),
      `${name} must answer ${status} ${code}`,
    );
  }
  assert.match(POINTER, /name === "Unauthorized"\) \{[\s\S]*?503\)/);
});

test("the signature never reaches a log line", () => {
  assert.match(POINTER, /logRelayFailure\("set-contenthash relay", label, err\)/);
  const logs = [...(POINTER + RELAY_HELPER).matchAll(/console\.(log|warn|error)\(([\s\S]*?)\);/g)].map((m) => m[2]);
  assert.ok(logs.length > 0, "expected at least one log line to check");
  for (const line of logs) {
    assert.doesNotMatch(line, /signature/, `log line leaks the signature: ${line}`);
    assert.doesNotMatch(line, /\bbody\b/, `log line dumps the body: ${line}`);
    assert.doesNotMatch(line, /\.message\b|\berr\b\)?$/, `log line may carry the calldata: ${line}`);
  }
});

// ---------------------------------------------------------------------------
// The chain helper
// ---------------------------------------------------------------------------

test("the pointer relay simulates outside the queue, estimates inside it, and pads the limit", () => {
  const sim = RELAY_HELPER.indexOf("setContenthashWithSignature.staticCall(label, contenthash, expiration, signature)");
  const queue = RELAY_HELPER.indexOf("sendSponsorTx(");
  assert.ok(sim > 0 && sim < queue, "simulation must happen OUTSIDE the names key's nonce queue");
  const inQueue = RELAY_HELPER.slice(queue, RELAY_HELPER.indexOf("tx.wait"));
  assert.match(inQueue, /setContenthashWithSignature\.estimateGas\(label, contenthash, expiration, signature\)/);
  assert.match(inQueue, /gasLimit: paddedRelayGasLimit\(estimate\)/);
  assert.match(inQueue, /\.\.\.o,/, "the nonce override must still reach the send");
  assert.doesNotMatch(inQueue, /wait\(/, "the confirmation is awaited outside the queue");
});

// ---------------------------------------------------------------------------
// Two sponsor keys
// ---------------------------------------------------------------------------

test("every sub-ENS transaction is sent by the NAMES key, and none falls back to the events key", () => {
  // The events key is named once, by the boot check that compares the two.
  const conflictCheck = between(CHAIN, "export function sponsorKeysConflict", "\n}\n");
  assert.doesNotMatch(CHAIN.replace(conflictCheck, ""), /WOCO_SPONSOR_PRIVATE_KEY/, "a soft split is no split");
  assert.doesNotMatch(CHAIN, /getSponsorAddress\(\)/, "the events key's address must not key a names queue");
  const sends = [...CHAIN.matchAll(/sendSponsorTx\(\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.equal(sends.length, 3, "mint, pointer relay, release relay");
  for (const s of sends) assert.match(s, /address: getSubEnsSponsorAddress\(\)/);
});

test("the boot check refuses the same key under both names", () => {
  const key = Wallet.createRandom().privateKey;
  assert.match(
    sponsorKeysConflict({ SUB_ENS_SPONSOR_PRIVATE_KEY: key, WOCO_SPONSOR_PRIVATE_KEY: key }) ?? "",
    /must not be the same key/,
  );
  // Compared as ADDRESSES: the same key with and without 0x, or padded, is the same key.
  assert.ok(
    sponsorKeysConflict({ SUB_ENS_SPONSOR_PRIVATE_KEY: ` ${key} `, WOCO_SPONSOR_PRIVATE_KEY: key.slice(2) }),
    "formatting must not hide a shared key",
  );
});

test("the boot check passes two different keys, and an unset one", () => {
  const a = Wallet.createRandom().privateKey;
  const b = Wallet.createRandom().privateKey;
  assert.equal(sponsorKeysConflict({ SUB_ENS_SPONSOR_PRIVATE_KEY: a, WOCO_SPONSOR_PRIVATE_KEY: b }), null);
  // Unset names key = names unavailable (loudly, at the first mint), not a boot failure.
  assert.equal(sponsorKeysConflict({ WOCO_SPONSOR_PRIVATE_KEY: b }), null);
  assert.equal(sponsorKeysConflict({}), null);
});

test("a malformed key is refused at boot rather than at the first mint", () => {
  assert.match(
    sponsorKeysConflict({ SUB_ENS_SPONSOR_PRIVATE_KEY: "0x1234", WOCO_SPONSOR_PRIVATE_KEY: Wallet.createRandom().privateKey }) ?? "",
    /not a valid private key/,
  );
});

test("the server refuses to boot on a conflict", () => {
  const index = sourceOf("../src/index.ts");
  assert.match(index, /const conflict = sponsorKeysConflict\(\);\s*if \(conflict\) \{[\s\S]*?process\.exit\(1\);/);
});
