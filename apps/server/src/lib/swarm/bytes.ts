import { getBee, requirePostageBatch } from "../../config/swarm.js";
import { ensureEthernaToken, getCachedEthernaToken } from "../etherna/auth.js";
import { registerEthernaOffer } from "../etherna/upload.js";
import type { BatchSelection } from "../etherna/batch-router.js";
import { BEE_CALL_TIMEOUT_MS, beeUploadSem, withTimeout } from "./upload-queue.js";
import type { Hex64 } from "@woco/shared";

const ETHERNA_GW = process.env.ETHERNA_GATEWAY_URL || "https://gateway.etherna.io";

/**
 * Upload raw bytes to Etherna /bytes with bearer auth + register an offer so the
 * ref is anonymously readable. Raw fetch (not bee-js): bee-js@11 onRequest copies
 * headers, so the Authorization header never reaches Etherna — same reason the
 * site image upload uses raw fetch (routes/sites.ts).
 */
async function uploadBytesToEtherna(bytes: Uint8Array, batchId: string): Promise<Hex64> {
  await ensureEthernaToken();
  const token = getCachedEthernaToken();
  if (!token) throw new Error("Etherna token unavailable (ETHERNA_API_KEY missing or ETHERNA_ENABLED off)");
  const resp = await fetch(`${ETHERNA_GW}/bytes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Swarm-Postage-Batch-Id": batchId,
      Authorization: `Bearer ${token}`,
    },
    // @ts-ignore — Node fetch doesn't expose duplex in type defs
    duplex: "half",
    body: bytes as unknown as BodyInit,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Etherna /bytes upload ${resp.status}: ${text.slice(0, 200)}`);
  }
  const { reference } = await resp.json() as { reference: string };
  await registerEthernaOffer(reference);
  return reference.toLowerCase().replace(/^0x/, "") as Hex64;
}

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

/**
 * Upload data to Swarm /bytes with retry on transient errors (429, 5xx, socket
 * hang up). `selection` routes the write: `target:"etherna"` stamps with the
 * caller's Etherna batch on the Etherna gateway; otherwise (or when omitted) the
 * WoCo bee + platform batch. The builder is the event creator, so an event created
 * with the Etherna gateway selected MUST land on the Etherna batch — only the
 * global directory stays on the WoCo bee.
 */
export async function uploadToBytes(data: string | Uint8Array, selection?: BatchSelection): Promise<Hex64> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  await ensureEthernaToken();

  if (selection?.target === "etherna") {
    return uploadBytesToEtherna(bytes, selection.batchId);
  }
  const batchId = selection?.batchId ?? requirePostageBatch();

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
          getBee().uploadData(batchId, bytes, { deferred: true }),
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

/** Decode a bee-js downloadData result (Uint8Array or Bytes-like) to a string. */
async function decodeDownload(result: unknown): Promise<string> {
  if (result instanceof Uint8Array) return new TextDecoder().decode(result);
  if (typeof result === "object" && result !== null) {
    const r = result as Record<string, unknown>;
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
}

/** Read a ref from the WoCo bee (timeout-bounded so a miss can't hang 60s alone). */
async function downloadFromWocoBee(ref: string): Promise<string> {
  const result = await withTimeout(getBee().downloadData(ref), BEE_CALL_TIMEOUT_MS, "bytes download");
  return decodeDownload(result);
}

/** Read a ref from Etherna /bytes. Bearer-authed (we own the batch), so it works
 *  even before the anonymous offer propagates. */
async function downloadFromEthernaBytes(ref: string): Promise<string> {
  const token = getCachedEthernaToken();
  const resp = await withTimeout(
    fetch(`${ETHERNA_GW}/bytes/${ref}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }),
    BEE_CALL_TIMEOUT_MS,
    "etherna bytes download",
  );
  if (!resp.ok) throw new Error(`Etherna /bytes ${resp.status}`);
  return await resp.text();
}

/**
 * Download data from Swarm /bytes as string, with retry on transient errors.
 * Content may live on the WoCo bee OR the organiser's Etherna batch (the builder's
 * gateway choice routes the WRITE; this read does not carry that choice). RACE both
 * sources and take whichever has it — a WoCo-bee read of Etherna-only content would
 * otherwise block for the full 60s timeout. ETHERNA_ENABLED gates the extra read.
 */
export async function downloadFromBytes(ref: string): Promise<string> {
  await ensureEthernaToken();

  let delay = 500;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const sources = [downloadFromWocoBee(ref)];
    if (process.env.ETHERNA_ENABLED === "true") sources.push(downloadFromEthernaBytes(ref));
    try {
      return await Promise.any(sources);
    } catch (err: unknown) {
      // Promise.any → AggregateError when ALL sources reject; classify the last.
      const inner = err instanceof AggregateError ? err.errors[err.errors.length - 1] : err;
      lastErr = inner;
      if (isTransientSwarmError(inner) && attempt < 4) {
        const reason = (inner as any)?.message ?? (inner as any)?.code ?? (inner as any)?.status;
        console.log(`[swarm] Download transient error (${reason}), retrying in ${delay}ms (attempt ${attempt + 1}/5)...`);
        await wait(delay);
        delay = Math.min(delay * 2, 5000);
        continue;
      }
      throw inner;
    }
  }

  throw lastErr ?? new Error("Download failed after retries");
}
