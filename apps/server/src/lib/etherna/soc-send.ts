/**
 * One signed SOC meant for Etherna, with the failover (#912): a SOC a user signed
 * (`uploadSignedSoc`, slice 1) and one this server signed (the feed writers below,
 * slice 2b) take the same path. With the rail on, a SOC Etherna cannot take is
 * listed, then stamped on the WoCo batch, and the sweep re-posts the same signed
 * bytes to Etherna later - a SOC's signature covers its identifier and content,
 * not the batch, so no signer is needed for the move.
 *
 * No whitelist, offer or semaphore here: those belong to the caller. A user's relay
 * whitelists first and offers after (`soc-upload.ts`); a platform feed page is read
 * from our bee by the server alone and is written under the feed layer's own upload
 * slot (`feeds.ts`), which a second acquire here could deadlock.
 */

import { type PrivateKey, type Topic, FeedIndex } from "@ethersphere/bee-js";
import { Binary } from "cafe-utility";
import { calculateCacAddress, calculateSocAddress, encodeSpan } from "@woco/shared";
import { BEE_URL, requirePostageBatch } from "../../config/swarm.js";
import { errorSnippet } from "../http/read-capped.js";
import { BEE_CALL_TIMEOUT_MS, withTimeout, type UploadBudget } from "../swarm/upload-queue.js";
import { PlatformBatchUnavailable } from "./batch-router.js";
import { FAILOVER_ETHERNA_ATTEMPTS, FAILOVER_ETHERNA_TIMEOUT_MS, noteFailedOver, relayPlan } from "./failover.js";
import { noteFailover } from "./relay-ledger.js";
import { postSocToEtherna, registerEthernaOffer } from "./upload.js";

/** A signed SOC as both stores take it: `POST /soc/{owner}/{id}?sig=`, body = span || payload. */
export interface SocWire {
  ownerHex: string;
  identifierHex: string;
  sigHex: string;
  body: Uint8Array;
}

/** With the rail on: whose batch the SOC moves back to, and a batch the router already refused. */
export interface SocFailover {
  parent?: string;
  ethernaRefused?: string;
}

/** Runs one leg's send within a budget: the relay retries it, the feed writer runs it once (it retries itself). */
export type LegRunner = (send: (timeoutMs: number) => Promise<void>, budget: UploadBudget) => Promise<void>;

export const FULL_BUDGET: UploadBudget = { attempts: 5, timeoutMs: BEE_CALL_TIMEOUT_MS };

/** One attempt within the budget's time, for a caller with its own retry loop. */
export const runOnce: LegRunner = (send, budget) => send(budget.timeoutMs);

export async function postSocToWocoBee(soc: SocWire, batchId: string, timeoutMs: number): Promise<void> {
  const resp = await withTimeout(
    fetch(`${BEE_URL}/soc/${soc.ownerHex}/${soc.identifierHex}?sig=${soc.sigHex}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Swarm-Postage-Batch-Id": batchId,
        // Buffer locally + push in the BACKGROUND, returning immediately —
        // exactly like the legacy feed/bytes writes (bytes.ts, feeds.ts).
        // Without this, Bee defaults to a SYNCHRONOUS upload that blocks
        // until the chunk is pushed to the network (~25-30s observed),
        // which was the entire publish-step-1→2 regression. The chunk is
        // readable from this node immediately, so server-side reads
        // (register-on-chain) and the whitelisted gateway read still work.
        // Etherna manages its own upload pipeline, so it's WoCo-only.
        "Swarm-Deferred-Upload": "true",
      },
      body: Buffer.from(soc.body),
    }),
    timeoutMs,
    "soc upload",
  );
  if (!resp.ok) {
    const e = new Error(`Bee SOC upload ${resp.status}: ${await errorSnippet(resp, 200)}`) as Error & { status?: number };
    e.status = resp.status;
    throw e;
  }
}

/**
 * Send `soc` to Etherna on `batchId`. Without `failover`, or with the rail off,
 * exactly as before: Etherna or an error. With it, Etherna gets a short try (none
 * when the router already refused its batch, the breaker is open, or under
 * `force`), then the SOC is listed - BEFORE the stamp, so a crash after it never
 * leaves a chunk on WoCo that nothing moves back - and stamped on the WoCo batch.
 * Not listed, no detour: the save fails as it would with the rail off.
 */
export async function sendSocForEtherna(
  soc: SocWire,
  batchId: string,
  opts: { failover?: SocFailover; run: LegRunner },
): Promise<"etherna" | "woco"> {
  const plan = opts.failover ? relayPlan(opts.failover.ethernaRefused) : "etherna";
  // A batch the chain refuses, and the failover can no longer take the save
  // (its list filled since the route asked): never post it there (#610).
  if (opts.failover?.ethernaRefused !== undefined && plan !== "woco") {
    throw new PlatformBatchUnavailable(opts.failover.ethernaRefused);
  }
  if (plan !== "woco") {
    try {
      await opts.run(
        (timeoutMs) => postSocToEtherna({ ...soc, batchId, timeoutMs }),
        plan === "etherna" ? FULL_BUDGET : { attempts: FAILOVER_ETHERNA_ATTEMPTS, timeoutMs: FAILOVER_ETHERNA_TIMEOUT_MS },
      );
      return "etherna";
    } catch (err) {
      if (plan === "etherna") throw err;
      console.warn(`[swarm] Etherna could not take SOC ${soc.identifierHex.slice(0, 12)}…, stamping it on WoCo: ${(err as Error)?.message ?? err}`);
    }
  }
  const address = Binary.uint8ArrayToHex(
    calculateSocAddress(Binary.hexToUint8Array(soc.identifierHex), Binary.hexToUint8Array(soc.ownerHex)),
  );
  if (!noteFailover(address, soc.ownerHex, soc.identifierHex, opts.failover!.parent)) {
    throw new PlatformBatchUnavailable("the Etherna failover list is full or unreadable");
  }
  await opts.run((timeoutMs) => postSocToWocoBee(soc, requirePostageBatch(), timeoutMs), FULL_BUDGET);
  noteFailedOver();
  return "woco";
}

/** A feed update's SOC: identifier = keccak(topic || index_be8), signed over identifier || content address. */
function signFeedUpdate(topic: Topic, index: bigint, contentAddress: Uint8Array, signer: PrivateKey): { identifierHex: string; sigHex: string } {
  const socId = Binary.keccak256(Binary.concatBytes(topic.toUint8Array(), FeedIndex.fromBigInt(index).toUint8Array()));
  const sig = signer.sign(Binary.concatBytes(socId, contentAddress)) as unknown as { toUint8Array(): Uint8Array };
  return { identifierHex: Binary.uint8ArrayToHex(socId), sigHex: Binary.uint8ArrayToHex(sig.toUint8Array()) };
}

/**
 * Offer a SOC so Etherna's own gateway serves it anonymously - only when it is on
 * Etherna; one stamped on WoCo is offered when the sweep moves it back. Our reads
 * come from our bee, so this is availability polish, never load-bearing.
 */
function offerSoc(identifierHex: string, ownerHex: string): void {
  const socAddr = Binary.uint8ArrayToHex(calculateSocAddress(Binary.hexToUint8Array(identifierHex), Binary.hexToUint8Array(ownerHex)));
  void registerEthernaOffer(socAddr).catch((e) => console.warn("[etherna] feed-update offer failed (non-fatal):", e));
}

/**
 * Write ONE sequence-feed update with an arbitrary INLINE payload (a 4096-byte
 * feed page) at an EXPLICIT index, meant for an Etherna batch. The Etherna twin of
 * `feeds.ts`'s bee-js `uploadPayload({ index })` write: same SOC layout, different
 * node + batch. The caller owns index resolution (feeds.ts's per-topic cache) and
 * retries; an explicit index is REQUIRED - bee-js's silent fall-back-to-0 on lookup
 * errors is a known feed corrupter.
 *
 * Throws Error with a `status` field on non-2xx so the caller's transient-error
 * classifier (429/423/5xx) can retry. Resolves to where the update landed.
 */
export async function writeEthernaFeedPage(opts: {
  topic: Topic;
  index: bigint;
  payload: Uint8Array;   // ≤4096 bytes
  batchId: string;
  signer: PrivateKey;
  ownerHex: string;      // 40-char hex, no 0x, lowercase
  failover?: SocFailover;
}): Promise<"etherna" | "woco"> {
  const span = encodeSpan(opts.payload.length);
  const signed = signFeedUpdate(opts.topic, opts.index, calculateCacAddress(span, opts.payload), opts.signer);
  const landed = await sendSocForEtherna(
    { ownerHex: opts.ownerHex, ...signed, body: Binary.concatBytes(span, opts.payload) },
    opts.batchId,
    { failover: opts.failover, run: runOnce },
  );
  if (landed === "etherna") offerSoc(signed.identifierHex, opts.ownerHex);
  return landed;
}

/**
 * A platform-signed site pointer update: the feed's next update names `rootChunk`
 * (span + root node, `collectionRootChunk`) at the index resolved BEFORE the
 * content was uploaded (#943). Body = the root chunk itself, so a feed lookup
 * serves the collection root inline.
 *
 * bee-js's onRequest receives a shallow copy, so auth headers never reach Etherna:
 * this signs with PrivateKey.sign() and sends with raw HTTP (`postSocToEtherna`).
 * SOC signing protocol (bee-js makeSingleOwnerChunk): sign(socId || cacAddress).
 */
export async function writeEthernaFeedUpdate(opts: {
  topic: Topic;
  index: bigint;
  rootChunk: Uint8Array;
  batchId: string;
  signer: PrivateKey;
  ownerHex: string;      // 40-char hex, no 0x, lowercase
  failover?: SocFailover;
}): Promise<"etherna" | "woco"> {
  const span = opts.rootChunk.subarray(0, 8);
  const signed = signFeedUpdate(opts.topic, opts.index, calculateCacAddress(span, opts.rootChunk.subarray(8)), opts.signer);
  const landed = await sendSocForEtherna({ ownerHex: opts.ownerHex, ...signed, body: opts.rootChunk }, opts.batchId, {
    failover: opts.failover,
    run: runOnce,
  });
  if (landed === "etherna") offerSoc(signed.identifierHex, opts.ownerHex);
  return landed;
}
