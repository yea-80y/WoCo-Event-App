/**
 * The latest site runtime release (#1032), read from its signed feed.
 *
 * Discovery only: the builder offers "runtime update" from it, and (slice 3) the
 * server's publish admission takes its allowed addresses from it. The feed is
 * signed by the frontend deploy key; bee checks the SOC signature against the
 * owner we ask for, so a descriptor read here is ours by construction.
 *
 * Kept in memory and refreshed in the background. A failed or malformed read
 * keeps the last good release; a lower version than the one held is a lagging
 * replica, never a rollback, and is ignored.
 */

import { Topic, type Bee } from "@ethersphere/bee-js";
import {
  parseSiteRuntimeRelease,
  SITE_RUNTIME_FEED_TOPIC,
  SITE_RUNTIME_RELEASE_OWNER,
  type SiteRuntimeRelease,
} from "@woco/shared";
import { beeErrorMessage, errorStatus } from "../swarm/feeds.js";
import { getBee } from "../../config/swarm.js";

export type RuntimeFeedRead =
  | { status: "ok"; payload: Uint8Array }
  | { status: "absent" }
  | { status: "error"; error: Error };

export const SITE_RUNTIME_REFRESH_MS = 10 * 60_000;
const READ_TIMEOUT_MS = 20_000;

export interface SiteRuntimeHealth {
  /** Informational until publishing depends on a release (slice 3). */
  ok: true;
  configured: boolean;
  version: number | null;
  commit: string | null;
  builtAt: string | null;
  checkedAt: string | null;
  lastError: string | null;
}

export function createSiteRuntimeReleaseCache(read: () => Promise<RuntimeFeedRead>, now: () => number = Date.now) {
  let release: SiteRuntimeRelease | null = null;
  let checkedAt: number | null = null;
  let lastError: string | null = null;
  let inflight: Promise<void> | null = null;

  async function refreshOnce(): Promise<void> {
    const res = await read().catch((e: unknown): RuntimeFeedRead => ({ status: "error", error: e instanceof Error ? e : new Error(String(e)) }));
    checkedAt = now();
    if (res.status === "absent") {
      lastError = release ? "feed read absent, keeping the release held" : null;
      return;
    }
    if (res.status === "error") {
      lastError = `read failed: ${res.error.message}`;
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
    release = parsed;
    lastError = null;
  }

  return {
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
        ok: true,
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

/** The live read: the latest update of the release feed on our bee, under the deploy key. */
export function beeRuntimeFeedRead(bee: () => Bee): () => Promise<RuntimeFeedRead> {
  return async () => {
    try {
      const reader = bee().makeFeedReader(Topic.fromString(SITE_RUNTIME_FEED_TOPIC), SITE_RUNTIME_RELEASE_OWNER.slice(2));
      const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("feed read timed out")), READ_TIMEOUT_MS).unref());
      const res = await Promise.race([reader.downloadPayload(), timeout]);
      return { status: "ok", payload: res.payload.toUint8Array() };
    } catch (err) {
      // Bee's own wording, read the way lookupFeed reads it (lib/swarm/feeds.ts).
      if (errorStatus(err) === 404 && beeErrorMessage(err) === "no update found") return { status: "absent" };
      return { status: "error", error: err instanceof Error ? err : new Error(String(err)) };
    }
  };
}

/** The process-wide cache, refreshed in the background (index.ts) and read by the route and health. */
export const siteRuntimeReleases = createSiteRuntimeReleaseCache(beeRuntimeFeedRead(getBee));
