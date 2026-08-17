/**
 * Writing a versioned content feed from the SERVER, for a feed the server owns.
 *
 * The client-side twin (`apps/web/src/lib/swarm/content-feed.ts`) exists because
 * users sign their own feeds; this exists because the indexer signs its own
 * reports (#312), and there is no user in that loop to ask.
 *
 * WHY A VERSION PROBE BEFORE EVERY WRITE. A SOC is immutable: re-uploading at
 * the same (owner, identifier) with new bytes is silently discarded by Bee —
 * 201, old payload kept. So an update is a write at the NEXT identifier, and
 * getting the version wrong does not fail, it disappears.
 *
 * WHICH MEANS THE READ IS PART OF THE WRITE, and a lenient read is a corrupted
 * feed. `readContentFeedJsonResult` distinguishes "no feed here" from "could not
 * tell", and only the first is a licence to write version 0 — treating a
 * transient error as absence republishes the feed from scratch, discarding
 * every version before it. This module therefore refuses on `unavailable`, and
 * the caller retries later.
 */

import type { PrivateKey } from "@ethersphere/bee-js";
import {
  CONTENT_FEED_MC_MARKER,
  LEGACY_CONTENT_FEED_VERSION,
  SOC_MAX_PAYLOAD_SIZE,
  calculateCacAddress,
  contentFeedSocIdentifier,
  encodeSpan,
  versionedPageIdentifier,
  versionedSocIdentifier,
  type ContentFeedManifest,
} from "@woco/shared";
import { invalidateContentFeedVersion, readContentFeedJsonResult, uploadSignedSoc } from "./soc-upload.js";

export type ContentFeedWrite =
  | { ok: true; version: number; unchanged: boolean }
  | { ok: false; reason: string };

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function signAndUpload(signer: PrivateKey, identifier: Uint8Array, payload: Uint8Array, batchId: string): Promise<void> {
  const span = encodeSpan(payload.length);
  const cacAddress = calculateCacAddress(span, payload);
  // The SOC digest is the plain concatenation, not a hash of it — bee-js signs
  // what it is handed. `soc-upload.ts` recovers against exactly these bytes.
  const sig = signer.sign(new Uint8Array([...identifier, ...cacAddress])) as unknown as { toUint8Array(): Uint8Array };
  await uploadSignedSoc({
    owner: signer.publicKey().address().toHex().replace(/^0x/, ""),
    identifier: toHex(identifier),
    signature: toHex(sig.toUint8Array()),
    span: toHex(span),
    payload: toHex(payload),
  }, { target: "wocoBee", batchId });
}

/**
 * Publish `bytes` as the next version of a feed this server's `signer` owns.
 *
 * `unchanged` is asked, not assumed: the caller is handed the current head and
 * decides whether the new bytes say anything new. It is a predicate rather than
 * a byte comparison because a payload can carry fields that differ on every
 * pass without the content differing — a publication timestamp being the
 * obvious one — and republishing those costs postage now and costs every future
 * reader a probe step forever.
 *
 * Pages are uploaded BEFORE the manifest that names them, so a reader never
 * meets a manifest whose pages do not exist yet. Page identifiers fold in the
 * version, so a reader of version n cannot tear across n+1's pages.
 */
export async function writeVersionedContentFeed(args: {
  signer: PrivateKey;
  topic: string;
  bytes: Uint8Array;
  batchId: string;
  unchanged?: (headBytes: Uint8Array) => boolean;
}): Promise<ContentFeedWrite> {
  if (args.bytes.length < 1) return { ok: false, reason: "payload must be at least one byte" };

  const owner = args.signer.publicKey().address().toHex().replace(/^0x/, "").toLowerCase();
  const head = await readContentFeedJsonResult(owner, args.topic);
  if (head.status === "unavailable") {
    return { ok: false, reason: `version probe inconclusive: ${head.reason ?? "unavailable"}` };
  }
  if (head.status === "found" && (args.unchanged?.(head.bytes) ?? sameBytes(head.bytes, args.bytes))) {
    return { ok: true, version: head.version, unchanged: true };
  }

  const version = head.status === "found" ? head.version + 1 : (LEGACY_CONTENT_FEED_VERSION + 1);
  const base = contentFeedSocIdentifier(args.topic);

  if (args.bytes.length <= SOC_MAX_PAYLOAD_SIZE) {
    await signAndUpload(args.signer, versionedSocIdentifier(base, version), args.bytes, args.batchId);
  } else {
    const pages = Math.ceil(args.bytes.length / SOC_MAX_PAYLOAD_SIZE);
    for (let i = 0; i < pages; i++) {
      // Sequential, unlike the browser writer: this runs on a shared server
      // behind one upload semaphore, and a report can be many pages. Filling the
      // queue with one subject's pages would stall the user writes the tally
      // exists to count.
      const slice = args.bytes.subarray(i * SOC_MAX_PAYLOAD_SIZE, (i + 1) * SOC_MAX_PAYLOAD_SIZE);
      await signAndUpload(args.signer, versionedPageIdentifier(base, version, i + 1), slice, args.batchId);
    }
    const manifest: ContentFeedManifest = { [CONTENT_FEED_MC_MARKER]: 1, pages, len: args.bytes.length };
    const encoded = new TextEncoder().encode(JSON.stringify(manifest));
    await signAndUpload(args.signer, versionedSocIdentifier(base, version), encoded, args.batchId);
  }

  // The in-process version cache still holds the PREVIOUS head; without this the
  // next write would compute the same version again and be silently discarded.
  invalidateContentFeedVersion(owner, args.topic);
  return { ok: true, version, unchanged: false };
}

/**
 * Read back what was just written, and say whether it is really there.
 *
 * Not belt-and-braces. A bee that has fallen behind the postage contract stamps
 * against an expired batch and returns 201 for chunks that are never paid for
 * (2026-08-10), so upload success is not evidence of a stored chunk. This is the
 * cheap check that turns a silent void into a visible failure.
 */
export async function confirmContentFeedWrite(
  ownerHex: string,
  topic: string,
  expected: Uint8Array,
  expectedVersion: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const res = await readContentFeedJsonResult(ownerHex, topic);
  if (res.status !== "found") return { ok: false, reason: `read-back ${res.status}` };
  if (res.version !== expectedVersion) return { ok: false, reason: `read-back version ${res.version} != ${expectedVersion}` };
  if (!sameBytes(res.bytes, expected)) return { ok: false, reason: "read-back bytes differ" };
  return { ok: true };
}
