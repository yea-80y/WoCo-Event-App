/**
 * Client-owned editions publisher (Phase B / B1).
 *
 * The organiser's browser builds the editions feed and publishes it as
 * carrier-owned Single-Owner Chunks — the server holds no key for it. For each
 * series:
 *   1. build per-edition `woco.ticket.v1` SignedTickets, signed with the
 *      organiser's POD ed25519 key (real authorship; the claim path re-verifies);
 *   2. stamp the ticket bodies + the page-0 meta blob onto Swarm /bytes via the
 *      server bytes rail (content-addressed → trustless; routed to the Etherna
 *      batch when the builder picked the Etherna gateway);
 *   3. pack the 4096-byte editions pages (slot 0 = meta, slots 1..127 = editions
 *      1..127 on page 0; 128 editions per page after);
 *   4. sign + upload each page as a SOC OWNED BY THE CARRIER (the organiser's
 *      content-feed signer), via the existing /api/swarm/soc rail.
 *
 * The server reads these back at claim/reserve time via the carrier ADDRESS (read
 * side: claim-service `readEditionsPage`). The platform signer never touches the
 * editions feed. This is the bridge to B2 (claim straight from the on-chain-anchored
 * manifest, retiring the editions feed).
 */

import * as ed from "@noble/ed25519";
import { bytesToHex } from "@noble/hashes/utils";
import type { TicketData } from "@woco/shared";
import {
  contentFeedSocIdentifier,
  editionsContentTopic,
  SOC_MAX_PAYLOAD_SIZE,
} from "@woco/shared";
import { signAndUploadSoc } from "../swarm/client-soc.js";
import { stampBytes } from "../swarm/client-bytes.js";
import type { ContentFeedSigner } from "../swarm/content-feed.js";

// MUST match the server's editions pagination (apps/server/src/lib/swarm/topics.ts:
// PAGE_0_CAPACITY / PAGE_N_CAPACITY). Page 0 spends slot 0 on the meta ref.
const PAGE_0_CAPACITY = 127;
const PAGE_N_CAPACITY = 128;
/** Cap concurrent body stamps; the server serialises bee writes (2-wide) anyway,
 *  so a wider client fan-out just queues. Keeps memory + open sockets bounded. */
const STAMP_CONCURRENCY = 8;

function editionPageCount(totalSupply: number): number {
  if (totalSupply <= PAGE_0_CAPACITY) return 1;
  return 1 + Math.ceil((totalSupply - PAGE_0_CAPACITY) / PAGE_N_CAPACITY);
}

/** Pack hex refs into a 4096-byte binary page (128 × 32 bytes), mirroring the
 *  server `pack4096`. Refs may be 0x-prefixed or not. */
function pack4096(refs: string[]): Uint8Array {
  const page = new Uint8Array(SOC_MAX_PAYLOAD_SIZE);
  const n = Math.min(refs.length, 128);
  for (let i = 0; i < n; i++) {
    const h = refs[i].startsWith("0x") ? refs[i].slice(2) : refs[i];
    for (let j = 0; j < 32; j++) page[i * 32 + j] = parseInt(h.slice(j * 2, j * 2 + 2), 16);
  }
  return page;
}

async function runBatched<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

export interface EditionsSeriesInput {
  seriesId: string;
  name: string;
  totalSupply: number;
  approvalRequired?: boolean;
}

export interface EditionsPublishInput {
  eventId: string;
  /** Real uploaded image hash from the event feed (claim copies it onto the ticket). */
  imageHash: string;
  /** Event creator address — recorded on each ticket (`data.creator`). */
  creatorAddress: string;
  /** Organiser POD ed25519 private key (32 bytes) + public key hex (0x-prefixed). */
  podPrivateKey: Uint8Array;
  podPublicKeyHex: string;
  /** Carrier — the content-feed signer that OWNS the editions SOCs. */
  feedSigner: ContentFeedSigner;
  /** Builder gateway (routes ticket-body bytes to the Etherna batch when chosen). */
  gatewayUrl?: string;
  series: EditionsSeriesInput[];
  /** Progress over total ticket bodies stamped across all series. */
  onProgress?: (done: number, total: number) => void;
}

/** Publish the editions feed for every series. Resolves only when all editions are
 *  durably readable (bodies stamped, then carrier SOC pages uploaded). Throws on
 *  any failure so the publish flow can surface it — claiming depends on this. */
export async function publishEditions(input: EditionsPublishInput): Promise<void> {
  const { eventId, imageHash, creatorAddress, podPrivateKey, podPublicKeyHex, feedSigner, gatewayUrl, series, onProgress } = input;

  const totalBodies = series.reduce((n, s) => n + s.totalSupply, 0);
  let bodiesDone = 0;
  const mintedAt = new Date().toISOString();
  const stampOpts = gatewayUrl ? { gatewayUrl } : {};

  for (const s of series) {
    const pageCount = editionPageCount(s.totalSupply);

    // 1. Meta blob (slot 0) — what the server's loadSeriesMeta parses.
    const metaRef = await stampBytes(
      new TextEncoder().encode(
        JSON.stringify({ totalSupply: s.totalSupply, pageCount, approvalRequired: !!s.approvalRequired }),
      ),
      stampOpts,
    );

    // 2. Per-edition SignedTickets → stamped bodies. Batched for throughput.
    const editions = Array.from({ length: s.totalSupply }, (_, i) => i + 1);
    const ticketRefs = await runBatched(editions, STAMP_CONCURRENCY, async (edition) => {
      const data: TicketData = {
        podType: "woco.ticket.v1",
        eventId,
        seriesId: s.seriesId,
        seriesName: s.name,
        edition,
        totalSupply: s.totalSupply,
        imageHash,
        creator: creatorAddress,
        mintedAt,
      };
      const message = new TextEncoder().encode(JSON.stringify(data));
      const signature = bytesToHex(await ed.signAsync(message, podPrivateKey));
      const ref = await stampBytes(
        new TextEncoder().encode(JSON.stringify({ data, signature, publicKey: podPublicKeyHex })),
        stampOpts,
      );
      onProgress?.(++bodiesDone, totalBodies);
      return ref;
    });

    // 3. Pack pages: page 0 = [meta, editions 1..127]; pages 1+ = 128 each.
    const pages: Uint8Array[] = [];
    pages.push(pack4096([metaRef, ...ticketRefs.slice(0, PAGE_0_CAPACITY)]));
    for (let p = 1; p < pageCount; p++) {
      const start = PAGE_0_CAPACITY + (p - 1) * PAGE_N_CAPACITY;
      pages.push(pack4096(ticketRefs.slice(start, start + PAGE_N_CAPACITY)));
    }

    // 4. Upload carrier SOCs. Overflow pages FIRST, page 0 LAST — so once page 0
    //    (which loadSeriesMeta reads) resolves, every referenced page is present.
    for (let p = pages.length - 1; p >= 1; p--) {
      await signAndUploadSoc({
        signerPrivKey: feedSigner.privKey,
        identifier: contentFeedSocIdentifier(editionsContentTopic(s.seriesId, p)),
        payload: pages[p],
      });
    }
    await signAndUploadSoc({
      signerPrivKey: feedSigner.privKey,
      identifier: contentFeedSocIdentifier(editionsContentTopic(s.seriesId, 0)),
      payload: pages[0],
    });
  }
}
