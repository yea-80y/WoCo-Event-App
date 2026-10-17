/**
 * The door scanner's latest build: what the name `scan.<parent>` is answered
 * with (ens-gateway/ccip.ts SCANNER_LABEL).
 *
 * READ FROM THE FEED, NOT FROM A RECORD WRITTEN AT DEPLOY. The scanner is
 * published to its own feed (`woco-scanner-v1`, scripts/upload-scanner-to-swarm.cjs)
 * under the frontend deploy key (SCANNER_FEED_OWNER below), through our own bee.
 * Every update is a SOC whose signature is checked here to recover to that
 * address, and only the deploy holds that key, so the feed already is a record
 * this server can trust.
 * A ledger written at deploy would restate the same fact at the price of a new
 * authenticated route for the laptop script to call, a new `.data` file that
 * must survive restarts, and two sources that can disagree.
 *
 * The name is given the immutable collection the feed points at, never the feed
 * manifest, so whatever serves the name never does a feed lookup of its own.
 *
 * THE HEAD, FOUND BY CHUNK READS. Bee's lookup is a lower bound (feed-index.ts),
 * so it only says where to start: each index from there is read as a chunk until
 * one is absent. Never backwards: a later read that lands short keeps the newer
 * build already seen.
 *
 * MEMO, STALE-WHILE-REVALIDATE. A known build is answered at once and re-read
 * behind it once older than `ttlMs`; a failed read keeps the last good build.
 * Only with nothing known (just after boot) does a caller wait for the read.
 * The last good build is in memory only: losing it at a restart costs one read,
 * and a bee that cannot be read then is refused, never answered with a guess.
 */
import { Topic } from "@ethersphere/bee-js";
import { BEE_URL } from "../../config/swarm.js";
import { MAX_FORWARD_WALK, readFeedUpdate } from "../swarm/feed-index.js";
import { wocoBeeSource, type VerifiedSocRead } from "../swarm/soc-read.js";

/** The scanner feed's topic string. Must match FEED_TOPIC in scripts/upload-scanner-to-swarm.cjs. */
export const SCANNER_FEED_TOPIC = "woco-scanner-v1";
export const SCANNER_BUILD_TTL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 15_000;

/** `uploadReference` (bee-js 11) writes an 8-byte timestamp and then the 32-byte reference. */
const UPDATE_BYTES = 40;
const TIMESTAMP_BYTES = 8;

export interface ScannerFeedReader {
  /** Where bee's feed lookup puts the latest update: a lower bound, or null when it cannot say. */
  lookup(): Promise<bigint | null>;
  /** The update at `index`, its signature checked against the feed's owner. */
  readAt(index: bigint): Promise<VerifiedSocRead>;
}

export interface ScannerBuild {
  /** The immutable collection, 64-hex, no 0x. */
  ref: string;
  index: bigint;
}

export interface ScannerBuildState {
  build: ScannerBuild | null;
  /** When the last read finished, ms. */
  readAt: number | null;
  /** Why the last read failed, in words safe for a public page; null when it did not. */
  error: string | null;
}

/** The collection one feed update names, or null when it is not a scanner build. */
export function scannerRefFromUpdate(payload: Uint8Array): string | null {
  if (payload.length !== UPDATE_BYTES) return null;
  let ref = "";
  for (const b of payload.subarray(TIMESTAMP_BYTES)) ref += b.toString(16).padStart(2, "0");
  return /^0+$/.test(ref) ? null : ref;
}

class ReadFailure extends Error {
  constructor(readonly publicReason: string, detail: string) {
    super(detail);
  }
}

export class ScannerBuildSource {
  private build: ScannerBuild | null = null;
  private readAt: number | null = null;
  private error: string | null = null;
  private inFlight: Promise<ScannerBuildState> | null = null;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(
    private readonly reader: ScannerFeedReader,
    opts: { ttlMs?: number; now?: () => number; log?: (line: string) => void } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? SCANNER_BUILD_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((line) => console.log(line));
  }

  /** For the gateway: the known build, or null when none has ever been read. */
  async current(): Promise<string | null> {
    if (this.readAt === null || this.now() - this.readAt >= this.ttlMs) {
      const reading = this.refresh();
      if (!this.build) await reading;
    }
    return this.build?.ref ?? null;
  }

  /** Read the feed now. One read at a time; never rejects. */
  refresh(): Promise<ScannerBuildState> {
    if (!this.inFlight) {
      this.inFlight = this.read().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  state(): ScannerBuildState {
    return { build: this.build, readAt: this.readAt, error: this.error };
  }

  private async read(): Promise<ScannerBuildState> {
    let found: ScannerBuild | null = null;
    let failure: unknown = null;
    try {
      ({ found, failure } = await this.walk());
    } catch (err) {
      failure = err;
    }
    // Every update `found` names was verified, so it moves the head even when the
    // walk then stopped on a failure. The walk starts past the head, so it is newer.
    if (found) {
      const was = this.build ? ` (was ${this.build.index})` : "";
      this.log(`[scanner] build ${found.ref} at feed index ${found.index}${was}`);
      this.build = found;
    }
    const error = failure === null ? null : failure instanceof ReadFailure ? failure.publicReason : "the scanner feed could not be read";
    if (error !== null && error !== this.error) {
      this.log(`[scanner] feed read failed: ${(failure as Error)?.message ?? String(failure)}`);
    }
    this.error = error;
    this.readAt = this.now();
    return this.state();
  }

  /** The newest update from the known head (or bee's lookup) forward, and what stopped the walk short. */
  private async walk(): Promise<{ found: ScannerBuild | null; failure: ReadFailure | null }> {
    const known = this.build;
    const start = known ? known.index + 1n : ((await this.reader.lookup().catch(() => null)) ?? 0n);
    let found: ScannerBuild | null = null;
    for (let i = start; i < start + BigInt(MAX_FORWARD_WALK); i++) {
      const r = await this.reader.readAt(i);
      if (r.status === "absent") break;
      if (r.status === "unavailable") {
        return { found, failure: new ReadFailure(`bee could not read feed update ${i}`, `update ${i}: ${r.reason}`) };
      }
      const ref = scannerRefFromUpdate(r.soc.payload);
      if (!ref) {
        const why = `update ${i}: ${r.soc.payload.length}-byte payload`;
        return { found, failure: new ReadFailure(`feed update ${i} is not a scanner build`, why) };
      }
      found = { ref, index: i };
    }
    if (!found && !known) {
      const failure = start === 0n
        ? new ReadFailure("the scanner feed has no update", "no update at index 0")
        : new ReadFailure(`bee's lookup named update ${start}, which reads as absent`, `absent at ${start}`);
      return { found, failure };
    }
    return { found, failure: null };
  }
}

/**
 * Who signs the scanner feed: the key `npm run deploy:scanner` uploads with
 * (`scripts/.env` FEED_PRIVATE_KEY, the same key that owns the app frontend feed).
 * It is NOT the server's own platform key (`getPlatformOwner()`), which owns the
 * server-written feeds; reading under that one finds no update at all. Every update
 * is still checked to be signed by this address, so pinning it trusts nothing new.
 */
export const SCANNER_FEED_OWNER = "f8af4904c6e4f08ce5f7deab7f01221280b23a80";

/** Our own bee: the one the scanner deploy writes through. */
export const liveScannerFeedReader: ScannerFeedReader = {
  lookup: async () => {
    const topic = Topic.fromString(SCANNER_FEED_TOPIC);
    const r = await fetch(`${BEE_URL}/feeds/${SCANNER_FEED_OWNER}/${topic.toHex()}`, {
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    await r.body?.cancel().catch(() => {});
    const h = r.headers.get("swarm-feed-index");
    return r.status === 200 && h && /^[0-9a-f]{1,16}$/i.test(h) ? BigInt(`0x${h}`) : null;
  },
  readAt: (index) => readFeedUpdate(SCANNER_FEED_OWNER, Topic.fromString(SCANNER_FEED_TOPIC), index, [wocoBeeSource]),
};

export const scannerBuild = new ScannerBuildSource(liveScannerFeedReader);
