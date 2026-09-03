/**
 * The release relay — the one path in sub-ENS where the platform spends the
 * sponsor key on an IRREVERSIBLE action.
 *
 * The security boundary is on-chain: `releaseWithSignature` checks that
 * `signer` is the holder or an ERC-721 approvee BEFORE it looks at the
 * signature, so the sponsor can only relay what a holder authorised and can
 * never forge one. What the ROUTE owes is therefore not authorisation — it is
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
import { labelNode } from "../src/lib/chain/sub-ens-contract.js";

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

test("expiration is bounded at BOTH ends", () => {
  assert.match(RELAY, /ttl < RELEASE_EXPIRY_MIN_SECS \|\| ttl > RELEASE_EXPIRY_MAX_SECS/);
  assert.match(RELAY, /expiration_out_of_range/);
  // A non-integer must not slip through as NaN and compare false on both sides.
  assert.match(RELAY, /Number\.isInteger\(expiration\)/);
});

test("the bounds are the ones the client's TTL sits inside", () => {
  const min = Number(/RELEASE_EXPIRY_MIN_SECS = (\d+)/.exec(ROUTE)?.[1]);
  const max = /RELEASE_EXPIRY_MAX_SECS = ([^;]+);/.exec(ROUTE)?.[1] ?? "";
  assert.equal(min, 60);
  assert.match(max, /15 \* 60/);
  // The client asks for 10 minutes; it must be comfortably inside both bounds,
  // or every legitimate release is refused.
  const clientTtl = 10 * 60;
  assert.ok(clientTtl > min && clientTtl < 15 * 60);
});

test("ownership is checked before anything is spent", () => {
  const ownerIdx = RELAY.indexOf("getLabelOwner(label)");
  const recordIdx = RELAY.indexOf("releaseLimiter.record");
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
  const peek = RELAY.indexOf("releaseGlobalLimiter.peek");
  const record = RELAY.indexOf("releaseLimiter.record");
  assert.ok(peek > 0 && peek < record, "a request refused globally must not be charged to the caller");
});

test("contract refusals are named, not 500s", () => {
  for (const name of ["Unauthorized", "SignatureExpired", "ReleaseUnregistered", "ReleaseBaseNode"]) {
    assert.match(RELAY, new RegExp(`"${name}"`), `${name} must map to a specific status`);
  }
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
  const body = RELAY.slice(0, RELAY.indexOf("\n});"));
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

test("the relay writes through a REGISTRY-bound contract, not the registrar helper", () => {
  const helper = relayHelper();
  // `writeContract` binds REGISTRAR_ABI; releaseWithSignature is on the registry.
  assert.doesNotMatch(helper, /writeContract\(/);
  assert.match(helper, /getRegistryAddress\(chainId\)/);
  assert.match(helper, /REGISTRY_ABI/);
});
