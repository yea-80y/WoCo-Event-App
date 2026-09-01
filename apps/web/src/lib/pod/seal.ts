/**
 * Seal and sign a `woco.manifest.v2` — the step BOTH rails share
 * (issuer-curve migration PR 4; design record: HANDOVER-pod-curve-migration.md).
 *
 * The ticket rail and the certificate rail disagree about exactly one thing:
 * how many bodies the Merkle root covers. On the ticket rail a body is an
 * EDITION, one per claimable slot, and the contract sells each one. On the
 * certificate rail a certificate names its holder, so there is one template
 * body and `totalSupply` is a declared CAP that no chain enforces.
 *
 * Everything downstream of that disagreement is identical — the leaf hashing,
 * the tree, the canonical CBOR encoding, the issuing-key signature and the
 * digest — so it lives here once. Sharing it is not tidiness: it is what
 * guarantees the two rails cannot drift into signing bytes that differ from
 * the bytes a verifier checks, which is the failure this whole layer is built
 * to avoid.
 *
 * WHY THE DIVERGENCE IS AN ARGUMENT AND NOT A FLAG. `bodies` and `totalSupply`
 * are both REQUIRED and independent. A caller must therefore state, at the call
 * site, what its root covers and what its manifest declares — the two cannot be
 * confused by forgetting an optional. An optional `bodyCount` on a single
 * builder would be "an optional nobody narrows": a ticket-rail caller who
 * passed it would produce a manifest whose root covers one body while the
 * contract expects N claimable editions, correct-looking and failing only at
 * claim time, on the money path.
 *
 * This function deliberately does NOT check `bodies.length` against
 * `totalSupply`. The rails legitimately disagree, and a check here could only
 * be right for one of them; the real enforcement is server-side in
 * `issuePodType`, which knows which rail it is on.
 *
 * WHAT THE CURVE MIGRATION CHANGED HERE, and only this: the signer is the
 * derived secp256k1 ISSUING key (`ensureIssuingKey`), the issuer identity is
 * its 20-byte ADDRESS, and there is no `eventId` in any body (#443 — it never
 * matched the on-chain eventId and had zero readers). The issuer address is
 * DERIVED from the private key right here, so no call site can ever pass a
 * mismatched pair — `signManifestV2`'s own refusal is tautological below it.
 */

import {
  buildEditionTree,
  bytesToHex0x,
  issuingAddress,
  manifestV2Digest,
  signManifestV2,
} from "@woco/shared";
import type {
  Bytes32Hex,
  EditionV1Body,
  ManifestV2Body,
  SignedManifestV2,
} from "@woco/shared";

export interface SealedManifest {
  signedManifest: SignedManifestV2;
  /** keccak256(dagCbor(manifestBody)) — the id every other thing keys on. */
  manifestDigestHex: string;
  /** Merkle root over the supplied bodies, as committed in the manifest. */
  metadataRoot: Bytes32Hex;
}

export interface SealManifestOpts {
  /**
   * The bodies the root commits to, in edition order. `buildEditionTree`
   * enforces `edition === index + 1`, so this list is self-checking against
   * off-by-ones before anything is signed.
   */
  bodies: readonly EditionV1Body[];
  /**
   * What the manifest DECLARES. Equal to `bodies.length` on the ticket rail;
   * the declared holder cap on the certificate rail.
   */
  totalSupply: number;
  /** The derived secp256k1 issuing key (`ensureIssuingKey`). Its address is
   *  the manifest's `issuer` — computed here, never passed. */
  issuingPrivKey: Uint8Array;
}

/** Build the Merkle root over `bodies`, assemble the manifest body, and sign it. */
export function sealManifest(opts: SealManifestOpts): SealedManifest {
  const { root } = buildEditionTree(opts.bodies as EditionV1Body[]);

  const manifestBody: ManifestV2Body = {
    format: "woco.manifest.v2",
    totalSupply: opts.totalSupply,
    issuer: issuingAddress(opts.issuingPrivKey),
    metadataRoot: root,
    encoding: "cbor-v1",
    treeScheme: "oz-simple-v1",
  };

  return {
    signedManifest: signManifestV2(manifestBody, opts.issuingPrivKey),
    manifestDigestHex: bytesToHex0x(manifestV2Digest(manifestBody)),
    metadataRoot: root,
  };
}
