import type { RedundancyLevel } from "@ethersphere/bee-js";
import { getBee, requirePostageBatch } from "../../config/swarm.js";
import { ensureEthernaToken, getCachedEthernaToken } from "../etherna/auth.js";
import { registerEthernaOffer } from "../etherna/upload.js";
import { PlatformBatchUnavailable, type BatchSelection } from "../etherna/batch-router.js";
import { FAILOVER_ETHERNA_ATTEMPTS, noteFailedOver, notePlainTreeMismatch, relayPlan } from "../etherna/failover.js";
import { ethernaPaused } from "../etherna/breaker.js";
import { noteBytesFailover } from "../etherna/relay-ledger.js";
import { BEE_CALL_TIMEOUT_MS, beeUploadSem, isTransientSwarmError, withRetries, withTimeout, type UploadBudget } from "./upload-queue.js";
import { plainBytesTimeoutMs, plainTreeRoot, postPlainBytes } from "./plain-bytes.js";
import { whitelistHashes } from "./whitelist.js";
import type { Hex64 } from "@woco/shared";
import { ETHERNA_FETCH_BASE } from "../etherna/gateway.js";
import { ResponseTooLargeError, SWARM_READ_MAX_BYTES, readCappedText } from "../http/read-capped.js";
import { isBeeResponseTooLarge } from "./bee-read-cap.js";

const ETHERNA_GW = ETHERNA_FETCH_BASE;

const FULL_BUDGET = { attempts: 5, timeoutMs: BEE_CALL_TIMEOUT_MS };

export interface EthernaSaveOptions {
  /** With the rail on, a save Etherna cannot take is stamped on WoCo and moved back to `parent`'s batch. */
  failover?: { parent?: string };
  /** The address the caller computed (a deploy's objects, a feed manifest): either store answering another refuses the save. */
  expected?: string;
  /** Etherna leg only: answer before the store has pushed the chunks (default) or after (deploys, #613). */
  deferred?: boolean;
  /** Offer the save for anonymous Etherna reads (default). A deploy offers its root alone. */
  offer?: boolean;
  /** What Etherna gets when nothing can follow it (the rail off). Default 5 attempts, 60 s each. */
  ethernaBudget?: UploadBudget;
  /** An earlier part of the same deploy already went to WoCo: skip the Etherna try (breaker.ts ignores fast failures). */
  skipEtherna?: boolean;
}

export type EthernaSave = { ref: Hex64; landed: "etherna" | "woco" };

/**
 * A save meant for Etherna (#912 slices 2a, 2b) - the one bytes save layer, for a
 * single save and for each object of a deploy. Level 0 on every leg
 * (`plain-bytes.ts`), so a save the failover stamps on WoCo has the address it
 * would have had on Etherna and can move back under it.
 *
 * Without `failover`, or with the rail off, exactly as before: Etherna or an
 * error. With it, Etherna gets a short try (none when the router already refused
 * its batch, the breaker is open, under `force`, or `skipEtherna`), then the save
 * is stamped on WoCo and its root listed for the sweep to move back.
 */
export async function saveForEtherna(bytes: Uint8Array, selection: BatchSelection, opts: EthernaSaveOptions = {}): Promise<EthernaSave> {
  if (bytes.byteLength === 0) throw Object.assign(new Error("bytes upload: nothing to store"), { status: 400 });
  const plan = opts.failover ? relayPlan(selection.ethernaRefused) : "etherna";
  // A refused batch handed over without the failover able to take the save.
  if (selection.ethernaRefused !== undefined && plan !== "woco") throw new PlatformBatchUnavailable(selection.ethernaRefused);
  const want = opts.expected ?? plainTreeRoot(bytes);
  if (plan === "etherna" || (plan === "etherna-then-woco" && !opts.skipEtherna)) {
    let ref: string | undefined;
    try {
      ref = await withRetries(
        (timeoutMs) => postPlainBytes("etherna", selection.batchId, bytes, { timeoutMs, deferred: opts.deferred ?? true }),
        plan === "etherna"
          ? (opts.ethernaBudget ?? FULL_BUDGET)
          : { attempts: FAILOVER_ETHERNA_ATTEMPTS, timeoutMs: plainBytesTimeoutMs(bytes.length) },
        // A slow failure has paused Etherna (breaker.ts): no second wait before
        // WoCo. Two waits on an 8 MB image would outlast the edge's 100 s.
        plan === "etherna" ? isTransientSwarmError : (e) => isTransientSwarmError(e) && ethernaPaused() === null,
      );
    } catch (err) {
      if (plan === "etherna") throw err;
      console.warn(`[swarm] Etherna could not take ${bytes.length} bytes, stamping them on WoCo: ${(err as Error)?.message ?? err}`);
    }
    if (ref !== undefined) {
      if (want !== null && want !== ref) {
        notePlainTreeMismatch(bytes.length);
        // Outside the failover: an Etherna that is up but builds another tree would
        // leave a WoCo copy that could never move back under the address asked for.
        if (opts.expected !== undefined) {
          throw new Error(`Etherna stored ${bytes.length} bytes at ${ref.slice(0, 12)}…, expected ${want.slice(0, 12)}…`);
        }
      }
      // Fire-and-forget the offer: it only enables ANONYMOUS gateway reads (e.g.
      // the event image); the server's own reads are bearer-authed. A missed offer
      // only delays anonymous reads until something re-registers, never a claim.
      if (opts.offer ?? true) {
        void registerEthernaOffer(ref).catch((err) =>
          console.warn(`[etherna] offer-register failed (non-fatal) for ${ref}: ${(err as Error)?.message}`),
        );
      }
      return { ref: ref as Hex64, landed: "etherna" };
    }
  }
  const ref = await withRetries(
    (timeoutMs) => postPlainBytes("wocoBee", requirePostageBatch(), bytes, { timeoutMs, deferred: true }),
    FULL_BUDGET,
    isTransientSwarmError,
  );
  // Our bee built something other than the address asked for: it could never move back.
  if (want !== null && want !== ref) {
    throw new Error(`our bee stored ${bytes.length} bytes at ${ref.slice(0, 12)}…, not the level-0 root ${want.slice(0, 12)}…`);
  }
  // Listed after the stamp: nothing refers to the root until the caller has it
  // (relay-ledger.ts `noteBytesFailover`). Never hand back a root nothing will move.
  if (!noteBytesFailover(ref, opts.failover!.parent)) {
    throw new PlatformBatchUnavailable("the Etherna failover list is full or unreadable");
  }
  noteFailedOver();
  // Readers that fall back to our gateway (event images, avatars) find it there.
  await whitelistHashes([ref]).catch((err) => console.warn(`[swarm] failover whitelist failed (non-fatal) for ${ref.slice(0, 12)}…:`, err));
  return { ref: ref as Hex64, landed: "woco" };
}

/** Delay helper */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The one classifier for store faults (upload-queue.ts); re-exported for this module's older importers. */
export { isTransientSwarmError };

/**
 * Upload data to Swarm /bytes with retry on transient errors (429, 423, 5xx,
 * socket hang up). `selection` routes the write: `target:"etherna"` stamps with
 * the caller's Etherna batch on the Etherna gateway, ALWAYS at redundancy level 0
 * (`saveForEtherna`); otherwise (or when omitted) the WoCo bee + platform batch,
 * at whatever level the caller asks. The builder is the event creator, so an
 * event created with the Etherna gateway selected MUST land on the Etherna batch —
 * only the global directory stays on the WoCo bee.
 *
 * `failover` (#912 slice 2a): an Etherna save that Etherna cannot take is stamped
 * on WoCo and moved back later instead of failing. `parent` names whose batch it
 * moves back to. Pair with `routeSave` (failover.ts) so a batch the chain already
 * refuses detours too.
 */
export async function uploadToBytes(
  data: string | Uint8Array,
  selection?: BatchSelection,
  options?: { redundancyLevel?: RedundancyLevel; failover?: { parent?: string } },
): Promise<Hex64> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  // Never store what `downloadFromBytes` would refuse to read back: the two
  // ceilings are one constant, so a blob the server wrote is always readable.
  if (bytes.byteLength > SWARM_READ_MAX_BYTES) {
    throw Object.assign(
      new Error(`bytes upload: ${bytes.byteLength} bytes exceeds the ${SWARM_READ_MAX_BYTES}-byte read ceiling`),
      { status: 413 },
    );
  }
  if (selection?.target === "etherna") {
    if (options?.redundancyLevel) throw new Error("an Etherna save is always stored at redundancy level 0 (#912)");
    return (await saveForEtherna(bytes, selection, { failover: options?.failover })).ref;
  }
  const batchId = selection?.batchId ?? requirePostageBatch();

  let delay = 500;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // Concurrent writes to one postage batch contend on Bee's per-bucket stamp
      // lock (429). Event create fires the image + N edition pages + manifest at
      // once, so without this they collide. `deferred: true` keeps /bytes from
      // blocking on network sync. The semaphore is released before the retry
      // backoff sleep so a throttled slot doesn't block other callers.
      const release = await beeUploadSem.acquire();
      try {
        const result = await withTimeout(
          getBee().uploadData(
            batchId,
            bytes,
            {
              deferred: true,
              // Erasure coding (marketing lists use STRONG).
              ...(options?.redundancyLevel !== undefined
                ? { redundancyLevel: options.redundancyLevel }
                : {}),
            },
            // bee-js drops a falsy level, so OFF never reaches bee on its own - and bee
            // 2.8 erasure-codes a multi-chunk upload that names no level, which gives a
            // different reference than the plain tree a caller computed (#186 key ring).
            options?.redundancyLevel === 0 ? { headers: { "swarm-redundancy-level": "0" } } : undefined,
          ),
          BEE_CALL_TIMEOUT_MS,
          "bytes upload",
        );
        const ref = typeof result.reference === "string"
          ? result.reference
          : result.reference.toString();
        return ref.toLowerCase().replace(/^0x/, "") as Hex64;
      } finally {
        release();
      }
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

/** Read a ref from the WoCo bee. The process-wide bee-js cap (`bee-read-cap.ts`)
 *  bounds the body; `signal` ends the transfer itself on timeout or once the
 *  other source has answered, rather than leaving it downloading unobserved. */
async function downloadFromWocoBee(ref: string, signal: AbortSignal): Promise<string> {
  try {
    const result = await withTimeout(getBee().downloadData(ref, undefined, { signal }), BEE_CALL_TIMEOUT_MS, "bytes download");
    return await decodeDownload(result);
  } catch (err) {
    if (isBeeResponseTooLarge(err)) throw new WocoBeeTooLargeError(SWARM_READ_MAX_BYTES, "bytes download");
    throw err;
  }
}

/** Read a ref from Etherna /bytes. Bearer-authed (we own the batch), so it works
 *  even before the anonymous offer propagates. */
async function downloadFromEthernaBytes(ref: string, signal: AbortSignal): Promise<string> {
  const token = getCachedEthernaToken();
  const resp = await withTimeout(
    fetch(`${ETHERNA_GW}/bytes/${ref}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal }),
    BEE_CALL_TIMEOUT_MS,
    "etherna bytes download",
  );
  if (!resp.ok) {
    await resp.body?.cancel().catch(() => {});
    throw new EthernaReadError(resp.status);
  }
  return await readCappedText(resp, SWARM_READ_MAX_BYTES, "etherna bytes download");
}

/** Etherna's status on `httpStatus`, not `status`: `isTransientSwarmError` must classify it as it always has. */
class EthernaReadError extends Error {
  constructor(readonly httpStatus: number) {
    super(`Etherna /bytes ${httpStatus}`);
    this.name = "EthernaReadError";
  }
}

/**
 * Every source asked answered 404. Not proof the content is gone for good: a bee
 * also says 404 when it cannot reach the chunk's holders. So a caller may REPORT
 * it - never take it as "empty" and write over what it could not read.
 */
export class SwarmNotFoundError extends Error {
  readonly status = 404;
  constructor(ref: string) {
    super(`${ref} not found on any source`);
    this.name = "SwarmNotFoundError";
  }
}

const answeredNotFound = (err: unknown): boolean =>
  err instanceof EthernaReadError ? err.httpStatus === 404 : (err as { status?: unknown } | null)?.status === 404;

/** Our own bee's size verdict — the only one remembered (see `oversizedRefs`). */
class WocoBeeTooLargeError extends ResponseTooLargeError {}

/**
 * Refs our bee has shown to be over the read ceiling. A Swarm ref is the hash of
 * its content, so the verdict can never change and the ref is never fetched
 * again — a feed that names one costs the server one capped read, not one per
 * checkout. Only OUR bee's verdict is kept: Etherna is a third party, and
 * remembering its answer would let it blacklist a legitimate ref. Bounded the
 * way `soc-read.ts`'s `healed` set is: cleared whole past 10k.
 */
const oversizedRefs = new Set<string>();

function rememberOversized(ref: string): void {
  oversizedRefs.add(ref);
  if (oversizedRefs.size > 10_000) oversizedRefs.clear();
}

/**
 * Download data from Swarm /bytes as string, with retry on transient errors.
 * Content may live on the WoCo bee OR the organiser's Etherna batch (the builder's
 * gateway choice routes the WRITE; this read does not carry that choice). RACE both
 * sources and take whichever has it — a WoCo-bee read of Etherna-only content would
 * otherwise block for the full 60s timeout. ETHERNA_ENABLED gates the extra read.
 *
 * At most `SWARM_READ_MAX_BYTES` is read from either source. Over it is a
 * `ResponseTooLargeError` (status 413), never retried.
 *
 * `wocoBeeOnly`: content our bee stamped that the server then trusts (#950's
 * directory overflow). Our bee checks each chunk against its address; nothing
 * here checks Etherna's answer against the ref.
 */
export async function downloadFromBytes(ref: string, { wocoBeeOnly = false }: { wocoBeeOnly?: boolean } = {}): Promise<string> {
  const key = ref.toLowerCase().replace(/^0x/, "");
  if (oversizedRefs.has(key)) throw new ResponseTooLargeError(SWARM_READ_MAX_BYTES, "bytes download");
  // Etherna's sign-in down must not stop our bee being asked (#912): its read then
  // goes without a token and fails on its own, and our bee answers.
  if (!wocoBeeOnly) await ensureEthernaToken().catch((err) => console.warn(`[swarm] Etherna token unavailable for a read: ${(err as Error)?.message ?? err}`));
  const etherna = !wocoBeeOnly && process.env.ETHERNA_ENABLED === "true";

  let delay = 500;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const transfer = new AbortController();
    const sources = [downloadFromWocoBee(ref, transfer.signal)];
    if (etherna) sources.push(downloadFromEthernaBytes(ref, transfer.signal));
    try {
      return await Promise.any(sources);
    } catch (err: unknown) {
      // Promise.any → AggregateError when ALL sources reject; classify the last.
      const errors = err instanceof AggregateError ? err.errors : [err];
      if (errors.some((e) => e instanceof WocoBeeTooLargeError)) {
        rememberOversized(key);
        throw new ResponseTooLargeError(SWARM_READ_MAX_BYTES, "bytes download");
      }
      if (errors.every(answeredNotFound)) throw new SwarmNotFoundError(key);
      const inner = errors[errors.length - 1];
      lastErr = inner;
      if (isTransientSwarmError(inner) && attempt < 4) {
        const reason = (inner as any)?.message ?? (inner as any)?.code ?? (inner as any)?.status;
        console.log(`[swarm] Download transient error (${reason}), retrying in ${delay}ms (attempt ${attempt + 1}/5)...`);
        await wait(delay);
        delay = Math.min(delay * 2, 5000);
        continue;
      }
      throw inner;
    } finally {
      // The winner is done; a loser, or a source still running after a
      // timeout, stops transferring now.
      transfer.abort();
    }
  }

  throw lastErr ?? new Error("Download failed after retries");
}
