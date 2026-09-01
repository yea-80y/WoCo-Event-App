import { issuingAddress } from "@woco/shared";
import type { EditionV1Body, SignedManifestV2 } from "@woco/shared";
import { sealManifest } from "./seal.js";

export interface SeriesManifestData {
  seriesId: string;
  editionBodies: EditionV1Body[];
  signedManifest: SignedManifestV2;
  /** keccak256(dagCbor(manifestBody)) == on-chain manifestRef */
  manifestDigestHex: string;
}

export interface BuildEventManifestsOpts {
  /** The derived secp256k1 issuing key (`ensureIssuingKey`). Signs every
   *  manifest; its address is the issuer identity in every body. */
  issuingPrivKey: Uint8Array;
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
   * Mint timestamp baked into every edition body. Defaults to now; injectable
   * so this builder is DETERMINISTIC under test, which is what lets its output
   * be pinned as a golden vector.
   *
   * Inert by construction — unlike a body-count knob, it changes no contract
   * between the manifest and the chain. It is the only non-input-derived value
   * in this function, so fixing it fixes the whole output.
   */
  mintedAt?: string;
}

/**
 * Build Merkle manifests for all series in one event — the TICKET rail's
 * builder, used by `PublishButton` for real, saleable events.
 *
 * The v1 builder's `predictOnChainEventId` is GONE with `eventId` itself
 * (#443): the value never matched the on-chain eventId — `registerEvent` keys
 * on the sponsor address and the sponsor's own nonce, neither available here —
 * and it had zero production readers. The chain join is `manifestDigestHex`,
 * which the contract stores as `manifestRef`.
 */
export function buildEventManifests(opts: BuildEventManifestsOpts): SeriesManifestData[] {
  const { issuingPrivKey, eventMeta, series } = opts;
  const issuer = issuingAddress(issuingPrivKey);
  const mintedAt = opts.mintedAt ?? new Date().toISOString();

  return series.map((s) => {
    // Build edition bodies (1-indexed editions)
    const editionBodies: EditionV1Body[] = Array.from({ length: s.totalSupply }, (_, idx) => ({
      format: "woco.edition.v1" as const,
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
      bodies: editionBodies,
      totalSupply: s.totalSupply,
      issuingPrivKey,
    });

    return { seriesId: s.seriesId, editionBodies, signedManifest, manifestDigestHex };
  });
}
