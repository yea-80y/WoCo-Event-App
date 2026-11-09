/**
 * `/bytes` at redundancy level 0 - THE way this server sends content-addressed
 * bytes that belong on Etherna, to Etherna or to our bee (#912 slice 2a).
 *
 * WHY LEVEL 0, ALWAYS, ON BOTH. A failover save is stamped on our bee and later
 * re-uploaded to Etherna, and it moves back only if both stores build the same
 * tree for the same bytes. Bee's own default is MEDIUM erasure coding
 * (`redundancy.DefaultUploadLevel`, pkg/file/redundancy/level.go), whatever its
 * docs say: our bee 2.8.3 gave a different reference than Etherna for the same
 * 10,000 bytes with no header, the same one with `Swarm-Redundancy-Level: 0` on
 * both (probe, 2026-11-06). Etherna's bee is plain today and would stop being
 * plain when it upgrades. bee-js drops a falsy level, so this is raw `fetch` with
 * the header written out - `test/etherna-failover-bytes.test.ts` fails if any
 * other code POSTs to `/bytes`, or if this one stops sending it.
 */

import { bytesTreeChunks } from "@woco/shared/swarm/bytes-tree";
import { BEE_URL } from "../../config/swarm.js";
import { ensureEthernaToken, getCachedEthernaToken } from "../etherna/auth.js";
import { noteEthernaFailure } from "../etherna/breaker.js";
import { ETHERNA_FETCH_BASE } from "../etherna/gateway.js";
import {
  CONTROL_JSON_MAX_BYTES,
  SWARM_READ_MAX_BYTES,
  errorSnippet,
  readCapped,
  readCappedJson,
} from "../http/read-capped.js";
import { BEE_CALL_TIMEOUT_MS } from "./upload-queue.js";

export type PlainBytesTarget = "etherna" | "wocoBee";

/**
 * POST `data` to `/bytes` on `target`, stamped by `batchId`, at level 0. Returns
 * the reference the store gave, lowercase, no `0x`. Throws `Error & { status }`
 * on a non-2xx, plain on a timeout or network fault. An Etherna failure that
 * took ETHERNA_SLOW_MS or more pauses Etherna (breaker.ts), as a SOC write does.
 *
 * `deferred`: return once the store holds the chunks and push them in the
 * background (saves), or only once pushed (site deploys, #613).
 */
export async function postPlainBytes(
  target: PlainBytesTarget,
  batchId: string,
  data: Uint8Array,
  opts: { timeoutMs: number; deferred: boolean },
): Promise<string> {
  const toEtherna = target === "etherna";
  const started = performance.now();
  try {
    let auth: Record<string, string> = {};
    if (toEtherna) {
      await ensureEthernaToken();
      const token = getCachedEthernaToken();
      if (!token) throw new Error("Etherna token unavailable");
      auth = { Authorization: `Bearer ${token}` };
    }
    const resp = await fetch(`${toEtherna ? ETHERNA_FETCH_BASE : BEE_URL}/bytes`, {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": "application/octet-stream",
        "Swarm-Postage-Batch-Id": batchId,
        "Swarm-Redundancy-Level": "0",
        "Swarm-Deferred-Upload": opts.deferred ? "true" : "false",
      },
      body: data as unknown as BodyInit,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!resp.ok) {
      const err = new Error(`${toEtherna ? "Etherna" : "bee"} /bytes upload ${resp.status}: ${await errorSnippet(resp, 200)}`) as Error & {
        status?: number;
      };
      err.status = resp.status;
      throw err;
    }
    const { reference } = await readCappedJson<{ reference?: unknown }>(resp, CONTROL_JSON_MAX_BYTES, "/bytes upload");
    if (typeof reference !== "string" || !/^(0x)?[0-9a-fA-F]{64}$/.test(reference)) {
      throw new Error(`${target} /bytes upload answered without a reference`);
    }
    return reference.toLowerCase().replace(/^0x/, "");
  } catch (err) {
    if (toEtherna) noteEthernaFailure(`etherna bytes write: ${(err as Error)?.message ?? String(err)}`, started);
    throw err;
  }
}

/**
 * How long one upload of `size` bytes may take before it counts as failed: a
 * save is one request whatever its size, so a fixed limit made for one chunk
 * would fail a large image over on a merely slow link, or hold the move back of
 * one for ever. 15 s plus 5 s a MB, at most 120 s.
 */
export function plainBytesTimeoutMs(size: number): number {
  return Math.min(15_000 + Math.ceil((size / (1024 * 1024)) * 5_000), 120_000);
}

/**
 * The level-0 root of `data` computed here, or null when the tree is deeper than
 * the one level `bytesTreeChunks` builds (over 512 KiB). A store that answers a
 * different root for small data is not storing a plain tree.
 */
export function plainTreeRoot(data: Uint8Array): string | null {
  if (data.length > 128 * 4096) return null;
  return bytesTreeChunks(data).at(-1)!.address;
}

export type PlainBytesRead =
  | { status: "found"; data: Uint8Array }
  | { status: "absent" }
  | { status: "unavailable"; reason: string };

/**
 * Read `root` back from OUR bee, for the move back to Etherna. Our bee checks
 * every chunk against its address on the way, and the move back is judged by
 * Etherna returning the same root, so nothing here re-hashes. 404 is `absent`;
 * any other failure is `unavailable`, never an answer.
 */
export async function readPlainBytesFromBee(root: string): Promise<PlainBytesRead> {
  try {
    const resp = await fetch(`${BEE_URL}/bytes/${root}`, { signal: AbortSignal.timeout(BEE_CALL_TIMEOUT_MS) });
    if (resp.status === 404) {
      await resp.body?.cancel().catch(() => {});
      return { status: "absent" };
    }
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      return { status: "unavailable", reason: `bee HTTP ${resp.status}` };
    }
    return { status: "found", data: await readCapped(resp, SWARM_READ_MAX_BYTES, "bytes move-back read") };
  } catch (e) {
    return { status: "unavailable", reason: `bee bytes read: ${(e as Error)?.message ?? String(e)}` };
  }
}
