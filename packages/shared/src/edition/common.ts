/**
 * A series' edition bodies differ only in their number, so the create request may
 * carry one body without it (`EditionCommon`) and the server rebuilds the list. The
 * Merkle root check that follows (`validateSeriesManifest`) is unchanged: whatever
 * the wire shape, the server hashes exactly the bodies the manifest commits to.
 */

import type { EditionV1Body } from "./types.js";
import { validateEditionV1Body } from "./types.js";
import { hasExactKeys, isIntIn, isPlainRecord } from "../validate.js";

export type EditionCommon = Omit<EditionV1Body, "edition">;

/** Largest series the server rebuilds; the ledger's supply is a uint64, the seat ceiling 200,000. */
export const MAX_EDITIONS_FROM_COMMON = 1_000_000;

/** `common` with this edition number, in the body's key order. */
export function editionBody(common: EditionCommon, edition: number): EditionV1Body {
  return { format: common.format, seriesId: common.seriesId, edition, metadata: common.metadata, issuer: common.issuer };
}

/**
 * Editions 1..count from a common body, or null when `common` is not exactly an
 * edition body without its number, or `count` is out of range. Bodies share one
 * `metadata` record: they are hashed, never mutated.
 */
export function editionBodiesFromCommon(common: unknown, count: number): EditionV1Body[] | null {
  if (!isIntIn(count, 1, MAX_EDITIONS_FROM_COMMON)) return null;
  if (!isPlainRecord(common) || !hasExactKeys(common, ["format", "seriesId", "metadata", "issuer"])) return null;
  const c = common as unknown as EditionCommon;
  if (!validateEditionV1Body(editionBody(c, 1))) return null;
  return Array.from({ length: count }, (_, i) => editionBody(c, i + 1));
}
