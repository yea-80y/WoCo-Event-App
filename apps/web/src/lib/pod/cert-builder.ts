/**
 * Build the signed manifest for a CERTIFICATE badge (Gate B, slice 4).
 * Design record: docs/SWARM_SOCIAL_PLAN.md, BUILD RECORD slices 3 and 4.
 *
 * A SIBLING OF `event-builder.ts`, NEVER A FLAG ON IT. The two rails disagree
 * about what a pod body IS: on the chain rail a body is an EDITION, one per
 * claimable slot, and `metadataRoot` commits to all of them. On this rail a
 * certificate names its holder, so no edition is ever claimed and pre-signing
 * one body per unit of supply would cost N signatures and N uploads to commit
 * to bytes no reader reads. `issuePodType` enforces the difference: exactly one
 * body for a certificate badge, exactly `supply` for a chain badge.
 *
 * WHAT IS SHARED, AND WHAT IS NOT. The seal-and-sign core — leaf hashing, the
 * Merkle tree, canonical CBOR, the ed25519 signature and the digest — is ONE
 * implementation in `seal.ts` that both rails call, and sharing it is what
 * guarantees they cannot drift into signing bytes that differ from the bytes a
 * verifier checks. What is NOT shared is body construction, because that is the
 * single thing the rails genuinely disagree about, and `sealManifest` takes the
 * disagreement as two required arguments rather than an optional flag: a
 * ticket-rail caller who could pass a `bodyCount` would produce a manifest whose
 * root covers one body while the contract expects N claimable editions —
 * correct-looking, and failing only at claim time on the money path.
 *
 * `event-builder.ts`'s golden vector (apps/web/test/pod-manifest-golden.test.ts)
 * pins the ticket rail's signed bytes across that shared core precisely so this
 * arrangement stays provable rather than merely intended.
 */

import type { PodV2Body, SignedManifestV1 } from "@woco/shared";
import { predictOnChainEventId } from "./event-builder.js";
import { sealManifest } from "./seal.js";

export interface CertBadgeManifest {
  /** The single template body the manifest's root commits to. */
  podBodies: PodV2Body[];
  signedManifest: SignedManifestV1;
  /** keccak256(dagCbor(manifestBody)) — the badge id everything keys on. */
  manifestDigestHex: string;
}

export interface BuildCertBadgeManifestOpts {
  organiserAddress: string;
  creatorPodPrivateKey: Uint8Array;
  /** ed25519 public key hex, with or without 0x. */
  creatorPodPublicKeyHex: string;
  name: string;
  description: string;
  /** Display artwork Swarm ref (no 0x), if any. */
  imageHash?: string;
  /**
   * The DECLARED CAP — distinct holders this badge may ever name. Committed as
   * the manifest's `totalSupply` and enforced by the issuing client alone; the
   * server never sees an issuance, and a door verifying offline must not
   * pretend otherwise. Over-issuance is provable from the issuer's own signed
   * log, because the excess certificates carry the issuer's signature.
   */
  cap: number;
  /**
   * Per-mint uniqueness. Defaults to a random UUID and should normally be left
   * alone; injectable so the arithmetic can be tested against a fixed value.
   *
   * LOAD-BEARING, not decoration. `manifestRef` is `keccak256(dagCbor(body))`
   * and is the identity every other thing keys on — the directory entry, the
   * gate, and the log topic. Without a per-mint nonce inside the committed
   * body, two badges minted with the same name, description, artwork and cap
   * hash to the SAME manifestRef and are therefore ONE badge sharing ONE
   * certificate log. The chain rail gets this property for free from the random
   * `seriesId` its caller already generates; this rail must keep it deliberately.
   */
  seriesId?: string;
  /**
   * Mint timestamp baked into the template body. Defaults to now; injectable so
   * the builder is DETERMINISTIC under test.
   *
   * Note that this varies per call too, and therefore also perturbs the digest —
   * but it must not be mistaken for the uniqueness mechanism. Two mints inside
   * the same millisecond would collide on it, and identity that holds only
   * because a clock ticked is the kind of accidental uniqueness that works until
   * the day it does not. {@link BuildCertBadgeManifestOpts.seriesId} is the
   * deliberate one.
   */
  mintedAt?: string;
}

/**
 * Build and ed25519-sign a certificate badge's manifest over a single-leaf tree.
 *
 * `edition: 1` on a rail with no editions is honest rather than a placeholder:
 * the field indexes the committed LEAF, and this tree genuinely has one leaf.
 * The manifest layer carries no kind field, and the template body is display
 * bytes no door ever reads — the door reads certificates, which name their
 * holder and are verified against `issuerPubkey`.
 */
export function buildCertBadgeManifest(opts: BuildCertBadgeManifestOpts): CertBadgeManifest {
  const issuer = opts.creatorPodPublicKeyHex.startsWith("0x")
    ? opts.creatorPodPublicKeyHex.slice(2)
    : opts.creatorPodPublicKeyHex;

  if (!Number.isInteger(opts.cap) || opts.cap < 1) {
    throw new Error(`a certificate badge needs an integer cap of at least 1, got ${opts.cap}`);
  }

  const seriesId = opts.seriesId ?? crypto.randomUUID();
  // Informational, and identical in construction to the chain rail's so the two
  // manifests stay structurally indistinguishable to a reader. Nonce 0 matches
  // both existing call sites; the value joins nothing on this rail, which has
  // no chain registration at all.
  const eventId = predictOnChainEventId(opts.organiserAddress, 0n);

  const templateBody: PodV2Body = {
    format: "woco.ticket.v2",
    eventId,
    seriesId,
    edition: 1,
    metadata: {
      name: opts.name,
      description: opts.description,
      ...(opts.imageHash ? { image: opts.imageHash } : {}),
      mintedAt: opts.mintedAt ?? new Date().toISOString(),
    },
    issuer,
  };

  const podBodies = [templateBody];

  // Seal + sign through the SAME core the ticket rail uses. The divergence is
  // visible right here and nowhere else: one body, but `totalSupply` is the
  // cap. `issuePodType` re-checks that the declared supply equals the supply it
  // was asked for, so a builder that quietly wrote `1` here would be refused
  // rather than minting a badge capped at a single holder.
  const { signedManifest, manifestDigestHex } = sealManifest({
    bodies: podBodies,
    eventId,
    totalSupply: opts.cap,
    issuer,
    podPrivateKey: opts.creatorPodPrivateKey,
  });

  return { podBodies, signedManifest, manifestDigestHex };
}
