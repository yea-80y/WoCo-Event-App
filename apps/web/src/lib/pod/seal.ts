/**
 * Seal and sign a POD manifest — the step BOTH rails share.
 *
 * The ticket rail and the certificate rail disagree about exactly one thing:
 * how many bodies the Merkle root covers. On the ticket rail a body is an
 * EDITION, one per claimable slot, and the contract sells each one. On the
 * certificate rail a certificate names its holder, so there is one template
 * body and `totalSupply` is a declared CAP that no chain enforces.
 *
 * Everything downstream of that disagreement is identical — the leaf hashing,
 * the tree, the canonical CBOR encoding, the ed25519 signature and the digest —
 * so it lives here once. Sharing it is not tidiness: it is what guarantees the
 * two rails cannot drift into signing bytes that differ from the bytes a
 * verifier checks, which is the failure this whole POD layer is built to avoid.
 *
 * WHY THE DIVERGENCE IS AN ARGUMENT AND NOT A FLAG. `bodies` and `totalSupply`
 * are both REQUIRED and independent. A caller must therefore state, at the call
 * site, what its root covers and what its manifest declares — the two cannot be
 * confused by forgetting an optional. An optional `bodyCount` on a single
 * builder would be the shape slice 2 rejected in the type system, "an optional
 * nobody narrows": a ticket-rail caller who passed it would produce a manifest
 * whose root covers one body while the contract expects N claimable editions,
 * correct-looking and failing only at claim time, on the money path.
 *
 * This function deliberately does NOT check `bodies.length` against
 * `totalSupply`. The rails legitimately disagree, and a check here could only
 * be right for one of them; the real enforcement is server-side in
 * `issuePodType`, which knows which rail it is on.
 */

import { buildPodTree, signManifest, manifestDigest, bytesToHex0x } from "@woco/shared";
import type {
  PodV2Body,
  ManifestV1Body,
  SignedManifestV1,
  Bytes32Hex,
  IssuerPubkeyV1,
} from "@woco/shared";

export interface SealedManifest {
  signedManifest: SignedManifestV1;
  /** keccak256(dagCbor(manifestBody)) — the id every other thing keys on. */
  manifestDigestHex: string;
  /** Merkle root over the supplied bodies, as committed in the manifest. */
  metadataRoot: Bytes32Hex;
}

export interface SealManifestOpts {
  /**
   * The bodies the root commits to, in edition order. `buildPodTree` enforces
   * `edition === index + 1`, so this list is self-checking against off-by-ones
   * before anything is signed.
   */
  bodies: readonly PodV2Body[];
  /** Informational — see `ManifestV1Body.eventId`; joins nothing on either rail. */
  eventId: Bytes32Hex;
  /**
   * What the manifest DECLARES. Equal to `bodies.length` on the ticket rail;
   * the declared holder cap on the certificate rail.
   */
  totalSupply: number;
  /** ed25519 issuer pubkey, hex, no 0x. Must be `podPrivateKey`'s public half. */
  issuer: IssuerPubkeyV1;
  podPrivateKey: Uint8Array;
}

/** Build the Merkle root over `bodies`, assemble the manifest body, and sign it. */
export function sealManifest(opts: SealManifestOpts): SealedManifest {
  const { root } = buildPodTree(opts.bodies as PodV2Body[]);

  const manifestBody: ManifestV1Body = {
    format: "woco.manifest.v1",
    eventId: opts.eventId,
    totalSupply: opts.totalSupply,
    issuerPubkey: opts.issuer,
    metadataRoot: root,
    encoding: "cbor-v1",
    treeScheme: "oz-simple-v1",
  };

  return {
    signedManifest: signManifest(manifestBody, opts.podPrivateKey),
    manifestDigestHex: bytesToHex0x(manifestDigest(manifestBody)),
    metadataRoot: root,
  };
}
