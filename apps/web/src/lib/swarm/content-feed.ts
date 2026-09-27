/**
 * Client-owned content feeds (Phase B — CLIENT_FEED_SIGNER_HANDOVER.md Task 2).
 *
 * A content feed (profile, event, site) becomes a fixed-identifier Single-Owner
 * Chunk SIGNED by the user's own content-feed key — so the USER owns the feed.
 * The server only stamps+uploads it (`postSignedSoc` → `/api/swarm/soc`), so
 * there is no added latency vs the old server-write (signing is local) and the
 * stamp step is a swappable transport (per-user batch / browser-Bee later).
 *
 * The feed-signer key is SIGN-TO-DERIVED: keccak256 of a deterministic,
 * domain-separated EIP-712 signature (`FEED_SIGNER_DERIVE_DOMAIN`) — the SAME
 * construction as the identity seed, differing only in the domain signed, so the two
 * keys are cryptographically independent. Once established it is persisted (and,
 * for credentials that rotate, escrowed) and restored verbatim; the stored key
 * always wins. Reads resolve by computed chunk address (Etherna-safe — never
 * `/feeds`).
 */

// ethers, soc-sign (bee-js), client-soc and probe-soc are imported lazily inside each function —
// this module is statically reachable from api/events + api/profiles at first
// paint, and top-level imports here would drag both libraries into the boot
// bundle.
import { countEscalation, countHint } from "./probe-stats.js";
import type { FeedRoute } from "./gateways.js";
import type { SignedSocBody } from "./soc-sign.js";
import {
  CONTENT_FEED_MC_MARKER,
  contentFeedSocIdentifier,
  isContentFeedManifest,
  versionedSocIdentifier,
  versionedPageIdentifier,
  resolveLatestSocVersion,
  resolveBandedHead,
  assembleContentFeed,
  readVersionedContentFeed,
  LEGACY_CONTENT_FEED_VERSION,
  type ContentFeedManifest,
  type SocChunkProbe,
  type SocReadOutcome,
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

/**
 * The stored hint, or null when there is none. Version 0 IS a hint (#689): it
 * says this device wrote or read version 0, which is what lets a first like be
 * read back before our bee has it (see `knownChunkProbe`).
 */
function readVersionHint(owner: string, topic: string): number | null {
  try {
    const v = globalThis.localStorage?.getItem(hintKey(owner, topic));
    if (v === null || v === undefined) return null;
    const n = parseInt(v, 10);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** Store a version hint, only ever RAISING it (a lower value would skip real updates). */
function bumpVersionHint(owner: string, topic: string, version: number): void {
  try {
    if (version < 0) return;
    const current = readVersionHint(owner, topic);
    if (current === null || version > current) {
      globalThis.localStorage?.setItem(hintKey(owner, topic), String(version));
    }
  } catch {
    /* ignore — hint is best-effort */
  }
}

/** Drop a hint whose version exists nowhere, so it stops costing a server read. */
function forgetVersionHint(owner: string, topic: string): void {
  try {
    globalThis.localStorage?.removeItem(hintKey(owner, topic));
  } catch {
    /* ignore — hint is best-effort */
  }
}

const idHex = (id: Uint8Array): string => {
  let s = "";
  for (const x of id) s += x.toString(16).padStart(2, "0");
  return s;
};

/**
 * A probe that does not take our gateway's "not found" for an answer about a
 * chunk this device KNOWS exists, and asks the server instead (#689).
 *
 * A display read trusts our gateway's 404, which is the cheap path it needs:
 * most reads are of chunks that do not exist. But a version this device wrote
 * or already read exists by construction (the hint is bumped only after the
 * upload was accepted or the bytes verified), so a 404 on it means only that our
 * bee has not got it yet - which for an Etherna-stamped version lasts seconds to
 * minutes. Without this the device that just liked something reads its own like
 * back as "not liked". The extra request is paid only in that window.
 *
 * `known` names those chunks; a thorough re-ask that still finds nothing means
 * the chunk is gone (or the hint was wrong), and `onGone` lets the caller drop
 * the hint so it is not asked about again on every read.
 */
function knownChunkProbe(
  probeSoc: typeof import("./probe-soc.js").probeSoc,
  owner: string,
  route: FeedRoute,
  thorough: boolean | undefined,
  known: (id: Uint8Array) => boolean,
  onGone: (id: Uint8Array) => void = () => undefined,
): SocChunkProbe {
  // Chunks are immutable, so a chunk this read already found is not asked for
  // again: the resolver finds the head, then the assembler reads the same
  // address - which in the lag window was a second server round trip.
  const found = new Map<string, SocReadOutcome>();
  return async (id) => {
    const key = idHex(id);
    const seen = found.get(key);
    if (seen) return seen;
    let outcome = await probeSoc(owner, id, { thorough, gatewayUrl: route.gatewayUrl });
    if (!thorough && outcome.status === "absent" && known(id)) {
      countEscalation();
      outcome = await probeSoc(owner, id, { thorough: true, gatewayUrl: route.gatewayUrl });
      // Only a definite answer drops the hint: "could not ask" keeps it.
      if (outcome.status === "absent") onGone(id);
    }
    if (outcome.status === "found") found.set(key, outcome);
    return outcome;
  };
}

/** How a signed chunk leaves the client (`postSignedSoc` in production). The
 *  gateway and family are required: every write here names its route's. The
 *  family tells the relay which batch pays (`FEED_FAMILY_POLICY` in shared). */
export type SocTransport = (body: SignedSocBody & { gatewayUrl: string; family: string }) => Promise<unknown>;

export interface ContentFeedSigner {
  /** secp256k1 private key (0x-prefixed). */
  privKey: string;
  /** Lowercased owner address — the SOC owner / registry value. */
  address: string;
}

/**
 * Build a `ContentFeedSigner` from a private key that already exists — an
 * escrow-restored one, or one handed in by a caller that derived it. This
 * performs NO derivation of its own; it only recovers the address.
 *
 * The live construction is `deriveFeedSignerKey(seed)` in
 * `@woco/shared` (crypto/feed-signer.ts): the signer is an HKDF sibling of the
 * account seed, so there is no separate secret to store and no "stored copy
 * wins" rule to keep — same seed, same owner, every device.
 */
export async function contentFeedSignerFromPrivKey(privKey: string): Promise<ContentFeedSigner> {
  const { Wallet } = await import("ethers");
  const key = privKey.startsWith("0x") ? privKey : `0x${privKey}`;
  return { privKey: key, address: new Wallet(key).address.toLowerCase() };
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
 * `route` selects the batch that pays for the stamp and the node the version probe
 * asks - see {@link FeedRoute}.
 */
export async function writeContentFeed(args: {
  signerPrivKey: string;
  topic: string;
  data: unknown;
  route: FeedRoute;
  /**
   * Test seam: where the signed chunk goes. Production leaves it unset and posts
   * to our server (`postSignedSoc`), whose authenticated client cannot load
   * under node. The chunk is signed here either way.
   */
  transport?: SocTransport;
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
  const [{ Wallet }, { probeSoc }, { signSoc }, post] = await Promise.all([
    import("ethers"),
    import("./probe-soc.js"),
    import("./soc-sign.js"),
    args.transport ?? import("./client-soc.js").then((m): SocTransport => m.postSignedSoc),
  ]);
  const key = args.signerPrivKey.startsWith("0x") ? args.signerPrivKey : `0x${args.signerPrivKey}`;
  const owner = new Wallet(key).address.toLowerCase();
  const base = contentFeedSocIdentifier(args.topic);
  const put = (identifier: Uint8Array, payload: Uint8Array) =>
    post({
      ...signSoc({ signerPrivKey: key, identifier, payload }),
      gatewayUrl: args.route.gatewayUrl,
      family: args.route.family,
    });

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
    // The route rides along so the server's fallback asks Etherna for an
    // Etherna-stamped feed — the head this writer just wrote may sit only there
    // for a few seconds — and answers unavailable (→ refuse below) rather than
    // absent when Etherna cannot be asked (#156).
    const read: SocChunkProbe = (id) => probeSoc(owner, id, { thorough: true, gatewayUrl: args.route.gatewayUrl });
    const hint = args.versionHint ?? readVersionHint(owner, args.topic) ?? 0;
    const { latest, clean, hintGiven, hintValidated } =
      await resolveLatestSocVersion(read, (v) => versionedSocIdentifier(base, v), hint);
    // The write path resolves with a hint exactly as the read path does, and was
    // never counted — so a first lap that missed 24 times reported
    // `hints 0 used / 0 cold / 0 INVALIDATED`. The instrument was blind on the
    // most expensive path in the rail.
    countHint(!hintGiven ? "noHint" : hintValidated ? "hintUsed" : "hintInvalidated");
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
    await put(versionedSocIdentifier(base, version), json);
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
      return put(versionedPageIdentifier(base, version, i + 1), slice);
    }),
  );
  const manifest: ContentFeedManifest = { [CONTENT_FEED_MC_MARKER]: 1, pages, len: json.length };
  await put(versionedSocIdentifier(base, version), new TextEncoder().encode(JSON.stringify(manifest)));
  bumpVersionHint(owner, args.topic, version);
  return version;
}

/** Tri-state result of a content-feed read. `absent` is the only cacheable negative. */
export type ContentFeedResult<T> =
  | {
      status: "found";
      value: T;
      version: number;
      /** Whether the version scan that chose this version was conclusive. A
       *  read-modify-write MUST refuse when false — see `VersionedFeedRead`. */
      scanClean: boolean;
    }
  | { status: "absent" }
  | {
      status: "unavailable";
      reason?: string;
      /**
       * The version that exists and will never read — see `VersionedFeedRead`.
       * Absent means "could not read right now"; present means a retry can only
       * fail the same way, so the only way forward is to write past it.
       */
      unusableAt?: number;
    };

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
  /** `route`: where this feed is stamped - see {@link FeedRoute}. */
  opts: { route: FeedRoute; skipLegacy?: boolean; thorough?: boolean },
): Promise<ContentFeedResult<T>> {
  const { probeSoc } = await import("./probe-soc.js");
  const owner = (ownerAddress.startsWith("0x") ? ownerAddress.slice(2) : ownerAddress).toLowerCase();
  // `thorough` — REQUIRED by the contract in this function's own docstring:
  // "use this wherever `absent` gets acted on: a durable write, a cached
  // negative, or a security decision." Since the reader may now treat a tagged
  // gateway 403 as absent (probe-soc.ts), those three cases can no longer take
  // the gate's word for it, and a caller that acts on absence must say so.
  // Ordinary display reads leave it off and keep the cheap path.
  const hint = readVersionHint(owner, topic);
  const hinted = hint === null ? null : idHex(versionedSocIdentifier(contentFeedSocIdentifier(topic), hint));
  const read = knownChunkProbe(probeSoc, owner, opts.route, opts.thorough,
    (id) => idHex(id) === hinted, () => forgetVersionHint(owner, topic));
  // Counted from what the RESOLVER did, not from what we handed it. A stored
  // hint whose version does not resolve restarts the scan from 0, so counting
  // the hint's existence would report the expensive case as the cheap one —
  // which is exactly the bug this instrument had.
  const res = await readVersionedContentFeed(read, topic, hint ?? 0, {
    skipLegacy: opts.skipLegacy,
    // A found manifest's pages were uploaded before it, so they exist.
    readPage: knownChunkProbe(probeSoc, owner, opts.route, opts.thorough, () => true),
    onScan: (d) => {
      countHint(!d.hintGiven ? "noHint" : d.hintValidated ? "hintUsed" : "hintInvalidated");
    },
  });
  if (res.status !== "found") return res;
  if (res.version >= 0) bumpVersionHint(owner, topic, res.version);
  try {
    return {
      status: "found",
      value: JSON.parse(new TextDecoder().decode(res.bytes)) as T,
      version: res.version,
      scanClean: res.scanClean,
    };
  } catch {
    // Bytes exist at this identifier but aren't our JSON — corrupt or foreign,
    // never "no feed here". Absent would be a lie a caller could cache, and
    // "try again" would be a lie too: these bytes are immutable, so this version
    // is spent and only a write past it can move the feed on. Unless the scan
    // was dirty: then this may not be the head, and a retry is the honest answer.
    const reason = "feed payload is not valid JSON";
    return res.scanClean ? { status: "unavailable", reason, unusableAt: res.version } : { status: "unavailable", reason };
  }
}

/**
 * Read ONE known version of a content feed, with no version resolution at all.
 *
 * For walking a feed whose versions are a SEQUENCE the caller already knows the
 * bounds of — an append-only log being scanned end to end, where every address
 * is known to exist by construction. Every read is an exact-address hit, so the
 * walk costs no missing-chunk searches, which are the expensive read on Swarm.
 *
 * `scanClean` is true on a hit because no scan chose this version — the caller
 * did. That is not a claim that the caller's bounds were right; a walk driven by
 * a stale head simply stops early, and a walk feeding a write decision must have
 * resolved that head with `thorough` for its own reasons.
 */
export async function readContentFeedAtVersion<T>(
  ownerAddress: string,
  topic: string,
  version: number,
  /** `route`: see {@link FeedRoute}. */
  opts: { route: FeedRoute; thorough?: boolean },
): Promise<ContentFeedResult<T>> {
  if (!Number.isInteger(version) || version < 0) {
    return { status: "unavailable", reason: `invalid version ${version}` };
  }
  const { probeSoc } = await import("./probe-soc.js");
  const owner = (ownerAddress.startsWith("0x") ? ownerAddress.slice(2) : ownerAddress).toLowerCase();
  const read: SocChunkProbe = (id) => probeSoc(owner, id, { thorough: opts.thorough, gatewayUrl: opts.route.gatewayUrl });
  const base = contentFeedSocIdentifier(topic);

  const asm = await assembleContentFeed(
    read,
    versionedSocIdentifier(base, version),
    (page) => versionedPageIdentifier(base, version, page),
  );
  if (asm.status === "absent") return { status: "absent" };
  if (asm.status !== "found") {
    const reason = `version ${version} did not resolve`;
    return asm.unusable
      ? { status: "unavailable", reason, unusableAt: version }
      : { status: "unavailable", reason };
  }
  try {
    return {
      status: "found",
      value: JSON.parse(new TextDecoder().decode(asm.bytes)) as T,
      version,
      scanClean: true,
    };
  } catch {
    return { status: "unavailable", reason: "feed payload is not valid JSON", unusableAt: version };
  }
}

/**
 * Lenient wrapper over {@link readContentFeedResult}: the decoded feed, or null for
 * BOTH "absent" and "could not read". Correct only for display paths that re-read
 * on the next visit (profiles, event detail, site pages).
 */
export async function readContentFeed<T>(
  ownerAddress: string,
  topic: string,
  /** `route`: see {@link FeedRoute}. */
  opts: { route: FeedRoute; skipLegacy?: boolean },
): Promise<T | null> {
  const res = await readContentFeedResult<T>(ownerAddress, topic, opts);
  return res.status === "found" ? res.value : null;
}

// ---------------------------------------------------------------------------
// Banded feeds
// ---------------------------------------------------------------------------

const BAND_HINT_PREFIX = "woco:cfb:"; // content-feed band

/** Band hints key off band 0's topic — the stable identity of the whole family. */
function bandHintKey(owner: string, topicForBand: (band: number) => string): string {
  const o = owner.startsWith("0x") || owner.startsWith("0X") ? owner.slice(2) : owner;
  return `${BAND_HINT_PREFIX}${o.toLowerCase()}:${topicForBand(0)}`;
}

function readBandHint(owner: string, topicForBand: (band: number) => string): number {
  try {
    const v = globalThis.localStorage?.getItem(bandHintKey(owner, topicForBand));
    const n = v ? parseInt(v, 10) : 0;
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Only ever RAISES — a lower value would send readers back through old bands. */
function bumpBandHint(owner: string, topicForBand: (band: number) => string, band: number): void {
  try {
    if (band <= 0) return;
    if (band > readBandHint(owner, topicForBand)) {
      globalThis.localStorage?.setItem(bandHintKey(owner, topicForBand), String(band));
    }
  } catch {
    /* ignore — hint is best-effort */
  }
}

export type BandedContentFeedResult<T> = ContentFeedResult<T> & {
  band: number;
  /**
   * Whether the WHOLE resolution — the band walk AND the in-band version scan —
   * answered definitively. One flag rather than two, because no caller wants to
   * act on half of it.
   *
   * Who must care, and who need not: a READ-MODIFY-WRITE of a snapshot must
   * refuse when this is false, because its writer probes for a fresh address
   * independently, finds the real latest, and lands the stale snapshot there —
   * verified, with everything added since silently erased. An EXACT-ADDRESS
   * write (a lap) may proceed: a stale target already exists, so the write
   * dedupes, the read-back reports `superseded`, and the retry rail handles it.
   *
   * Kept apart from the read's own status on purpose: the head can be `found`
   * and perfectly readable while the resolution that chose it was inconclusive.
   */
  bandClean: boolean;
};

/**
 * Read the head of a BANDED feed, resolving which band is open first.
 *
 * A banded feed is one topic per {@link STATEMENT_BAND_SIZE} versions rather
 * than one unbounded topic, so a read costs a bounded in-band scan instead of a
 * probe per lifetime write. `hintBand` is a lower bound: pass the band recorded
 * in a subject index (credits, where the partition rule makes that read
 * mandatory anyway so the band rides free), or omit it and let the opener walk
 * find it (social, which has no index read to carry one).
 *
 * `skipLegacy` is forced on: banded feeds are strictly newer than the
 * pre-versioning scheme, so a legacy chunk cannot exist and probing for one
 * would spend a guaranteed missing-chunk network search per absent read.
 */
export async function readBandedContentFeed<T>(
  ownerAddress: string,
  topicForBand: (band: number) => string,
  /** `route`: see {@link FeedRoute}. */
  opts: { route: FeedRoute; hintBand?: number; thorough?: boolean },
): Promise<BandedContentFeedResult<T>> {
  const { probeSoc } = await import("./probe-soc.js");
  const owner = (ownerAddress.startsWith("0x") ? ownerAddress.slice(2) : ownerAddress).toLowerCase();
  // `thorough` is REQUIRED of any caller whose result feeds a read-modify-write
  // of a whole snapshot. Such a writer probes for a fresh address independently
  // of the resolution we hand it, so a false ABSENT here does not collide and
  // get caught — it lands a fresh snapshot at the real latest version, VERIFIES,
  // and erases every entry added since. Nothing detects it.
  //
  // This became load-bearing when the reader started trusting a tagged 403 as
  // absent (probe-soc.ts): the gate is authoritative only while its whitelist
  // is complete, and a lost entry would otherwise read as a CLEAN absent —
  // clean being exactly what the `bandClean`/`scanClean` guards check. Thorough
  // reads keep consulting the server, so they cannot be fooled by the gate.
  //
  // Display and head reads do NOT need it: a lap is an exact-address write, so
  // staleness collides, Bee dedupes, and the read-back reports `superseded`.
  // SCAN-FIRST. Resolving the band by walking openers first spent its whole
  // probe window on every read, and a probe past the last opened band is a
  // missing-chunk search. Scanning the hinted band first means a band that is
  // not full proves — by the full-band invariant — that no higher band exists,
  // so the warm path probes no openers at all.
  const hintBand = Math.max(opts.hintBand ?? 0, readBandHint(owner, topicForBand));

  // The versions this device knows exist: the hinted version of the hinted band,
  // and of the band above it - a rollover WRITE stores version 0 of the new band
  // but no band hint (the writer knows nothing of bands), and that opener is
  // exactly what a stale read would miss. See `knownChunkProbe`.
  const known = new Map<string, string>();
  for (const band of [hintBand, hintBand + 1]) {
    const topic = topicForBand(band);
    const v = readVersionHint(owner, topic);
    if (v !== null) known.set(idHex(versionedSocIdentifier(contentFeedSocIdentifier(topic), v)), topic);
  }
  const read = knownChunkProbe(probeSoc, owner, opts.route, opts.thorough,
    (id) => known.has(idHex(id)),
    (id) => { const topic = known.get(idHex(id)); if (topic) forgetVersionHint(owner, topic); });

  const head = await resolveBandedHead(read, topicForBand, hintBand, (band) =>
    readVersionHint(owner, topicForBand(band)) ?? 0);

  // Counted HERE, from what the resolution did, and not on the found path below.
  // It used to sit after the `found` return, so a read that resolved ABSENT
  // contributed no hint state at all — and "a stored hint whose version reads as
  // absent" is one of the exact shapes `hintInvalidated` exists to catch. The
  // alarm could not fire for it. Same placement principle as
  // `readContentFeedResult`, which counts from inside the resolver via `onScan`.
  countHint(!head.hintGiven ? "noHint" : head.hintInvalidated ? "hintInvalidated" : "hintUsed");

  if (head.latest === null) {
    // Clean means the feed genuinely does not exist; otherwise nobody could
    // answer, which a caller must never cache as absence.
    return head.clean
      ? { status: "absent", band: head.band, bandClean: true }
      : { status: "unavailable", reason: "band resolution inconclusive", band: head.band, bandClean: false };
  }

  // Read at the EXACT version already resolved, rather than re-resolving through
  // `readContentFeedResult` — the resolution above is the expensive part and
  // doing it twice is what the reorder exists to stop.
  const topic = topicForBand(head.band);
  const base = contentFeedSocIdentifier(topic);
  const asm = await assembleContentFeed(
    read,
    versionedSocIdentifier(base, head.latest),
    (page) => versionedPageIdentifier(base, head.latest as number, page),
    // A found manifest's pages were uploaded before it, so they exist.
    knownChunkProbe(probeSoc, owner, opts.route, opts.thorough, () => true),
  );
  if (asm.status !== "found") {
    // The resolution just confirmed this version PRESENT, so an absent re-read is
    // a contradiction, never evidence the feed is empty.
    return {
      status: "unavailable",
      reason: asm.status === "absent" ? `version ${head.latest} vanished between probe and read` : asm.reason,
      band: head.band,
      bandClean: false,
    };
  }

  bumpBandHint(owner, topicForBand, head.band);
  bumpVersionHint(owner, topic, head.latest);

  try {
    return {
      status: "found",
      value: JSON.parse(new TextDecoder().decode(asm.bytes)) as T,
      version: head.latest,
      scanClean: head.clean,
      band: head.band,
      bandClean: head.clean,
    };
  } catch {
    return { status: "unavailable", reason: "feed payload is not valid JSON", band: head.band, bandClean: false };
  }
}
