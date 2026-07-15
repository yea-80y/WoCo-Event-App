/**
 * Etherna upload helpers — raw HTTP against gateway.etherna.io.
 *
 * We bypass bee-js here because (a) the upload is a one-shot tar POST,
 * (b) bee-js v11's onRequest header injection is shallow-copy and unreliable,
 * and (c) the offer-register step is Etherna-specific and has no bee-js wrapper.
 *
 * Feed writes still go through bee-js (signing is the value-add), via a Bee
 * instance configured to talk to Etherna with bearer-token auth.
 */

import { Bee, type Topic, type PrivateKey, FeedIndex } from "@ethersphere/bee-js";
import { Binary } from "cafe-utility";
import { calculateSocAddress, calculateCacAddress, encodeSpan } from "@woco/shared";
import { ensureEthernaToken, getCachedEthernaToken } from "./auth.js";

const ETHERNA_GW = process.env.ETHERNA_GATEWAY_URL || "https://gateway.etherna.io";

let _ethernaBee: Bee | null = null;

/**
 * Bee client targeted at Etherna with OAuth bearer injection per request.
 * Use for feed writes (uploadPayload / uploadReference / createFeedManifest)
 * when the deploy target is Etherna. The platform Bee in config/swarm.ts is
 * for the WoCo woco-batch path.
 */
export function getEthernaBee(): Bee {
  if (_ethernaBee) return _ethernaBee;
  _ethernaBee = new Bee(ETHERNA_GW, {
    onRequest: (req) => {
      const token = getCachedEthernaToken();
      if (token) {
        req.headers = { ...(req.headers ?? {}), Authorization: `Bearer ${token}` };
      }
    },
  });
  return _ethernaBee;
}

export interface BzzUploadOpts {
  batchId: string;
  tarData: Uint8Array | Buffer;
  indexDocument: string;
  errorDocument?: string;
}

/** Upload a tar collection to Etherna /bzz with bearer auth. Returns content ref. */
export async function uploadCollectionToEtherna(opts: BzzUploadOpts): Promise<string> {
  await ensureEthernaToken();
  const token = getCachedEthernaToken();
  if (!token) throw new Error("Etherna token unavailable (ETHERNA_API_KEY missing or ETHERNA_ENABLED off)");

  const headers: Record<string, string> = {
    "Content-Type": "application/x-tar",
    "Swarm-Postage-Batch-Id": opts.batchId,
    "Swarm-Index-Document": opts.indexDocument,
    "Swarm-Error-Document": opts.errorDocument ?? opts.indexDocument,
    "Swarm-Collection": "true",
    Authorization: `Bearer ${token}`,
  };

  const resp = await fetch(`${ETHERNA_GW}/bzz`, {
    method: "POST",
    headers,
    // @ts-ignore — Node 18 fetch doesn't expose duplex in type defs
    duplex: "half",
    body: opts.tarData as unknown as BodyInit,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Etherna /bzz upload failed ${resp.status}: ${text.slice(0, 300)}`);
  }
  const { reference } = await resp.json() as { reference: string };
  return reference;
}

/**
 * Register an Etherna "offer" so the resource becomes anonymously readable
 * via /bytes/{ref} (and /bzz/{ref}/file for collection entries).
 * Anonymous /feeds reads are NOT covered by offers — that endpoint always 401s.
 */
export async function registerEthernaOffer(ref: string): Promise<void> {
  await ensureEthernaToken();
  const token = getCachedEthernaToken();
  if (!token) throw new Error("Etherna token unavailable");
  const r = await fetch(`${ETHERNA_GW}/api/v0.3/resources/${ref}/offers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok && r.status !== 409) {
    // 409 = already offered; treat as success
    const text = await r.text().catch(() => "");
    throw new Error(`Etherna offer-register failed ${r.status}: ${text.slice(0, 200)}`);
  }
}

/**
 * Write a Swarm feed update to Etherna via raw HTTP.
 *
 * bee-js's onRequest receives a shallow copy — mutations are silently discarded,
 * so auth headers never reach Etherna. This function bypasses bee-js for every
 * HTTP call while reusing PrivateKey.sign() for the secp256k1 SOC signature.
 *
 * SOC signing protocol (from bee-js/dist/cjs/chunk/soc.js:makeSingleOwnerChunk):
 *   signData  = concat(socId_bytes(32), cac_address_bytes(32))
 *   signature = PrivateKey.sign(signData)   // EIP-191 personal_sign internally
 *
 * Returns the feed manifest hash (for ENS content hash) or throws.
 */
/**
 * Steps 1–3 of an Etherna feed update, split out so a CLIENT-OWNED feed can use
 * them too (the client signs the update SOC; only the platform-signed path runs
 * steps 4–5 here): create/read the feed manifest for `ownerHex`, find the next
 * sequence index, and download the content root chunk (span+data) that becomes
 * the update SOC's body.
 */
export async function prepareEthernaFeedUpdate(opts: {
  topic: Topic;
  contentHash: string;   // 64-char hex, no 0x
  batchId: string;
  ownerHex: string;      // 40-char hex, no 0x, lowercase
}): Promise<{ feedManifestHash: string; nextIndex: bigint; chunkBytes: Uint8Array }> {
  const { topic, contentHash, batchId, ownerHex } = opts;

  await ensureEthernaToken();
  const token = getCachedEthernaToken();
  if (!token) throw new Error("Etherna token unavailable");

  const topicHex = topic.toHex();
  const feedPath = `/feeds/${ownerHex}/${topicHex}`;

  // 1. Create feed manifest (POST) and read current index (GET) in parallel.
  //    POST /feeds/{owner}/{topic} → { reference: manifestHash }
  //    GET  /feeds/{owner}/{topic} → header swarm-feed-index-next (404 for fresh feed)
  const [manifestRes, indexRes] = await Promise.all([
    fetch(`${ETHERNA_GW}${feedPath}`, {
      method: "POST",
      headers: {
        "Swarm-Postage-Batch-Id": batchId,
        Authorization: `Bearer ${token}`,
      },
    }),
    fetch(`${ETHERNA_GW}${feedPath}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  ]);

  if (!manifestRes.ok) {
    const text = await manifestRes.text().catch(() => "");
    throw new Error(`Etherna feed manifest ${manifestRes.status}: ${text.slice(0, 200)}`);
  }
  const { reference: feedManifestHash } = await manifestRes.json() as { reference: string };

  // Fresh feed (indexRes 404) → write at index 0; existing feed → use next index.
  let nextIndex = 0n;
  if (indexRes.ok) {
    const h = indexRes.headers.get("swarm-feed-index-next");
    if (h) nextIndex = new FeedIndex(h).toBigInt();
  }

  // 3. Download root chunk (span+data of the content CAC) — POSTed as SOC body.
  const chunkRes = await fetch(`${ETHERNA_GW}/chunks/${contentHash}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!chunkRes.ok) throw new Error(`Chunk download ${chunkRes.status}: ${contentHash.slice(0, 12)}…`);
  const chunkBytes = new Uint8Array(await chunkRes.arrayBuffer());

  return { feedManifestHash, nextIndex, chunkBytes };
}

/**
 * Write ONE sequence-feed update with an arbitrary INLINE payload (a 4096-byte
 * feed page) at an EXPLICIT index, stamped on an Etherna batch. This is the
 * Etherna twin of `feeds.ts`'s bee-js `uploadPayload({ index })` write — same
 * SOC layout (identifier = keccak(topic || index_be8), body = span || payload),
 * different node + batch. The caller owns index resolution (feeds.ts's per-topic
 * cache); an explicit index is REQUIRED here — bee-js's silent fall-back-to-0 on
 * lookup errors is a known feed corrupter.
 *
 * Throws Error with a `status` field on non-2xx so the caller's transient-error
 * classifier (429/423/5xx) can retry.
 */
export async function writeEthernaFeedPage(opts: {
  topic: Topic;
  index: bigint;
  payload: Uint8Array;   // ≤4096 bytes
  batchId: string;
  signer: PrivateKey;
  ownerHex: string;      // 40-char hex, no 0x, lowercase
}): Promise<void> {
  await ensureEthernaToken();
  const token = getCachedEthernaToken();
  if (!token) throw new Error("Etherna token unavailable");

  const socId = Binary.keccak256(
    Binary.concatBytes(opts.topic.toUint8Array(), FeedIndex.fromBigInt(opts.index).toUint8Array()),
  );
  const span = encodeSpan(opts.payload.length);
  const cacAddress = calculateCacAddress(span, opts.payload);
  const sig = opts.signer.sign(Binary.concatBytes(socId, cacAddress)) as unknown as { toUint8Array(): Uint8Array };

  const socIdHex = Binary.uint8ArrayToHex(socId);
  const sigHex = Binary.uint8ArrayToHex(sig.toUint8Array());
  const postRes = await fetch(`${ETHERNA_GW}/soc/${opts.ownerHex}/${socIdHex}?sig=${sigHex}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Swarm-Postage-Batch-Id": opts.batchId,
      Authorization: `Bearer ${token}`,
    },
    // @ts-ignore — Node 18 fetch duplex
    duplex: "half",
    body: Buffer.from(Binary.concatBytes(span, opts.payload)),
  });
  if (!postRes.ok) {
    const text = await postRes.text().catch(() => "");
    const err = new Error(`Etherna feed-page write ${postRes.status}: ${text.slice(0, 200)}`) as Error & { status?: number };
    err.status = postRes.status;
    throw err;
  }

  // Offer the SOC so Etherna's own gateway serves it anonymously. Our reads come
  // from our bee (the chunk propagates to the public net), so this is fire-and-
  // forget availability polish, never load-bearing.
  const socAddr = Binary.uint8ArrayToHex(
    calculateSocAddress(socId, Binary.hexToUint8Array(opts.ownerHex)),
  );
  void registerEthernaOffer(socAddr).catch((e) =>
    console.warn("[etherna] feed-page offer failed (non-fatal):", e));
}

export async function writeEthernaFeedUpdate(opts: {
  topic: Topic;
  contentHash: string;   // 64-char hex, no 0x
  batchId: string;
  signer: PrivateKey;
  ownerHex: string;      // 40-char hex, no 0x, lowercase
}): Promise<string> {
  const { topic, contentHash, batchId, signer, ownerHex } = opts;

  const { feedManifestHash, nextIndex, chunkBytes } = await prepareEthernaFeedUpdate({
    topic, contentHash, batchId, ownerHex,
  });
  const token = getCachedEthernaToken();
  if (!token) throw new Error("Etherna token unavailable");

  // 2. SOC identifier = keccak256(topic_bytes(32) || uint64_BE(index)(8))
  const socId = Binary.keccak256(
    Binary.concatBytes(topic.toUint8Array(), FeedIndex.fromBigInt(nextIndex).toUint8Array()),
  );

  // 4. Sign: signer.sign(concat(socId, contentHash_bytes))
  //    contentHash_bytes = BMT address of the root CAC = the content reference itself.
  const signData = Binary.concatBytes(socId, Binary.hexToUint8Array(contentHash));
  const sig = signer.sign(signData) as unknown as { toUint8Array(): Uint8Array };
  const sigHex = Binary.uint8ArrayToHex(sig.toUint8Array());

  // 5. POST SOC: /soc/{owner}/{socId}?sig={sigHex}
  //    Body = raw root chunk bytes (span(8) + chunk_data).
  const socIdHex = Binary.uint8ArrayToHex(socId);
  const postRes = await fetch(`${ETHERNA_GW}/soc/${ownerHex}/${socIdHex}?sig=${sigHex}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Swarm-Postage-Batch-Id": batchId,
      Authorization: `Bearer ${token}`,
    },
    // @ts-ignore — Node 18 fetch duplex
    duplex: "half",
    body: Buffer.from(chunkBytes),
  });
  if (!postRes.ok) {
    const text = await postRes.text().catch(() => "");
    throw new Error(`Etherna SOC write ${postRes.status}: ${text.slice(0, 200)}`);
  }

  // Offer the update SOC's chunk so an anonymous feed dereference over this update
  // resolves without payment (the caller offers the feed manifest + content). The
  // SOC address = keccak256(socId || owner). Non-fatal — a missing offer only
  // blocks anonymous reads, not the write itself.
  try {
    const socAddr = Binary.uint8ArrayToHex(
      calculateSocAddress(socId, Binary.hexToUint8Array(ownerHex)),
    );
    await registerEthernaOffer(socAddr);
  } catch (e) {
    console.warn("[etherna] feed-update SOC offer failed (non-fatal):", e);
  }

  return feedManifestHash;
}
