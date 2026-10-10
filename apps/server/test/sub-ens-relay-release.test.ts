/**
 * The release relay — the one path in sub-ENS where the platform spends the
 * sponsor key on an IRREVERSIBLE action.
 *
 * The security boundary is on-chain: `releaseWithSignature` checks that
 * `signer` is the holder BEFORE it looks at the signature (registry v2.1), so
 * the sponsor can only relay what a holder authorised and can never forge one. What the ROUTE owes is therefore not authorisation — it is
 * everything around it:
 *
 *   · `signer` and `node` derived server-side, never taken from the body
 *   · a bounded `expiration`, so a signature is not a long-lived bearer token
 *     authorising a burn, and not so short it reverts at our expense
 *   · simulation BEFORE the shared sponsor nonce queue, which ticket fulfilment
 *     also uses
 *   · a per-node in-flight lock, since two posts of one signature both pass
 *     simulation and the second reverts on-chain
 *   · named refusals rather than a 500
 *   · no signature in any log line
 *
 * The route sits behind `requireAuth` and a chain read and the suite has no
 * harness for either, so the bounds are tested as pure functions and the wiring
 * as a source guard — the regression that happens is a dropped call, not a
 * miscomputed comparison.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { labelNode, paddedRelayGasLimit, RELAY_GAS_FIXED_PAD } from "../src/lib/chain/sub-ens-contract.js";
import { isWholeBytesHex, relayExpiryInWindow } from "../src/routes/sub-ens.js";

function sourceOf(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
}

const ROUTE = sourceOf("../src/routes/sub-ens.ts");
const RELAY = ROUTE.slice(ROUTE.indexOf('subEnsRoutes.post("/relay-release"'));
const CHAIN = sourceOf("../src/lib/chain/sub-ens-contract.ts");

/** One top-level function of the route file, bounded at the next top-level
 *  statement — never run to end-of-file, which would widen what it checks. */
function routeFunction(name: string): string {
  const start = ROUTE.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found`);
  const end = ROUTE.indexOf("\n}\n", start);
  assert.ok(end > start, `the end of ${name} was not found`);
  return ROUTE.slice(start, end + 2);
}
const EXPIRY = routeFunction("refuseUnlessExpiryInWindow");
const LOG = routeFunction("logRelayFailure");

/** Just the relay helper — bounded at the next top-level declaration, or a
 *  slice running to end-of-file picks up other functions' contract calls. */
function relayHelper(): string {
  const start = CHAIN.indexOf("export async function relayReleaseWithSignature");
  assert.ok(start > 0, "relayReleaseWithSignature not found");
  const next = CHAIN.indexOf("\nexport ", start + 10);
  return CHAIN.slice(start, next > 0 ? next : undefined);
}

// ---------------------------------------------------------------------------
// node derivation
// ---------------------------------------------------------------------------

test("the node is derived from the label, deterministically", () => {
  const a = labelNode("punkpub");
  assert.match(a, /^0x[0-9a-f]{64}$/);
  assert.equal(a, labelNode("punkpub"));
});

test("different labels give different nodes", () => {
  assert.notEqual(labelNode("punkpub"), labelNode("punkpubb"));
});

test("the node derivation is case-normalised by the caller, not silently here", () => {
  // The route lowercases before validating, so this asserts the two are NOT
  // silently equal — a route that forgot to normalise must not be masked.
  assert.notEqual(labelNode("PunkPub"), labelNode("punkpub"));
});

// ---------------------------------------------------------------------------
// What the route must never accept
// ---------------------------------------------------------------------------

test("the node is computed from the validated label, never read from the body", () => {
  // Asserted as the WHOLE assignment, not merely "labelNode appears somewhere":
  // a fallback such as `body.node ?? labelNode(label)` satisfies a substring
  // match and any `body\.node` grep can be sidestepped with a cast. A
  // body-supplied node would aim the holder's signature at a name the
  // ownership check never saw.
  assert.match(RELAY, /^\s*const node = labelNode\(label\);\s*$/m);
  const nodeAssignments = [...RELAY.matchAll(/const node\s*=([^;]*);/g)].map((m) => m[1].trim());
  assert.deepEqual(nodeAssignments, ["labelNode(label)"], "the node must have exactly one source");
});

test("the signer is the VERIFIED parent, never a body field", () => {
  assert.match(RELAY, /relayReleaseWithSignature\(node, expiration, parentAddress, signature\)/);
  assert.doesNotMatch(RELAY, /body\.signer/);
});

test("an ODD-LENGTH signature is refused here, not 500'd by ethers", () => {
  // `0x` + an odd number of hex characters is not a byte string, but it passes
  // a `[0-9a-fA-F]+` test. It used to travel into `getBytes` inside the relay
  // and throw INVALID_ARGUMENT, which this route answers as a 500 — the server
  // blaming itself for a malformed field and telling the caller nothing.
  assert.equal(isWholeBytesHex("0xabc"), false);
  assert.equal(isWholeBytesHex(`0x${"ab".repeat(64)}c`), false, "65.5 bytes is not 65 bytes");
});

test("a real EOA signature is accepted", () => {
  assert.equal(isWholeBytesHex(`0x${"ab".repeat(65)}`), true);
});

test("a VARIABLE-LENGTH contract signature is accepted — 65 bytes is not the rule", () => {
  // `releaseWithSignature` verifies through the ERC-6492 universal validator, so
  // a Kernel or Coinbase Smart Wallet holder's signature is an arbitrary-length
  // wrapped blob (release-rails.ts). Pinning 65 would refuse every smart-account
  // release the moment those rails switch on.
  for (const bytes of [1, 64, 65, 66, 200, 517]) {
    assert.equal(isWholeBytesHex(`0x${"ab".repeat(bytes)}`), true, `${bytes} bytes must pass`);
  }
});

test("everything that is not 0x-prefixed whole-byte hex is refused", () => {
  for (const bad of [
    "0x",                                  // prefix only — no bytes at all
    "abab",                                // unprefixed
    "0xzz",                                // not hex
    `0x${"ab".repeat(64)} `,               // trailing space
    " 0xabab",                             // leading space
    "0Xabab",                              // wrong prefix case: ethers is strict too
    undefined,
    null,
    12345,
    { signature: "0xabab" },
  ]) {
    assert.equal(isWholeBytesHex(bad), false, `accepted: ${JSON.stringify(bad)}`);
  }
});

test("the route refuses a malformed signature with a 400, before any chain work", () => {
  assert.match(
    RELAY,
    /if \(!isWholeBytesHex\(signature\)\) \{\s*return c\.json\(\{ ok: false, error: "[^"]+" \}, 400\);/,
    "the check must answer 400 in the route's own envelope",
  );
  assert.doesNotMatch(RELAY, /\[0-9a-fA-F\]\+/, "the loose any-length hex test must be gone");
  const checkIdx = RELAY.indexOf("isWholeBytesHex(signature)");
  const relayIdx = RELAY.indexOf("relayReleaseWithSignature(");
  assert.ok(checkIdx > 0 && checkIdx < relayIdx, "validation must precede the relay call");
});

test("expiration is bounded at BOTH ends", () => {
  const now = 1_800_000_000;
  assert.equal(relayExpiryInWindow(now + 59, now), false, "under a minute");
  assert.equal(relayExpiryInWindow(now + 60, now), true, "exactly a minute");
  assert.equal(relayExpiryInWindow(now + 600, now), true, "the client's ten minutes");
  assert.equal(relayExpiryInWindow(now + 15 * 60, now), true, "exactly fifteen minutes");
  assert.equal(relayExpiryInWindow(now + 15 * 60 + 1, now), false, "past fifteen minutes");
  assert.equal(relayExpiryInWindow(now - 1, now), false, "already past");
  // A non-integer must not slip through as NaN and compare false on both sides.
  assert.equal(relayExpiryInWindow(Number.NaN, now), false);
  assert.equal(relayExpiryInWindow(now + 600.5, now), false);
  assert.match(EXPIRY, /expiration_out_of_range/);
  assert.match(EXPIRY, /Number\.isInteger\(expiration\)/);
});

test("the window is measured on the CHAIN's clock, not ours (audit 950 Low 13)", () => {
  // Arbitrum's block.timestamp may run a day behind or an hour ahead; the
  // registry compares against it, so the relay must too.
  assert.match(EXPIRY, /chainNowSecs = await getSubEnsChainTime\(\)/);
  assert.match(EXPIRY, /relayExpiryInWindow\(expiration, chainNowSecs\)/);
  assert.doesNotMatch(EXPIRY, /Date\.now\(\)/);
  // An unanswered clock is refused as unverified, never guessed from ours.
  assert.match(EXPIRY, /"chain_clock_unverified" \}, 502\)/);
  // …and the route runs it before anything is charged or sent.
  const clock = RELAY.indexOf("await refuseUnlessExpiryInWindow(c, body.expiration)");
  assert.ok(clock > 0 && clock < RELAY.indexOf("releaseLimits.account.record"));
  assert.ok(clock < RELAY.indexOf("relayReleaseWithSignature("));
  assert.match(RELAY, /if \(expiryRefused\) return expiryRefused;/);
});

test("the chain clock is the latest block's timestamp", () => {
  const start = CHAIN.indexOf("export async function getSubEnsChainTime");
  assert.ok(start > 0, "getSubEnsChainTime not found");
  const body = CHAIN.slice(start, CHAIN.indexOf("\nexport ", start + 10));
  assert.match(body, /getBlock\("latest"\)/);
  assert.match(body, /\.timestamp/);
});

test("the bounds are the ones the client's TTL sits inside", () => {
  const min = Number(/RELAY_EXPIRY_MIN_SECS = (\d+)/.exec(ROUTE)?.[1]);
  const max = /RELAY_EXPIRY_MAX_SECS = ([^;]+);/.exec(ROUTE)?.[1] ?? "";
  assert.equal(min, 60);
  assert.match(max, /15 \* 60/);
  // The client asks for 10 minutes; it must be comfortably inside both bounds,
  // or every legitimate release is refused.
  const clientTtl = 10 * 60;
  assert.ok(clientTtl > min && clientTtl < 15 * 60);
});

test("ownership is checked before anything is spent", () => {
  // The read itself moved into `refuseUnlessOwner` (#488) so a failed read
  // answers 502 rather than the 404/403 that would accuse a real holder; what
  // this pins is unchanged — it still runs before any budget is charged.
  const ownerIdx = RELAY.indexOf("refuseUnlessOwner(c, label");
  const recordIdx = RELAY.indexOf("releaseLimits.account.record");
  const relayIdx = RELAY.indexOf("relayReleaseWithSignature(");
  assert.ok(ownerIdx > 0 && ownerIdx < recordIdx && ownerIdx < relayIdx);
});

test("the caller's own profile name is refused", () => {
  // An accident guard: releasing the name you are known by is a one-click route
  // to being nameless for the whole cooldown.
  assert.match(RELAY, /isProfileName\(parentAddress, label\)/);
  assert.match(RELAY, /"profile_name"/);
});

test("a release already in flight for the node is refused, not double-submitted", () => {
  assert.match(RELAY, /releasesInFlight\.has\(node\)/);
  assert.match(RELAY, /release_in_flight/);
  // …and released in a finally, or one failure wedges the label forever.
  assert.match(RELAY, /finally\s*\{[\s\S]*releasesInFlight\.delete\(node\)/);
});

test("both rate budgets are peeked before either is charged", () => {
  const peek = RELAY.indexOf("releaseLimits.global.peek");
  const record = RELAY.indexOf("releaseLimits.account.record");
  assert.ok(peek > 0 && peek < record, "a request refused globally must not be charged to the caller");
});

test("contract refusals are named, not 500s", () => {
  for (const name of [
    "Unauthorized",
    "SignatureExpired",
    "ReleaseUnregistered",
    "ReleaseBaseNode",
    "HasChildren",
    "ExpirationTooFar",
  ]) {
    assert.match(RELAY, new RegExp(`"${name}"`), `${name} must map to a specific status`);
  }
});

test("a name with names beneath it is its own code, which the client shows rather than routes round", () => {
  // The client's `unroutableReleaseRefusal` keys on exactly this string.
  assert.match(RELAY, /name === "HasChildren"\)\s*return c\.json\(\{ ok: false, error: "has_children" \}, 409\);/);
  assert.match(
    RELAY,
    /name === "ExpirationTooFar"\)\s*return c\.json\(\{ ok: false, error: "expiration_too_far" \}, 400\);/,
  );
});

test("ethers can name the v2.2 errors too, though no call here can raise them", () => {
  assert.match(CHAIN, /"error DelegationNotSupported\(\)"/);
  assert.match(CHAIN, /"error BatchNodeMismatch\(bytes32 node\)"/);
  assert.match(CHAIN, /"error NotDeployer\(address caller\)"/);
});

test("a registrar the registry no longer enrols is named at the mint and the pointer relay (registry v2.2)", () => {
  // The registry's `Unauthorized` bubbles through the registrar unchanged, so
  // its fragment must be in the REGISTRAR ABI for ethers to name it.
  const registrarAbi = CHAIN.slice(CHAIN.indexOf("const REGISTRAR_ABI"), CHAIN.indexOf("];", CHAIN.indexOf("const REGISTRAR_ABI")));
  assert.match(registrarAbi, /"error Unauthorized\(bytes32 node\)"/);
  const claim = ROUTE.slice(ROUTE.indexOf("mintSubEnsName("), ROUTE.indexOf('"claim failed"'));
  assert.match(claim, /name === "Unauthorized"\) \{[\s\S]*?503\)/);
  const write = ROUTE.slice(ROUTE.indexOf("relaySignedContenthash(label"), ROUTE.indexOf('"update failed"'));
  assert.match(write, /name === "Unauthorized"\) \{[\s\S]*?503\)/);
});

test("ethers can name the v2.1 refusals: their fragments are in the registry ABI", () => {
  // ethers v6 decodes a custom error by NAME only when its fragment is in the
  // ABI; without these the route's comparisons never match and every refusal
  // is a 500. The selectors are pinned on the contract side
  // (`L2RegistryV2.t.sol`, test_Abi_TheSelectorsTheAppEncodesByHandAreUnchanged).
  assert.match(CHAIN, /"error HasChildren\(bytes32 node, uint256 count\)"/);
  assert.match(CHAIN, /"error ExpirationTooFar\(\)"/);
});

test("the signature never reaches a log line", () => {
  // It is a bearer authorisation for a burn until it is mined or the record
  // version moves.
  //
  // Grepping for the token `signature` is NOT enough and this test used to do
  // exactly that, passing while the code leaked. ethers composes `err.message`
  // by appending every `info` key, so a CALL_EXCEPTION / INSUFFICIENT_FUNDS /
  // nonce error carries `transaction={"data":"0x…"}` — the full calldata, with
  // the holder's signature in it. So the ban is on the CARRIER, not the word.
  const body = RELAY.slice(0, RELAY.indexOf("\n});")) + LOG + EXPIRY;
  assert.match(RELAY, /logRelayFailure\("relay-release", label, err\)/, "failures go through the payload-free logger");
  const logs = [...body.matchAll(/console\.(log|warn|error)\(([\s\S]*?)\);/g)].map((m) => m[2]);
  assert.ok(logs.length > 0, "expected at least one log line to check");
  for (const line of logs) {
    assert.doesNotMatch(line, /signature/, `log line leaks the signature: ${line}`);
    assert.doesNotMatch(line, /\bbody\b/, `log line dumps the body: ${line}`);
    assert.doesNotMatch(
      line,
      /\.message\b/,
      `log line uses err.message, which ethers fills with the calldata: ${line}`,
    );
  }
});

test("shortMessage carries the diagnosis without the payload", async () => {
  // Pins the property the fix relies on, against the real ethers in use: the
  // short form must NOT contain the calldata that `message` does.
  const { makeError } = await import("ethers");
  const calldata = `0x${"ab".repeat(200)}`;
  const err = makeError("missing revert data", "CALL_EXCEPTION", {
    action: "sendTransaction",
    data: null,
    reason: null,
    transaction: { to: "0x" + "1".repeat(40), from: "0x" + "2".repeat(40), data: calldata },
    invocation: null,
    revert: null,
  }) as Error & { shortMessage?: string };
  assert.ok(err.message.includes(calldata), "precondition: ethers still embeds calldata in .message");
  assert.ok(!(err.shortMessage ?? "").includes(calldata), "shortMessage must not carry the calldata");
});

// ---------------------------------------------------------------------------
// The chain helper
// ---------------------------------------------------------------------------

test("the relay simulates before touching the shared sponsor queue", () => {
  const helper = relayHelper();
  const sim = helper.indexOf("staticCall");
  const queue = helper.indexOf("sendSponsorTx");
  assert.ok(sim > 0, "the release must be simulated first");
  assert.ok(sim < queue, "simulation must happen OUTSIDE the sponsor nonce queue");
});

test("the confirmation is awaited outside the sponsor queue", () => {
  const helper = relayHelper();
  // Holding the nonce lock across a block confirmation would serialise every
  // other sponsor transaction — including ticket fulfilment — behind it.
  const sendBlock = helper.slice(helper.indexOf("sendSponsorTx"), helper.indexOf("tx.wait"));
  assert.doesNotMatch(sendBlock, /wait\(/);
  assert.match(helper, /await tx\.wait\(1\)/);
});

test("the relayed release is sent with a padded limit, estimated inside the queue (audit 950 Low 15)", () => {
  const e = 1_000_000n;
  assert.equal(paddedRelayGasLimit(e), e + e / 5n + RELAY_GAS_FIXED_PAD);
  assert.ok(paddedRelayGasLimit(e) > e + 300_000n, "a fifth plus the fixed allowance");
  assert.ok(paddedRelayGasLimit(0n) >= RELAY_GAS_FIXED_PAD, "the fixed allowance applies to a small estimate too");

  const helper = relayHelper();
  const queue = helper.slice(helper.indexOf("sendSponsorTx"), helper.indexOf("tx.wait"));
  // The estimate is made INSIDE the queued send — immediately before signing —
  // and its padded value is what is sent.
  assert.match(queue, /releaseWithSignature\.estimateGas\(node, expiration, signer, signature\)/);
  assert.match(queue, /gasLimit: paddedRelayGasLimit\(estimate\)/);
  assert.match(queue, /\.\.\.o,/, "the nonce override must still reach the send");
});

test("the relay writes through a REGISTRY-bound contract, not the registrar helper", () => {
  const helper = relayHelper();
  // `writeContract` binds REGISTRAR_ABI; releaseWithSignature is on the registry.
  assert.doesNotMatch(helper, /writeContract\(/);
  assert.match(helper, /getRegistryAddress\(chainId\)/);
  assert.match(helper, /REGISTRY_ABI/);
});
