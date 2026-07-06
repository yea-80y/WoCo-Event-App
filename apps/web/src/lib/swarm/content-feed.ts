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
  isContentFeedManifest,
  versionedSocIdentifier,
  versionedPageIdentifier,
  resolveLatestSocVersion,
  readVersionedContentFeed,
  LEGACY_CONTENT_FEED_VERSION,
  type ContentFeedManifest,
  type SocChunkReader,
  SOC_MAX_PAYLOAD_SIZE,
} from "@woco/shared";
import { signAndUploadSoc, readSoc } from "./client-soc.js";

// ---------------------------------------------------------------------------
// Version hints (optimisation, not correctness)
//
// A content feed is a single-owner SEQUENCE feed now (see @woco/shared soc.ts).
// Readers probe FORWARD from a hint; writers write hint+1. Caching the last-known
// version per (owner, topic) in localStorage lets a device skip re-probing from 0.
// The hint is a monotonic lower bound — versions are immutable, so a stored version
// always still exists. Reads/writes ALWAYS probe forward from it (never trust it as
// exact), so a stale-low or missing hint only costs a few extra chunk reads.
// ---------------------------------------------------------------------------

const HINT_PREFIX = "woco:cfv:"; // content-feed version

function hintKey(owner: string, topic: string): string {
  return `${HINT_PREFIX}${owner.toLowerCase()}:${topic}`;
}

function readVersionHint(owner: string, topic: string): number {
  try {
    const v = globalThis.localStorage?.getItem(hintKey(owner, topic));
    const n = v ? parseInt(v, 10) : 0;
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Store a version hint, only ever RAISING it (a lower value would skip real updates). */
function bumpVersionHint(owner: string, topic: string, version: number): void {
  try {
    if (version <= 0) return;
    if (version > readVersionHint(owner, topic)) {
      globalThis.localStorage?.setItem(hintKey(owner, topic), String(version));
    }
  } catch {
    /* ignore — hint is best-effort */
  }
}

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
 * Sign + upload a JSON content feed as a client-owned single-owner SEQUENCE feed.
 *
 * A SOC is immutable, so a fixed identifier can only ever be written ONCE (Bee
 * dedupes by chunk address and silently keeps the old payload). Each call therefore
 * resolves the current latest version and writes the NEXT version at a fresh
 * identifier (`versionedSocIdentifier`), which readers resolve by probing. Returns
 * the version written (callers may ignore it).
 *
 * A feed that fits one 4096-byte chunk is a single base SOC of raw JSON. A larger
 * feed PAGES across VERSION-SCOPED SOCs and the base SOC holds a tiny manifest — so
 * there is no size ceiling. Inline payloads only (Etherna-safe). Data pages upload
 * BEFORE the manifest so a reader never sees a manifest whose pages aren't there yet.
 *
 * `gatewayUrl` routes the stamp to the matching batch (Etherna user batch when the
 * event/site lives on Etherna); omitted ⇒ WoCo platform batch.
 */
export async function writeContentFeed(args: {
  signerPrivKey: string;
  topic: string;
  data: unknown;
  gatewayUrl?: string;
  /** Optional caller-supplied lower bound on the latest version (else localStorage). */
  versionHint?: number;
}): Promise<number> {
  const key = args.signerPrivKey.startsWith("0x") ? args.signerPrivKey : `0x${args.signerPrivKey}`;
  const owner = new Wallet(key).address.toLowerCase();
  const base = contentFeedSocIdentifier(args.topic);
  const gw = args.gatewayUrl ? { gatewayUrl: args.gatewayUrl } : {};

  const read: SocChunkReader = (id) => readSoc(owner, id);
  const hint = args.versionHint ?? readVersionHint(owner, args.topic);
  const latest = await resolveLatestSocVersion(read, (v) => versionedSocIdentifier(base, v), hint);
  const version = (latest ?? LEGACY_CONTENT_FEED_VERSION) + 1;

  const json = new TextEncoder().encode(JSON.stringify(args.data));
  if (json.length < 1) throw new Error("content feed payload must be ≥1 byte");

  if (json.length <= SOC_MAX_PAYLOAD_SIZE) {
    await signAndUploadSoc({
      signerPrivKey: key,
      identifier: versionedSocIdentifier(base, version),
      payload: json,
      ...gw,
    });
    bumpVersionHint(owner, args.topic, version);
    return version;
  }

  const pages = Math.ceil(json.length / SOC_MAX_PAYLOAD_SIZE);
  // Pages are independent SOCs — upload them CONCURRENTLY. The manifest is written
  // only AFTER all pages resolve, so a reader never sees a manifest whose pages
  // aren't there yet. Page identifiers are version-scoped (no torn cross-version read).
  await Promise.all(
    Array.from({ length: pages }, (_, i) => {
      const slice = json.subarray(i * SOC_MAX_PAYLOAD_SIZE, (i + 1) * SOC_MAX_PAYLOAD_SIZE);
      return signAndUploadSoc({
        signerPrivKey: key,
        identifier: versionedPageIdentifier(base, version, i + 1),
        payload: slice,
        ...gw,
      });
    }),
  );
  const manifest: ContentFeedManifest = { [CONTENT_FEED_MC_MARKER]: 1, pages, len: json.length };
  await signAndUploadSoc({
    signerPrivKey: key,
    identifier: versionedSocIdentifier(base, version),
    payload: new TextEncoder().encode(JSON.stringify(manifest)),
    ...gw,
  });
  bumpVersionHint(owner, args.topic, version);
  return version;
}

/**
 * Read + JSON-decode a client-owned content feed by owner + topic. Probes the
 * versioned sequence for the latest update, reassembling multi-chunk pages, and
 * falls back to the legacy pre-versioning fixed identifier so feeds written before
 * this fix stay readable. Multi-chunk aware.
 */
export async function readContentFeed<T>(ownerAddress: string, topic: string): Promise<T | null> {
  const owner = (ownerAddress.startsWith("0x") ? ownerAddress.slice(2) : ownerAddress).toLowerCase();
  const read: SocChunkReader = (id) => readSoc(owner, id);
  const res = await readVersionedContentFeed(read, topic, readVersionHint(owner, topic));
  if (!res) return null;
  if (res.version >= 0) bumpVersionHint(owner, topic, res.version);
  try {
    return JSON.parse(new TextDecoder().decode(res.bytes)) as T;
  } catch {
    return null;
  }
}
