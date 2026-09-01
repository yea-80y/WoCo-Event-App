/**
 * v2 edition Merkle tree + inclusion verifier (PR 3). Topology is OZ's
 * SimpleMerkleTree, unchanged from v1 — what these tests add is the
 * closed-schema dispatch at the verifier boundary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveIssuingKey } from "../../src/crypto/issuing.js";
import { buildEditionTree, proveEdition, verifyEditionInclusion } from "../../src/edition/merkle.js";
import type { EditionV1Body } from "../../src/edition/types.js";

const { address: ISSUER } = deriveIssuingKey("0x" + "ab".repeat(32), 0);

function bodies(n: number): EditionV1Body[] {
  return Array.from({ length: n }, (_, i) => ({
    format: "woco.edition.v1" as const,
    seriesId: "series-tree",
    edition: i + 1,
    metadata: { name: `Edition ${i + 1}` },
    issuer: ISSUER,
  }));
}

test("build → prove → verify round-trips for every edition (incl. non-power-of-2)", () => {
  const list = bodies(5);
  const { tree, root } = buildEditionTree(list);
  for (const body of list) {
    const proof = proveEdition(tree, body);
    assert.ok(verifyEditionInclusion(body, proof, root), `edition ${body.edition} failed`);
  }
});

test("a single-leaf tree works (badge/collectible supply of 1)", () => {
  const list = bodies(1);
  const { tree, root } = buildEditionTree(list);
  assert.ok(verifyEditionInclusion(list[0]!, proveEdition(tree, list[0]!), root));
});

test("edition/index misalignment is refused before signing", () => {
  const list = bodies(3);
  list[1]!.edition = 3;
  assert.throws(() => buildEditionTree(list), /expected 2/);
  assert.throws(() => buildEditionTree([]), /empty/);
});

test("verification fails closed on tampered body, wrong proof, wrong root", () => {
  const list = bodies(4);
  const { tree, root } = buildEditionTree(list);
  const proof = proveEdition(tree, list[2]!);
  assert.ok(!verifyEditionInclusion({ ...list[2]!, metadata: { name: "swapped" } }, proof, root));
  assert.ok(!verifyEditionInclusion(list[1]!, proof, root), "edition mismatch accepted");
  assert.ok(!verifyEditionInclusion(list[2]!, proof, "0x" + "00".repeat(32)));
});

test("a v1 woco.ticket.v2 body is refused at dispatch, not hashed", () => {
  const list = bodies(2);
  const { tree, root } = buildEditionTree(list);
  const proof = proveEdition(tree, list[0]!);
  const v1Shaped = {
    format: "woco.ticket.v2",
    eventId: "0x" + "00".repeat(32),
    seriesId: "series-tree",
    edition: 1,
    metadata: { name: "Edition 1" },
    issuer: "aa".repeat(32),
  };
  assert.ok(
    !verifyEditionInclusion(v1Shaped, proof, root),
    "a v1 ticket body passed the v2 inclusion verifier — the dispatch refusal is gone",
  );
});

test("scale: a 1000-edition tree builds and spot-checked editions verify", () => {
  // Carried over from the deleted v1 suite: real events sell at this scale,
  // and tree-shape bugs (unbalanced non-power-of-2 handling) only appear
  // above toy sizes.
  const list = bodies(1000);
  const { tree, root } = buildEditionTree(list);
  for (const edition of [1, 2, 499, 500, 501, 999, 1000]) {
    const body = list[edition - 1]!;
    assert.ok(verifyEditionInclusion(body, proveEdition(tree, body), root), `edition ${edition}`);
  }
});
