/**
 * The boot canary for level-1 saves.
 *
 * A failover copy of a multi-chunk file moves back only if Etherna builds, at
 * level 1, the tree our bee built - and nothing here can compute that tree's
 * root, so a save cannot be checked as it is made (`saveForEtherna`). Either
 * side changing how it codes (an upgrade) would show only when an outage's
 * copies never moved back. So four fixed files are saved to Etherna once per
 * boot and its answers compared with the roots OUR BEE gave for the same bytes:
 * one chunk; one parent; a full parent of 119 chunks and one carried chunk
 * beside it; two parents.
 *
 * Etherna's side is checked here, every boot. Our bee's side is pinned by its
 * version: the roots are from bee 2.8.3 (2026-11-21, both stores agreed), and
 * the same test must be run again when our bee is upgraded. The same bytes
 * stamped again on one batch take no new slots (measured, `/bytes`), so a boot
 * costs the platform batch nothing after the first (345 chunks).
 *
 * A run that fails slowly pauses Etherna for 30 s like any slow Etherna failure
 * (breaker.ts): with the failover on, saves in that window are stamped on WoCo
 * and moved back.
 */

import { createHash } from "node:crypto";
import { platformEthernaBatch } from "./batch-router.js";
import { ethernaPaused } from "./breaker.js";
import { noteCanaryRun, noteTreeMismatch } from "./failover.js";
import { plainBytesTimeoutMs, postPlainBytes } from "../swarm/plain-bytes.js";

/** FROZEN with `canaryBytes`: changing either means measuring the roots again on both stores. */
export const LEVEL1_CANARY: ReadonlyArray<{ size: number; root: string }> = [
  { size: 3000, root: "ce7f28b2b1a2692a54e9c1a4d697ad9ee488711b2a2e8fa5c7f6082cd80d8a83" },
  { size: 102_400, root: "59ee33e100ce68cf97870353e5efb9bae91eaffa737721f2663b0a0c4cf5c33d" },
  { size: 491_520, root: "b84a6d2b9339d649c01753682d1de64da115db902f40cff8ae4a97eb11c2a4e1" },
  { size: 614_400, root: "0babb408ae76193dddd716fb65c9809e04482adf0dfac71270fbe55126ed1149" },
];

/** A sha256 chain from a fixed seed: bytes no user file has, the same on every boot. */
export function canaryBytes(size: number): Uint8Array {
  const out = Buffer.alloc(size);
  let h = createHash("sha256").update(`woco-level1-canary-v1:${size}`).digest();
  for (let off = 0; off < size; off += 32) {
    h.copy(out, off, 0, Math.min(32, size - off));
    h = createHash("sha256").update(h).digest();
  }
  return out;
}

type Post = (batchId: string, data: Uint8Array) => Promise<string>;
const livePost: Post = (batchId, data) =>
  postPlainBytes("etherna", batchId, data, { level: 1, timeoutMs: plainBytesTimeoutMs(data.length), deferred: true });

/**
 * One run. False when it could not be made (no batch that takes writes, Etherna
 * paused or failing): nothing is concluded and the caller tries again. True once
 * every file was answered - a root that differs has raised `plainTree`.
 */
export async function runLevel1Canary(post: Post = livePost): Promise<boolean> {
  if (ethernaPaused() !== null) return false;
  const answers: string[] = [];
  try {
    // Throws while the platform batch cannot take a write (#610): nothing is sent.
    const { batchId } = platformEthernaBatch();
    for (const { size } of LEVEL1_CANARY) answers.push(await post(batchId, canaryBytes(size)));
  } catch (err) {
    console.warn(`[etherna-failover] level-1 canary could not run, will retry: ${(err as Error)?.message ?? err}`);
    return false;
  }
  let ok = true;
  LEVEL1_CANARY.forEach(({ size, root }, i) => {
    if (answers[i] === root) return;
    ok = false;
    noteTreeMismatch(size, `Etherna answered the level-1 canary at ${answers[i]!.slice(0, 12)}…, our bee gave ${root.slice(0, 12)}…`);
  });
  noteCanaryRun(ok);
  console.log(`[etherna-failover] level-1 canary: ${ok ? "Etherna builds the trees our bee builds" : "MISMATCH - see /api/health ethernaFailover.plainTree"}`);
  return true;
}

export const CANARY_FIRST_DELAY_MS = 60 * 1000;
export const CANARY_RETRY_MS = 5 * 60 * 1000;

/**
 * At boot, when this server saves to Etherna at all. Tries until one run completes.
 * Never on a dev server (`DIRECTORY_PUBLISH=off`, the dev scripts' mark): it holds
 * the production Etherna key, and a laptop has no business posting there unasked.
 */
export function startLevel1Canary(): void {
  if (process.env.ETHERNA_ENABLED !== "true" || !process.env.ETHERNA_PLATFORM_BATCH) return;
  if (process.env.DIRECTORY_PUBLISH === "off") return;
  const attempt = () => {
    void runLevel1Canary().then((ran) => {
      if (!ran) setTimeout(attempt, CANARY_RETRY_MS).unref();
    });
  };
  setTimeout(attempt, CANARY_FIRST_DELAY_MS).unref();
}
