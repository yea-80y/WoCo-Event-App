/**
 * Client-owned content feeds (Phase B — CLIENT_FEED_SIGNER_HANDOVER.md Task 2).
 *
 * A content feed (profile, event, site) becomes a fixed-identifier Single-Owner
 * Chunk SIGNED by the user's own content-feed key — so the USER owns the feed.
 * The server only stamps+uploads it (`signAndUploadSoc` → `/api/swarm/soc`), so
 * there is no added latency vs the old server-write (signing is local) and the
 * stamp step is a swappable transport (per-user batch / browser-Bee later).
 *
 * The feed-signer key is SIGN-TO-DERIVED: keccak256 of a deterministic,
 * domain-separated EIP-712 signature (`FEED_SIGNER_DERIVE_DOMAIN`) — the SAME
 * construction as the POD seed, differing only in the domain signed, so the two
 * keys are cryptographically independent. Once established it is persisted (and,
 * for credentials that rotate, escrowed) and restored verbatim; the stored key
 * always wins. Reads resolve by computed chunk address (Etherna-safe — never
 * `/feeds`).
 */

import { keccak256, getBytes, Wallet } from "ethers";
import {
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
 * Build a `ContentFeedSigner` from a STORED/escrowed private key (the established
 * feed-signer secret). This performs NO derivation — the key is restored verbatim
 * from local storage or escrow (the stored key always wins over re-deriving); we
 * only recover its address.
 */
export function contentFeedSignerFromPrivKey(privKey: string): ContentFeedSigner {
  const key = privKey.startsWith("0x") ? privKey : `0x${privKey}`;
  return { privKey: key, address: new Wallet(key).address.toLowerCase() };
}

/**
 * Derive the content-feed signer from a deterministic, domain-separated EIP-712
 * signature — the SINGLE construction used for EVERY login kind that can own
 * client feeds (web3 wallet, web3auth, local, passkey). `keccak256(canonical
 * 65-byte signature)` → a uniform secp256k1 key, identical compression to the POD
 * seed (`pod-identity.ts`), the proven in-production pattern. Domain separation
 * lives in what was signed (`FEED_SIGNER_DERIVE_DOMAIN`, distinct salt from POD),
 * so this does not re-prefix a domain string. The signature MUST be the canonical
 * bytes, not the hex string.
 */
export function deriveContentFeedSignerFromSig(signature: string): ContentFeedSigner {
  const seed = keccak256(getBytes(signature));
  return { privKey: seed, address: new Wallet(seed).address.toLowerCase() };
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
