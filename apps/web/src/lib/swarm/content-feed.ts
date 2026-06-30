/**
 * Client-owned content feeds (Phase B — CLIENT_FEED_SIGNER_HANDOVER.md Task 2).
 *
 * A content feed (profile, event, site) becomes a fixed-identifier Single-Owner
 * Chunk SIGNED by the user's own content-feed key — so the USER owns the feed.
 * The server only stamps+uploads it (`signAndUploadSoc` → `/api/swarm/soc`), so
 * there is no added latency vs the old server-write (signing is local) and the
 * stamp step is a swappable transport (per-user batch / browser-Bee later).
 *
 * The feed-signer key is derived from the user's root login secret under its OWN
 * domain (`CONTENT_FEED_SIGNER_DOMAIN`), independent of POD + funds — mirrors the
 * portability-key derivation in `recovery-portability.ts`. Reads resolve by
 * computed chunk address (Etherna-safe — never `/feeds`).
 */

import { keccak256, getBytes, toUtf8Bytes, concat, Wallet } from "ethers";
import {
  CONTENT_FEED_SIGNER_DOMAIN,
  CONTENT_FEED_MC_MARKER,
  contentFeedSocIdentifier,
  contentFeedPageTopic,
  isContentFeedManifest,
  type ContentFeedManifest,
  SOC_MAX_PAYLOAD_SIZE,
} from "@woco/shared";
import { signAndUploadSoc, readSoc } from "./client-soc.js";

export interface ContentFeedSigner {
  /** secp256k1 private key (0x-prefixed). */
  privKey: string;
  /** Lowercased owner address — the SOC owner / registry value. */
  address: string;
}

/**
 * Derive the content-feed signer from a root secp256k1 key (passkey PRF key /
 * Web3Auth key / local key). `keccak256(domain || rootKey)` → a valid secp256k1
 * key whose address owns the user's content SOCs.
 *
 * Used only to SEED a NEW signer (`_getContentFeedSigner` then persists + escrows
 * it). Recovery does NOT re-derive: a rotated passkey credential yields a divergent
 * root, so the established key is restored verbatim from escrow/portability and the
 * stored copy always wins. See `feed-signer-store.ts` + `recovery-portability.ts`.
 */
export function deriveContentFeedSigner(rootPrivKey: string): ContentFeedSigner {
  const rootBytes = getBytes(rootPrivKey.startsWith("0x") ? rootPrivKey : `0x${rootPrivKey}`);
  const seed = keccak256(concat([toUtf8Bytes(CONTENT_FEED_SIGNER_DOMAIN), rootBytes]));
  const wallet = new Wallet(seed);
  return { privKey: seed, address: wallet.address.toLowerCase() };
}

/**
 * Build a `ContentFeedSigner` from a STORED/escrowed private key (the independent
 * feed-signer secret). Unlike `deriveContentFeedSigner` this performs no
 * derivation — the key is the established secret, restored verbatim from local
 * storage or escrow; we only recover its address.
 */
export function contentFeedSignerFromPrivKey(privKey: string): ContentFeedSigner {
  const key = privKey.startsWith("0x") ? privKey : `0x${privKey}`;
  return { privKey: key, address: new Wallet(key).address.toLowerCase() };
}

/**
 * Sign + upload a JSON content feed as a client-owned SOC at
 * `contentFeedSocIdentifier(topic)`. Overwrite-in-place (same owner+identifier).
 *
 * A feed that fits one 4096-byte chunk is written as a single base SOC of raw JSON
 * (unchanged). A larger feed PAGES across SOCs: the data is split over
 * `topic/p1 … /pN` and the base SOC holds a tiny manifest pointing at them — so
 * there is no practical size ceiling and the user is never restricted. Inline
 * payloads only (Etherna-safe). Data pages are uploaded BEFORE the manifest so a
 * reader never sees a manifest whose pages aren't there yet.
 */
export async function writeContentFeed(args: {
  signerPrivKey: string;
  topic: string;
  data: unknown;
}): Promise<void> {
  const json = new TextEncoder().encode(JSON.stringify(args.data));
  if (json.length < 1) throw new Error("content feed payload must be ≥1 byte");

  if (json.length <= SOC_MAX_PAYLOAD_SIZE) {
    await signAndUploadSoc({
      signerPrivKey: args.signerPrivKey,
      identifier: contentFeedSocIdentifier(args.topic),
      payload: json,
    });
    return;
  }

  const pages = Math.ceil(json.length / SOC_MAX_PAYLOAD_SIZE);
  // Pages are independent SOCs — upload them CONCURRENTLY (was sequential, which
  // cost one browser→server round-trip per page and dominated publish latency for
  // large feeds). The manifest is still written only AFTER all pages resolve, so a
  // reader never sees a manifest whose pages aren't there yet.
  await Promise.all(
    Array.from({ length: pages }, (_, i) => {
      const slice = json.subarray(i * SOC_MAX_PAYLOAD_SIZE, (i + 1) * SOC_MAX_PAYLOAD_SIZE);
      return signAndUploadSoc({
        signerPrivKey: args.signerPrivKey,
        identifier: contentFeedSocIdentifier(contentFeedPageTopic(args.topic, i + 1)),
        payload: slice,
      });
    }),
  );
  const manifest: ContentFeedManifest = { [CONTENT_FEED_MC_MARKER]: 1, pages, len: json.length };
  await signAndUploadSoc({
    signerPrivKey: args.signerPrivKey,
    identifier: contentFeedSocIdentifier(args.topic),
    payload: new TextEncoder().encode(JSON.stringify(manifest)),
  });
}

/** Read + JSON-decode a client-owned content feed by owner + topic (multi-chunk aware). */
export async function readContentFeed<T>(ownerAddress: string, topic: string): Promise<T | null> {
  const raw = await readSoc(ownerAddress, contentFeedSocIdentifier(topic));
  if (!raw) return null;

  let head: unknown;
  try {
    head = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }

  // Single-chunk feed: the base SOC IS the JSON.
  if (!isContentFeedManifest(head)) return head as T;
  // Bound the fetch loop (256 pages = 1 MB — far beyond any real feed).
  if (head.pages < 1 || head.pages > 256) return null;

  // Multi-chunk: gather data pages and reassemble.
  const parts: Uint8Array[] = [];
  for (let i = 1; i <= head.pages; i++) {
    const page = await readSoc(ownerAddress, contentFeedSocIdentifier(contentFeedPageTopic(topic, i)));
    if (!page) return null; // a missing page ⇒ incomplete; treat as not-found
    parts.push(page);
  }
  const full = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { full.set(p, off); off += p.length; }
  try {
    return JSON.parse(new TextDecoder().decode(full)) as T;
  } catch {
    return null;
  }
}
