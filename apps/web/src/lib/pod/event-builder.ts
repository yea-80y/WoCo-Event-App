import { keccak256, AbiCoder } from "ethers";
import { asIssuerPubkeyV1 } from "@woco/shared";
import type { PodV2Body, SignedManifestV1 } from "@woco/shared";
import { sealManifest } from "./seal.js";

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
  /**
   * Mint timestamp baked into every pod body. Defaults to now; injectable so
   * this builder is DETERMINISTIC under test, which is what lets its output be
   * pinned as a golden vector.
   *
   * Inert by construction — unlike a body-count knob, it changes no contract
   * between the manifest and the chain. It is the only non-input-derived value
   * in this function, so fixing it fixes the whole output.
   */
  mintedAt?: string;
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
  const issuer = asIssuerPubkeyV1(
    creatorPodPublicKeyHex.startsWith("0x") ? creatorPodPublicKeyHex.slice(2) : creatorPodPublicKeyHex,
  );

  const mintedAt = opts.mintedAt ?? new Date().toISOString();

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

    // Seal + sign through the shared core. `totalSupply` is passed as the body
    // count here because on THIS rail every declared unit is a claimable
    // edition the contract sells — the certificate rail passes a cap instead,
    // and stating it explicitly at each call site is what keeps the two from
    // being confused for one another.
    const { signedManifest, manifestDigestHex } = sealManifest({
      bodies: podBodies,
      eventId: predictedOnChainEventId,
      totalSupply: s.totalSupply,
      issuer,
      podPrivateKey: creatorPodPrivateKey,
    });

    return { seriesId: s.seriesId, podBodies, signedManifest, predictedOnChainEventId, manifestDigestHex };
  });
}
