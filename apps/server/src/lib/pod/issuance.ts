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
  /**
   * How holdings of this badge will be RECORDED, which decides whether it needs
   * a chain at all (docs/SWARM_SOCIAL_PLAN.md, Gate B).
   *
   * `chain` (default) is today's rail: sponsor-register the manifest so slot
   * ownership becomes readable, and pre-sign one pod body per edition.
   * `pod-cert` records holding as an issuer-signed certificate naming the
   * holder's key, so there are no slots to allocate, no editions to claim, and
   * nothing for a chain registration to hold. This is the branch that makes the
   * plan's "chain footprint: ZERO" true rather than aspirational.
   */
  holdingSource?: "chain" | "pod-cert";
  /** For `pod-cert` badges: the issuer's content-feed owner address, without
   *  which nobody can find the certificate log. See `PodDirectoryEntry`. */
  certLogOwner?: Hex0x;
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
  const certSourced = opts.holdingSource === "pod-cert";

  // ── Holdings/gating on the CHAIN rail is a WoCoEventV2 feature — refuse to
  //    mint a POD on a chain where it could never be read on-chain. A
  //    certificate badge reads its holdings from issuer signatures and never
  //    touches a chain, so this requirement does not apply to it. ───────────
  const chainId = getActiveChainId();
  if (!certSourced && getEventContractVersion(chainId) === "v1") {
    throw new Error(
      `POD issuance needs the on-chain slot rail; active chain ${chainId} is on v1`,
    );
  }
  if (certSourced && !opts.certLogOwner) {
    throw new Error("a certificate badge needs certLogOwner, or its log can never be found");
  }

  // ── Validate the client-signed manifest against the pod bodies (same checks
  //    createEventV2 runs before touching Swarm).
  //
  //    The two rails count bodies differently, and deliberately. On the chain
  //    rail a body is an EDITION — one per claimable slot. A certificate names
  //    its holder instead, so no edition is ever claimed and pre-signing one per
  //    unit of supply would cost N signatures and N uploads to commit to bytes
  //    no reader reads. The certificate rail commits to exactly ONE real
  //    template body carrying the badge's display metadata: a genuine leaf of a
  //    genuine (degenerate) tree under the locked scheme, so `metadataRoot` is
  //    an honest commitment to bytes that exist and are fetchable, and
  //    `verifySignedManifest` needs no special case. ─────────────────────────
  const expectedBodies = certSourced ? 1 : supply;
  if (podBodies.length !== expectedBodies) {
    throw new Error(
      certSourced
        ? `A certificate badge commits to exactly 1 template pod body, got ${podBodies.length}`
        : `Expected ${supply} pod bodies, got ${podBodies.length}`,
    );
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

  // ── The manifest blob must be gateway-whitelisted, or a CLIENT cannot read
  //    it at all. The bee-proxy serves only whitelisted addresses and tags its
  //    refusal as a 403; the certificate rail is the first thing to read this
  //    blob from a browser (the gate write-boundary reads it server-side, which
  //    goes direct to the in-cluster bee and bypasses the gate entirely), so
  //    the gap was invisible until now.
  //
  //    AWAITED AND FATAL for a certificate badge, unlike the artwork above.
  //    Artwork failing to whitelist costs a broken image; this failing costs a
  //    badge that can never be awarded, because the issuance surface resolves
  //    its issuer key and cap from this blob. A certificate badge has no chain
  //    registration to orphan, so refusing here leaves nothing half-created —
  //    the same reasoning that makes `certLogOwner` a precondition rather than
  //    a warning. ────────────────────────────────────────────────────────────
  if (certSourced) {
    try {
      await whitelistHashes([swarmManifestRef]);
    } catch (err) {
      throw new Error(
        `could not publish this badge's manifest for reading (${(err as Error).message}) — refusing to mint a badge that could never be awarded`,
      );
    }
  } else {
    void whitelistHashes([swarmManifestRef]).catch((err) =>
      console.warn("[pod] manifest whitelist failed (non-critical on the chain rail):", err),
    );
  }

  // ── Sponsor-register on-chain — CHAIN RAIL ONLY. Price 0 (escrow dormant),
  //    open FIFO gate, creator is the (irrelevant, price-0) payout recipient.
  //
  //    A certificate badge skips this entirely. `totalSupply` on its manifest is
  //    the issuer's DECLARED CAP, and nothing at any door enforces it: the
  //    writing client refuses to issue past it, and over-issuance is provable
  //    from the issuer's own signed log, since the excess certificates carry the
  //    issuer's signature. Audit-enforced, not gate-enforced — the honest
  //    ceiling for a rail whose trust root is one issuer's signature, and a door
  //    verifying offline must not pretend otherwise. ─────────────────────────
  let onChainEventId: string | undefined;
  if (certSourced) {
    console.log(`[pod] minted certificate ${kind} "${name}" cap=${supply} manifest=${manifestRef.slice(0, 10)} (no chain)`);
  } else {
    const registered = await registerEventOnChain(supply, manifestRef, {
      // The ledger stamps this as the event's owner of record — the creator,
      // never the sponsor wallet that submits the transaction.
      organiser: creatorAddress,
      eventEndTs: NEVER_EXPIRES_TS,
      priceBaseUnits: 0n,
      payoutRecipient: creatorAddress,
      dropGate: ZERO_ADDRESS,
    });
    onChainEventId = registered.onChainEventId;
    console.log(`[pod] minted ${kind} "${name}" supply=${supply} eventId=${onChainEventId} tx=${registered.txHash}`);
  }

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
    // A certificate badge has no chain registration, so it carries neither
    // coordinate. `PodDirectoryEntry` already documents both as present only
    // once on-chain registration confirms — this is the case that optionality
    // was waiting for, so no schema change is needed.
    ...(certSourced ? { certLogOwner: opts.certLogOwner } : { eventId: onChainEventId!, chainId }),
    swarmManifestRef,
    createdAt: now,
    updatedAt: now,
  };
  await upsertCreatorPod(creatorAddress, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// The counter the certificate rail reports back
// ---------------------------------------------------------------------------

export type IssuedCountVerdict =
  | { ok: true; value: number }
  | { ok: false; error: string };

/**
 * Decide whether `value` may be written to `entry.issuedCount`.
 *
 * CERTIFICATE BADGES ONLY. The server never sees a certificate issuance — the
 * run is client-signed and written straight to the issuer's own feed — so the
 * client is the only party that knows the number, and this counter is the only
 * way the manager shows progress without walking the whole log. A CHAIN badge's
 * count is derivable server-side from `nextSlot`, so letting a client write it
 * would allow a display number to contradict the chain. Ticket PODs are
 * chain-sourced too and are refused by the same rule.
 *
 * Clamped, then TRUSTED inside the bounds. Shape is something the server can
 * enforce; truth is not. The directory is documented display layer rather than
 * a trust root, and the recomputable truth is the issuer's signed log.
 *
 * NOT a monotonic ratchet, deliberately. Monotonicity would freeze a client's
 * over-report forever, and a later honest run recomputes distinct holders from
 * a log it has just read thoroughly — so it must be able to correct DOWNWARD.
 */
export function validateIssuedCount(
  entry: Pick<PodDirectoryEntry, "certLogOwner" | "supply">,
  value: unknown,
): IssuedCountVerdict {
  if (!entry.certLogOwner) {
    return { ok: false, error: "issuedCount can only be set on a certificate badge" };
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > entry.supply
  ) {
    return { ok: false, error: `issuedCount must be an integer 0..${entry.supply}` };
  }
  return { ok: true, value };
}
