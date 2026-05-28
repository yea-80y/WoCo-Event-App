import { getBee, requirePostageBatch } from "../../config/swarm.js";
import { ensureEthernaToken } from "../etherna/auth.js";
import { BEE_CALL_TIMEOUT_MS, beeUploadSem, withTimeout } from "./upload-queue.js";
import type { Hex64 } from "@woco/shared";

/** Delay helper */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Classify a thrown error as a transient network/Bee fault that's worth
 * retrying. Bee's chain-RPC backpressure (free-tier dRPC throttling, brief
 * peer churn) shows up as TCP-level resets — `socket hang up`, `ECONNRESET`,
 * `ETIMEDOUT` — surfaced by axios with no HTTP `status`. Treat 5xx the same
 * way; only 4xx other than 429 are real client errors.
 */
function isTransientSwarmError(err: unknown): boolean {
  const e = err as any;
  const status: number | undefined = e?.status ?? e?.response?.status;
  if (status === 429) return true;
  if (status && status >= 500) return true;
  if (status === undefined) {
    const msg = String(e?.message ?? "").toLowerCase();
    const code = String(e?.code ?? "").toUpperCase();
    if (msg.includes("socket hang up") || msg.includes("network") || msg.includes("timeout")) return true;
    if (["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNABORTED", "ECONNREFUSED", "EPIPE"].includes(code)) return true;
  }
  return false;
}

/** Upload data to Swarm /bytes with retry on transient errors (429, 5xx, socket hang up). */
export async function uploadToBytes(data: string | Uint8Array): Promise<Hex64> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  await ensureEthernaToken();

  let delay = 500;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // `deferred: true` — Bee buffers the chunk locally and pushes to the
      // network in the background. Without it, /bytes blocks until the
      // chunk has propagated to neighbourhood peers, turning every upload
      // into a wait for network sync.
      const release = await beeUploadSem.acquire();
      let result;
      try {
        result = await withTimeout(
          getBee().uploadData(requirePostageBatch(), bytes, { deferred: true }),
          BEE_CALL_TIMEOUT_MS,
          "bytes upload",
        );
      } finally {
        release();
      }
      const ref = typeof result.reference === "string"
        ? result.reference
        : result.reference.toString();
      return ref.toLowerCase().replace(/^0x/, "") as Hex64;
    } catch (err: unknown) {
      if (isTransientSwarmError(err) && attempt < 4) {
        const reason = (err as any)?.message ?? (err as any)?.code ?? (err as any)?.status;
        console.log(`[swarm] Upload transient error (${reason}), retrying in ${delay}ms (attempt ${attempt + 1}/5)...`);
        await wait(delay);
        delay = Math.min(delay * 2, 5000);
        continue;
      }
      throw err;
    }
  }

  throw new Error("Upload failed after retries");
}

/** Download data from Swarm /bytes as string, with retry on transient errors. */
export async function downloadFromBytes(ref: string): Promise<string> {
  await ensureEthernaToken();
  let delay = 500;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const result = await getBee().downloadData(ref);

      if (result instanceof Uint8Array) {
        return new TextDecoder().decode(result);
      }

      if (typeof result === "object" && result !== null) {
        const r = result as unknown as Record<string, unknown>;

        if (typeof r["toUtf8"] === "function") return (r["toUtf8"] as () => string)();
        if (typeof r["toText"] === "function") return (r["toText"] as () => string)();
        if (typeof r["text"] === "function") {
          const t = (r["text"] as () => string | Promise<string>)();
          return t instanceof Promise ? await t : t;
        }
        if (r["data"] instanceof Uint8Array) return new TextDecoder().decode(r["data"] as Uint8Array);
        if (r["bytes"] instanceof Uint8Array) return new TextDecoder().decode(r["bytes"] as Uint8Array);

        const payload = r["payload"];
        if (payload instanceof Uint8Array) return new TextDecoder().decode(payload);
        if (payload && typeof payload === "object") {
          const p = payload as Record<string, unknown>;
          if (typeof p["toUtf8"] === "function") return (p["toUtf8"] as () => string)();
        }

        throw new Error(`Unexpected downloadData format: ${Object.keys(r).join(", ")}`);
      }

      throw new Error(`Unexpected downloadData type: ${typeof result}`);
    } catch (err: unknown) {
      if (isTransientSwarmError(err) && attempt < 4) {
        const reason = (err as any)?.message ?? (err as any)?.code ?? (err as any)?.status;
        console.log(`[swarm] Download transient error (${reason}), retrying in ${delay}ms (attempt ${attempt + 1}/5)...`);
        await wait(delay);
        delay = Math.min(delay * 2, 5000);
        continue;
      }
      throw err;
    }
  }

  throw new Error("Download failed after retries");
}
