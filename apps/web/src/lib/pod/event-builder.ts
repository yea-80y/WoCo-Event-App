import { keccak256, AbiCoder } from "ethers";
import { buildPodTree, signManifest, manifestDigest, bytesToHex0x } from "@woco/shared";
import type { PodV2Body, ManifestV1Body, SignedManifestV1 } from "@woco/shared";

export interface SeriesManifestData {
  seriesId: string;
  podBodies: PodV2Body[];
  signedManifest: SignedManifestV1;
  /**
   * `keccak256(abi.encode(organiserAddress, nonce+i))` — INFORMATIONAL, despite
   * the name. It does not match the on-chain eventId: the contract derives that
   * from the SPONSOR address and the sponsor's own `organiserNonce`, while both
   * call sites here pass the organiser address with nonce hardcoded to 0.
   * The authoritative id is the one `registerEvent` emits; the chain join is
   * `manifestDigestHex`.
   */
  predictedOnChainEventId: string;
  /** keccak256(dagCbor(manifestBody)) == on-chain manifestRef */
  manifestDigestHex: string;
}

export interface BuildEventManifestsOpts {
  organiserAddress: string;
  /** Current organiserNonce from chain (for predicting eventId per series) */
  organiserNonce: bigint;
  creatorPodPrivateKey: Uint8Array;
  /** ed25519 public key hex, no 0x prefix */
  creatorPodPublicKeyHex: string;
  eventMeta: {
    startDate?: string;
    endDate?: string;
    location?: string;
    imageHash?: string;
  };
  series: Array<{
    seriesId: string;
    name: string;
    description: string;
    totalSupply: number;
  }>;
}

const _abiCoder = AbiCoder.defaultAbiCoder();

/**
 * Derive the informational eventId baked into manifests and pod bodies.
 *
 * NOT a prediction of the on-chain eventId — `registerEvent` keys on the sponsor
 * address and the sponsor's nonce, neither of which is available here. Kept
 * because the value is committed inside signed manifests already in the wild.
 */
export function predictOnChainEventId(organiserAddress: string, nonce: bigint): string {
  return keccak256(_abiCoder.encode(["address", "uint256"], [organiserAddress, nonce]));
}

/**
 * Build Merkle manifests for all series in one event.
 * One call per series consumes one nonce slot (nonce, nonce+1, ...).
 * Call this AFTER fetching the organiser nonce from the server.
 */
export function buildEventManifests(opts: BuildEventManifestsOpts): SeriesManifestData[] {
  const {
    organiserAddress,
    organiserNonce,
    creatorPodPrivateKey,
    creatorPodPublicKeyHex,
    eventMeta,
    series,
  } = opts;

  // ed25519 pubkey without 0x prefix (convention in pod types)
  const issuer = creatorPodPublicKeyHex.startsWith("0x")
    ? creatorPodPublicKeyHex.slice(2)
    : creatorPodPublicKeyHex;

  const mintedAt = new Date().toISOString();

  return series.map((s, i) => {
    const nonce = organiserNonce + BigInt(i);
    const predictedOnChainEventId = predictOnChainEventId(organiserAddress, nonce);

    // Build pod bodies (1-indexed editions)
    const podBodies: PodV2Body[] = Array.from({ length: s.totalSupply }, (_, idx) => ({
      format: "woco.ticket.v2" as const,
      eventId: predictedOnChainEventId,
      seriesId: s.seriesId,
      edition: idx + 1,
      metadata: {
        name: s.name,
        description: s.description,
        ...(eventMeta.imageHash ? { image: eventMeta.imageHash } : {}),
        ...(eventMeta.startDate ? { startDate: eventMeta.startDate } : {}),
        ...(eventMeta.endDate ? { endDate: eventMeta.endDate } : {}),
        ...(eventMeta.location ? { location: eventMeta.location } : {}),
        mintedAt,
      },
      issuer,
    }));

    // Build Merkle tree
    const { root } = buildPodTree(podBodies);

    // Build and sign manifest
    const manifestBody: ManifestV1Body = {
      format: "woco.manifest.v1",
      eventId: predictedOnChainEventId,
      totalSupply: s.totalSupply,
      issuerPubkey: issuer,
      metadataRoot: root,
      encoding: "cbor-v1",
      treeScheme: "oz-simple-v1",
    };
    const signedManifest = signManifest(manifestBody, creatorPodPrivateKey);
    const manifestDigestHex = bytesToHex0x(manifestDigest(manifestBody));

    return { seriesId: s.seriesId, podBodies, signedManifest, predictedOnChainEventId, manifestDigestHex };
  });
}
