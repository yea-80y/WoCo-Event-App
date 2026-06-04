// ---------------------------------------------------------------------------
// Standalone POD issuance (Step 4, item A) — mint a `badge`/`collectible` POD
// *type* that is NOT wrapped in an event.
//
// It is the ticket-creation pipeline (createEventV2 + register-on-chain) minus
// the event/series feed: validate the client-signed manifest, upload the pod
// bodies + SeriesManifestBlob to Swarm, sponsor-register the manifest on-chain
// (so the POD gets an on-chain eventId + slot space → holdable + gateable), and
// upsert the creator's POD directory entry.
//
// The manifest is signed CLIENT-side by the creator's ed25519 POD key (same as
// events); this server path never holds that key. The on-chain `eventId` is
// keccak256(sponsor, sponsorNonce) — informational `eventId` baked into the pod
// bodies never matches it (true for events too), so the AUTHORITATIVE eventId is
// the one emitted by registerEvent and stored on the directory entry; that is
// what the holdings reader keys on.
// ---------------------------------------------------------------------------

import type {
  Hex0x, Hex64, PodDirectoryEntry, SignedManifestV1, PodV2Body, SeriesManifestBlob,
} from "@woco/shared";
import { verifySignedManifest, buildPodTree, manifestDigest, bytesToHex0x } from "@woco/shared";
import { uploadToBytes } from "../swarm/bytes.js";
import { whitelistHashes } from "../swarm/whitelist.js";
import { upsertCreatorPod } from "./directory.js";
import { registerEventOnChain } from "../chain/sponsor-wallet.js";
import { getActiveChainId, getEventContractVersion } from "../chain/event-contract.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const BATCH = 40;
/** Manifest never expires for a standalone POD — far-future so the V2 contract's
 *  `eventEndTs > block.timestamp` guard passes and the (price-0, dormant) escrow
 *  release window never matters. */
const NEVER_EXPIRES_TS = Math.floor(Date.now() / 1000) + 100 * 365 * 24 * 3600;

/** Kinds a creator can mint directly. `ticket` flows through event creation;
 *  `authenticity` (transferable / ERC-721) is a deliberately unbuilt stage. */
export type IssuablePodKind = "badge" | "collectible";

export interface IssuePodOpts {
  /** Verified parentAddress (owner) — stamped by the route, never from the body. */
  creatorAddress: Hex0x;
  kind: IssuablePodKind;
  name: string;
  description?: string;
  /** References a `PodCategory.id` in the creator's directory. */
  categoryId?: string;
  supply: number;
  /** Client-built, ed25519-signed by the creator's POD key. */
  signedManifest: SignedManifestV1;
  /** The supply pre-signed pod bodies committed to by the manifest's Merkle root. */
  podBodies: PodV2Body[];
  /** Display artwork — a Swarm ref already uploaded by the client (no 0x). */
  image?: Hex64;
}

/**
 * Mint a standalone POD type. Throws on any failure BEFORE the directory write
 * so a half-created POD never appears in the manager; once on-chain
 * registration succeeds the directory upsert is awaited (it is the primary
 * write here, not the fire-and-forget it is for tickets).
 */
export async function issuePodType(opts: IssuePodOpts): Promise<PodDirectoryEntry> {
  const { creatorAddress, kind, name, description, categoryId, supply, signedManifest, podBodies, image } = opts;

  // ── Holdings/gating is a WoCoEventV2 feature — refuse to mint a POD on a
  //    chain where it could never be read on-chain. ─────────────────────────
  const chainId = getActiveChainId();
  if (getEventContractVersion(chainId) !== "v2") {
    throw new Error(`POD issuance requires WoCoEventV2; active chain ${chainId} is not V2`);
  }

  // ── Validate the client-signed manifest against the pod bodies (same checks
  //    createEventV2 runs before touching Swarm). ────────────────────────────
  if (podBodies.length !== supply) {
    throw new Error(`Expected ${supply} pod bodies, got ${podBodies.length}`);
  }
  if (!verifySignedManifest(signedManifest)) {
    throw new Error("Manifest signature invalid");
  }
  const { root } = buildPodTree(podBodies);
  if (root.toLowerCase() !== signedManifest.body.metadataRoot.toLowerCase()) {
    throw new Error("Merkle root mismatch — pod bodies don't match manifest");
  }
  if (signedManifest.body.totalSupply !== supply) {
    throw new Error("Manifest totalSupply does not match supply");
  }

  // ── Whitelist artwork so PodCard can render it via the gateway proxy (the
  //    upload-image route doesn't whitelist, so issuance is the authority).
  //    Fire-and-forget, non-fatal. ───────────────────────────────────────────
  if (image) {
    void whitelistHashes([image]).catch((err) =>
      console.warn("[pod] image whitelist failed (non-critical):", err),
    );
  }

  // ── Upload pod bodies + the SeriesManifestBlob to Swarm. ──────────────────
  const podRefs: Hex64[] = [];
  for (let i = 0; i < podBodies.length; i += BATCH) {
    const batch = podBodies.slice(i, i + BATCH);
    const batchRefs = await Promise.all(batch.map((p) => uploadToBytes(JSON.stringify(p))));
    podRefs.push(...batchRefs);
  }

  const manifestRef = bytesToHex0x(manifestDigest(signedManifest.body)); // 0x-prefixed bytes32
  const blob: SeriesManifestBlob = { v: 2, signedManifest, podRefs, manifestDigestHex: manifestRef };
  const swarmManifestRef = await uploadToBytes(JSON.stringify(blob));

  // ── Sponsor-register on-chain. Price 0 (escrow dormant), open FIFO gate,
  //    creator is the (irrelevant, price-0) payout recipient. ────────────────
  const { onChainEventId, txHash } = await registerEventOnChain(supply, manifestRef, {
    priceBaseUnits: 0n,
    payoutRecipient: creatorAddress,
    dropGate: ZERO_ADDRESS,
    eventEndTs: NEVER_EXPIRES_TS,
  });
  console.log(`[pod] minted ${kind} "${name}" supply=${supply} eventId=${onChainEventId} tx=${txHash}`);

  // ── Directory upsert (awaited — this is the primary durable write). ───────
  const now = new Date().toISOString();
  const entry: PodDirectoryEntry = {
    manifestRef,
    kind,
    name,
    ...(image ? { image } : {}),
    ...(description ? { description } : {}),
    ...(categoryId ? { categoryId } : {}),
    supply,
    issuedCount: 0,
    issuer: signedManifest.body.issuerPubkey,
    eventId: onChainEventId,
    swarmManifestRef,
    createdAt: now,
    updatedAt: now,
  };
  await upsertCreatorPod(creatorAddress, entry);
  return entry;
}
