/**
 * `/bytes` at a redundancy level WE name - THE way this server sends
 * content-addressed bytes that belong on Etherna, to Etherna or to our bee (#912
 * slice 2a).
 *
 * WHY THE LEVEL IS ALWAYS WRITTEN OUT, THE SAME ON BOTH. A failover save is
 * stamped on our bee and later re-uploaded to Etherna, and it moves back only if
 * both stores build the same tree for the same bytes. Left to themselves they do
 * not: bee's own default is MEDIUM erasure coding (`redundancy.DefaultUploadLevel`,
 * pkg/file/redundancy/level.go), Etherna's is none (probes, 2026-11-06 and 11-20).
 * Named, they agree: level 0 and level 1 each gave one root on both stores for
 * one chunk, 100 KB and 600 KB (two tree levels; 2026-11-21, bee 2.8.3). bee-js
 * drops a falsy level, so this is raw `fetch` with the header written out -
 * `test/etherna-failover-bytes.test.ts` fails if any other code POSTs to `/bytes`,
 * or if this one stops sending it.
 *
 * WHICH LEVEL: `saveLevel`. Level 1 is repair data: Reed-Solomon parity inside a
 * file of more than one chunk (which changes its address), and for every file two
 * dispersed replicas of its root chunk, which a default `GET /bytes` or `/bzz` on
 * a bee falls back to (`GET /chunks` does not).
 */

import { bytesTreeChunks } from "@woco/shared/swarm/bytes-tree";
import { SOC_MAX_PAYLOAD_SIZE } from "@woco/shared/swarm/soc";
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

/** 0: a plain tree, the address a caller can compute. 1: with repair data. */
export type SaveLevel = 0 | 1;

/**
 * THE rule for a save meant for Etherna, on every leg. Level 1, except a file of
 * more than one chunk whose address the caller already computed (`addressFixed`: a
 * deploy part built in the browser and rebuilt here): parity would move it to an
 * address neither computed. A one-chunk file has the same address at both levels,
 * so it always gets its replicas.
 */
export function saveLevel(size: number, addressFixed: boolean): SaveLevel {
  return addressFixed && size > SOC_MAX_PAYLOAD_SIZE ? 0 : 1;
}

/**
 * POST `data` to `/bytes` on `target`, stamped by `batchId`, at `level`. Returns
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
  opts: { level: SaveLevel; timeoutMs: number; deferred: boolean },
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
        "Swarm-Redundancy-Level": String(opts.level),
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
 * the one level `bytesTreeChunks` builds (over 512 KiB). A one-chunk file has this
 * root at any level; a larger one has it at level 0 only, so a store answering it
 * to a level-1 save has left the repair data out.
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
 * any other failure is `unavailable`, never an answer. Through `/bytes`, never
 * `/chunks`: a root our bee can only reach by its replicas answers here.
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
