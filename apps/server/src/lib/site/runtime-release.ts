/**
 * The latest site runtime release (#1032), read from its signed feed.
 *
 * Since slice 3 a site built in the browser links this release, and the server
 * admits that site only when it rebuilds the same bytes from the release it holds
 * (lib/site/collection-publish.ts). So the release is verified, not just read:
 * bee's lookup finds the latest index, then the update at that index is read as a
 * raw SOC and its signature must recover to the deploy key (`readVerifiedSoc`),
 * with the same payload bee returned. A version never goes back: below the held
 * one is a lagging replica, and the highest version ever accepted is kept in
 * `.data/site-runtime-high-water.json` so a restart cannot be handed an older,
 * genuinely signed release either. That file present but unreadable stops this
 * cache accepting anything (never overwritten) and turns health red; the
 * builder's old publish path does not depend on it.
 *
 * Kept in memory and refreshed in the background. A failed or malformed read
 * keeps the last good release. `/api/health` is public, so health carries fixed
 * reasons only; the error itself goes to the log.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Topic, type Bee } from "@ethersphere/bee-js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  beeFeedUpdateIdentifier,
  parseSiteRuntimeRelease,
  SITE_RUNTIME_FEED_TOPIC,
  SITE_RUNTIME_RELEASE_OWNER,
  type SiteRuntimeRelease,
} from "@woco/shared";
import { beeErrorMessage, errorStatus } from "../swarm/feeds.js";
import { withTimeout } from "../swarm/upload-queue.js";
import { readVerifiedSoc, wocoBeeSource, type VerifiedSocRead } from "../swarm/soc-read.js";
import { writeJsonAtomic } from "../marketing/persist.js";
import { getBee } from "../../config/swarm.js";

export type RuntimeFeedRead =
  | { status: "ok"; payload: Uint8Array }
  | { status: "absent" }
  | { status: "error"; error: Error };

export const SITE_RUNTIME_REFRESH_MS = 10 * 60_000;
const READ_TIMEOUT_MS = 20_000;

export interface SiteRuntimeHealth {
  /** False only when the high-water file is present but unreadable. */
  ok: boolean;
  configured: boolean;
  version: number | null;
  commit: string | null;
  builtAt: string | null;
  checkedAt: string | null;
  lastError: string | null;
}

/** The highest release version ever accepted: a number, none yet, or a file that cannot be read. */
export interface SiteRuntimeHighWater {
  load(): number | null | "unreadable";
  save(version: number): boolean;
}

/** The high-water mark kept in `file` (default `.data/site-runtime-high-water.json`). */
export function fileHighWater(file = join(process.cwd(), ".data", "site-runtime-high-water.json")): SiteRuntimeHighWater {
  return {
    load() {
      let raw: string;
      try {
        raw = readFileSync(file, "utf-8");
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
      }
      try {
        const v = (JSON.parse(raw) as { version?: unknown }).version;
        return Number.isSafeInteger(v) && (v as number) >= 1 ? (v as number) : "unreadable";
      } catch {
        return "unreadable";
      }
    },
    save: (version) => writeJsonAtomic(file, { v: 1, version }, "site-runtime-high-water"),
  };
}

const memoryHighWater = (): SiteRuntimeHighWater => {
  let v: number | null = null;
  return { load: () => v, save: (n) => ((v = n), true) };
};

export function createSiteRuntimeReleaseCache(
  read: () => Promise<RuntimeFeedRead>,
  now: () => number = Date.now,
  highWater: SiteRuntimeHighWater = memoryHighWater(),
) {
  let release: SiteRuntimeRelease | null = null;
  let checkedAt: number | null = null;
  let lastError: string | null = null;
  let inflight: Promise<void> | null = null;
  // Sticky until a restart: an unreadable file is restored with the server stopped,
  // and is never overwritten meanwhile (a save would replace it with our guess).
  let unreadable = false;
  const markUnreadable = () => {
    if (!unreadable) console.error("[site-runtime] ALARM: site-runtime-high-water.json exists but cannot be read - no release is accepted until it is restored");
    unreadable = true;
    lastError = "high-water file unreadable";
  };
  if (highWater.load() === "unreadable") markUnreadable();

  async function refreshOnce(): Promise<void> {
    if (unreadable) {
      checkedAt = now();
      return;
    }
    const res = await read().catch((e: unknown): RuntimeFeedRead => ({ status: "error", error: e instanceof Error ? e : new Error(String(e)) }));
    checkedAt = now();
    if (res.status === "absent") {
      lastError = release ? "feed read absent, keeping the release held" : null;
      return;
    }
    if (res.status === "error") {
      console.warn("[site-runtime] release feed read failed:", res.error.message);
      lastError = "read failed";
      return;
    }
    let parsed: SiteRuntimeRelease | null = null;
    try {
      parsed = parseSiteRuntimeRelease(JSON.parse(new TextDecoder().decode(res.payload)));
    } catch {
      parsed = null;
    }
    if (!parsed) {
      lastError = "latest descriptor is malformed, keeping the release held";
      return;
    }
    if (release && parsed.version < release.version) {
      lastError = `read version ${parsed.version} below held ${release.version} (lagging replica), ignored`;
      return;
    }
    const mark = highWater.load();
    if (mark === "unreadable") {
      markUnreadable();
      return;
    }
    if (typeof mark === "number" && parsed.version < mark) {
      lastError = `read version ${parsed.version} below the high-water mark ${mark}, ignored`;
      return;
    }
    if (mark !== parsed.version && !highWater.save(parsed.version)) {
      lastError = "could not record the high-water mark, release not accepted";
      return;
    }
    release = parsed;
    lastError = null;
  }

  return {
    /** The release held, without reading (a request never waits on a refresh once one is held). */
    peek(): SiteRuntimeRelease | null {
      return release;
    },
    /** Refresh when older than `maxAgeMs` (one read at a time), then answer from memory. */
    async get(maxAgeMs = SITE_RUNTIME_REFRESH_MS): Promise<SiteRuntimeRelease | null> {
      if (checkedAt === null || now() - checkedAt >= maxAgeMs) {
        inflight ??= refreshOnce().finally(() => { inflight = null; });
        await inflight;
      }
      return release;
    },
    health(): SiteRuntimeHealth {
      return {
        ok: !unreadable,
        configured: release !== null,
        version: release?.version ?? null,
        commit: release?.commit ?? null,
        builtAt: release?.builtAt ?? null,
        checkedAt: checkedAt === null ? null : new Date(checkedAt).toISOString(),
        lastError,
      };
    },
  };
}

/** The release update at `index`, read as a raw SOC from our bee and signature-checked. */
export function verifyReleaseUpdate(index: number): Promise<VerifiedSocRead> {
  const identifier = bytesToHex(beeFeedUpdateIdentifier(SITE_RUNTIME_FEED_TOPIC, index));
  return readVerifiedSoc(SITE_RUNTIME_RELEASE_OWNER.slice(2), identifier, { sources: [wocoBeeSource], heal: false });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * The live read: bee's lookup finds the latest update of the release feed, and
 * the update at that index must verify as the deploy key's own (see the header).
 */
export function beeRuntimeFeedRead(
  bee: () => Bee,
  verify: (index: number) => Promise<VerifiedSocRead> = verifyReleaseUpdate,
): () => Promise<RuntimeFeedRead> {
  return async () => {
    let payload: Uint8Array;
    let index: number;
    try {
      const reader = bee().makeFeedReader(Topic.fromString(SITE_RUNTIME_FEED_TOPIC), SITE_RUNTIME_RELEASE_OWNER.slice(2));
      const res = await withTimeout(reader.downloadPayload(), READ_TIMEOUT_MS, "site runtime release feed");
      payload = res.payload.toUint8Array();
      index = Number(res.feedIndex.toBigInt());
    } catch (err) {
      // Bee's own wording, read the way lookupFeed reads it (lib/swarm/feeds.ts).
      if (errorStatus(err) === 404 && beeErrorMessage(err) === "no update found") return { status: "absent" };
      return { status: "error", error: err instanceof Error ? err : new Error(String(err)) };
    }
    const verified = await verify(index).catch((e: unknown): VerifiedSocRead => ({ status: "unavailable", reason: String(e) }));
    if (verified.status !== "found") {
      return { status: "error", error: new Error(`release update ${index} did not verify (${verified.status === "unavailable" ? verified.reason : "absent"})`) };
    }
    if (!sameBytes(verified.soc.payload, payload)) {
      return { status: "error", error: new Error(`release update ${index}: the verified payload differs from the feed read`) };
    }
    return { status: "ok", payload };
  };
}

/** The process-wide cache, refreshed in the background (index.ts) and read by the route and health. */
export const siteRuntimeReleases = createSiteRuntimeReleaseCache(beeRuntimeFeedRead(getBee), Date.now, fileHighWater());
