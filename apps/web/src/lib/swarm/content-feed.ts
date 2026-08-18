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

// ethers and client-soc (bee-js) are imported lazily inside each function —
// this module is statically reachable from api/events + api/profiles at first
// paint, and top-level imports here would drag both libraries into the boot
// bundle.
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
  type SocChunkProbe,
  SOC_MAX_PAYLOAD_SIZE,
} from "@woco/shared";

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

/** Exported ONLY so a test can prove the two call-site owner forms collide.
 *  The bug this guards was invisible — everything worked, just slowly — so the
 *  key derivation is the thing that has to be asserted directly. */
export function hintKey(owner: string, topic: string): string {
  // NORMALISED, both case AND `0x` prefix (#302). The write side derives its
  // owner from `new Wallet(key).address` (0x-prefixed) and the read side strips
  // the prefix before probing, so keying on the raw string meant the two never
  // saw each other's hint — and `readVersionHint` returns 0 on a miss, so every
  // operation restarted the forward scan from version 0.
  //
  // Cost, not correctness: the scan is sound either way. But a probe PAST the
  // latest version is a bee network search for a chunk that does not exist —
  // the most expensive read on Swarm, and the reason VERSION_PROBE_WINDOW was
  // cut to 2 after a window of 8 melted the node. The hint is what keeps the
  // scan short, and it had been silently inert on every client-owned feed.
  const o = owner.startsWith("0x") || owner.startsWith("0X") ? owner.slice(2) : owner;
  return `${HINT_PREFIX}${o.toLowerCase()}:${topic}`;
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
export async function contentFeedSignerFromPrivKey(privKey: string): Promise<ContentFeedSigner> {
  const { Wallet } = await import("ethers");
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
export async function deriveContentFeedSignerFromSig(signature: string): Promise<ContentFeedSigner> {
  const { keccak256, getBytes, Wallet } = await import("ethers");
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
  /**
   * EXACT version to write, skipping latest-version resolution entirely (each
   * probe past the latest is a network search for a missing chunk — seconds).
   * ONLY safe when the caller can PROVE nothing was ever written at this version:
   * a SOC write at an existing address is silently deduped (old payload kept), so
   * a wrong value here loses the write. In practice: version 0 of a topic keyed by
   * an id minted THIS flow (fresh event ULID), or lastWritten+1 within the same
   * single-writer flow. Anything else must probe.
   */
  knownVersion?: number;
}): Promise<number> {
  const [{ Wallet }, { signAndUploadSoc, probeSoc }] = await Promise.all([
    import("ethers"),
    import("./client-soc.js"),
  ]);
  const key = args.signerPrivKey.startsWith("0x") ? args.signerPrivKey : `0x${args.signerPrivKey}`;
  const owner = new Wallet(key).address.toLowerCase();
  const base = contentFeedSocIdentifier(args.topic);
  const gw = args.gatewayUrl ? { gatewayUrl: args.gatewayUrl } : {};

  let version: number;
  if (args.knownVersion !== undefined) {
    if (!Number.isInteger(args.knownVersion) || args.knownVersion < 0) {
      throw new Error(`invalid knownVersion: ${args.knownVersion}`);
    }
    version = args.knownVersion;
  } else {
    // thorough: the write-path probe MUST see chunks still settling on the
    // public net (Etherna-stamped writes) — a missed version here re-writes an
    // existing immutable SOC and silently loses the edit (see probeSoc).
    const read: SocChunkProbe = (id) => probeSoc(owner, id, { thorough: true });
    const hint = args.versionHint ?? readVersionHint(owner, args.topic);
    const { latest, clean } = await resolveLatestSocVersion(read, (v) => versionedSocIdentifier(base, v), hint);
    // A dirty scan cannot bound the sequence: the version it failed to read may
    // exist, and writing there is a NO-OP that returns 201 and keeps the old
    // payload — the edit is lost, silently, with success reported. Refusing is the
    // only honest option; the caller retries. `thorough` narrows this window (it
    // consults the server on a gateway 404/403) but cannot close it — an API origin
    // answering 5xx/429 leaves nobody who can say whether the chunk is there.
    if (!clean) {
      throw new Error(
        `Content feed version probe was inconclusive for "${args.topic}" — refusing to write ` +
        `(a write at an unverified version is silently discarded). Try again.`,
      );
    }
    version = (latest ?? LEGACY_CONTENT_FEED_VERSION) + 1;
  }

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

/** Tri-state result of a content-feed read. `absent` is the only cacheable negative. */
export type ContentFeedResult<T> =
  | { status: "found"; value: T; version: number }
  | { status: "absent" }
  | { status: "unavailable"; reason?: string };

/**
 * Read + JSON-decode a client-owned content feed by owner + topic, preserving the
 * distinction between "this feed does not exist" and "could not read it". Probes
 * the versioned sequence for the latest update, reassembling multi-chunk pages, and
 * falls back to the legacy pre-versioning fixed identifier so feeds written before
 * the versioning fix stay readable. Multi-chunk aware.
 *
 * Use this — not {@link readContentFeed} — wherever `absent` gets acted on: a
 * durable write, a cached negative, or a security decision.
 */
export async function readContentFeedResult<T>(
  ownerAddress: string,
  topic: string,
): Promise<ContentFeedResult<T>> {
  const { probeSoc } = await import("./client-soc.js");
  const owner = (ownerAddress.startsWith("0x") ? ownerAddress.slice(2) : ownerAddress).toLowerCase();
  const read: SocChunkProbe = (id) => probeSoc(owner, id);
  const res = await readVersionedContentFeed(read, topic, readVersionHint(owner, topic));
  if (res.status !== "found") return res;
  if (res.version >= 0) bumpVersionHint(owner, topic, res.version);
  try {
    return { status: "found", value: JSON.parse(new TextDecoder().decode(res.bytes)) as T, version: res.version };
  } catch {
    // Bytes exist at this identifier but aren't our JSON — corrupt or foreign,
    // never "no feed here". Absent would be a lie a caller could cache.
    return { status: "unavailable", reason: "feed payload is not valid JSON" };
  }
}

/**
 * Lenient wrapper over {@link readContentFeedResult}: the decoded feed, or null for
 * BOTH "absent" and "could not read". Correct only for display paths that re-read
 * on the next visit (profiles, event detail, site pages).
 */
export async function readContentFeed<T>(ownerAddress: string, topic: string): Promise<T | null> {
  const res = await readContentFeedResult<T>(ownerAddress, topic);
  return res.status === "found" ? res.value : null;
}
