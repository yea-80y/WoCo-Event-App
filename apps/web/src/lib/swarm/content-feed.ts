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
  contentFeedSocIdentifier,
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
 * key whose address owns the user's content SOCs. Deterministic ⇒ recovery is
 * re-login, no escrow.
 */
export function deriveContentFeedSigner(rootPrivKey: string): ContentFeedSigner {
  const rootBytes = getBytes(rootPrivKey.startsWith("0x") ? rootPrivKey : `0x${rootPrivKey}`);
  const seed = keccak256(concat([toUtf8Bytes(CONTENT_FEED_SIGNER_DOMAIN), rootBytes]));
  const wallet = new Wallet(seed);
  return { privKey: seed, address: wallet.address.toLowerCase() };
}

/**
 * Sign + upload a JSON content feed as a client-owned SOC at
 * `contentFeedSocIdentifier(topic)`. Overwrite-in-place (same owner+identifier).
 * Payload is the raw JSON bytes (≤4096) — the server reads it back with the same
 * null-tolerant JSON decoder used for platform feeds.
 */
export async function writeContentFeed(args: {
  signerPrivKey: string;
  topic: string;
  data: unknown;
}): Promise<void> {
  const payload = new TextEncoder().encode(JSON.stringify(args.data));
  if (payload.length < 1 || payload.length > SOC_MAX_PAYLOAD_SIZE) {
    throw new Error(`content feed payload must be 1..${SOC_MAX_PAYLOAD_SIZE} bytes (got ${payload.length})`);
  }
  await signAndUploadSoc({
    signerPrivKey: args.signerPrivKey,
    identifier: contentFeedSocIdentifier(args.topic),
    payload,
  });
}

/** Read + JSON-decode a client-owned content feed by owner + topic. */
export async function readContentFeed<T>(ownerAddress: string, topic: string): Promise<T | null> {
  const raw = await readSoc(ownerAddress, contentFeedSocIdentifier(topic));
  if (!raw) return null;
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as T;
  } catch {
    return null;
  }
}
