/**
 * Etherna per-user postage batch registry.
 *
 * One batch per paying user services BOTH their websites and their event pages.
 * Free event pages without a user batch fall back to the shared platform batch
 * (handled by batch-router.ts, not here).
 *
 * File-backed, atomic write, survives restarts. Same pattern as stripe-accounts.ts.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { ensureEthernaToken } from "./auth.js";

const DATA_DIR = join(process.cwd(), ".data");
const BATCHES_FILE = join(DATA_DIR, "etherna-batches.json");

const ETHERNA_GW = process.env.ETHERNA_GATEWAY_URL || "https://gateway.etherna.io";
const TOKEN_ENDPOINT = process.env.ETHERNA_TOKEN_ENDPOINT || "https://sso.etherna.io/connect/token";

const GNOSIS_BLOCK_SEC = 5;

const USABILITY_POLL_INTERVAL_MS = 2_000;
const USABILITY_POLL_TIMEOUT_MS = 180_000;

export interface UserBatchEntry {
  batchId: string;
  depth: number;
  ttlDays: number;
  purchasedAt: string;
  expiresAt: string;
  /** When the user's pre-paid hosting window ends. Renewal cron stops once paidUntil < now. */
  paidUntil: string;
  gateway: string;
}

/** lowercase ETH address → UserBatchEntry */
let store: Record<string, UserBatchEntry> = {};
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    store = JSON.parse(readFileSync(BATCHES_FILE, "utf-8"));
    console.log(`[etherna-batches] Loaded ${Object.keys(store).length} user batches from disk`);
  } catch {
    // No file yet — first run
  }
}

function persist(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${BATCHES_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
  renameSync(tmp, BATCHES_FILE);
}

export function getUserBatch(addr: string): UserBatchEntry | null {
  ensureLoaded();
  return store[addr.toLowerCase()] ?? null;
}

export function saveUserBatch(addr: string, entry: UserBatchEntry): void {
  ensureLoaded();
  store[addr.toLowerCase()] = entry;
  persist();
}

// ---------------------------------------------------------------------------
// Etherna API helpers
// ---------------------------------------------------------------------------

async function fetchToken(): Promise<string> {
  const apiKey = process.env.ETHERNA_API_KEY ?? "";
  if (!apiKey) throw new Error("ETHERNA_API_KEY not configured");
  const dot = apiKey.indexOf(".");
  if (dot === -1) throw new Error("ETHERNA_API_KEY must be <id>.<secret>");
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: process.env.ETHERNA_CLIENT_ID ?? "apiKeyClientId",
    username: apiKey.slice(0, dot),
    password: apiKey.slice(dot + 1),
    scope: process.env.ETHERNA_SCOPES ?? "openid profile offline_access ether_accounts role userApi.gateway",
  });
  const r = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`Etherna token request failed: ${r.status} ${await r.text().catch(() => "")}`);
  return ((await r.json()) as { access_token: string }).access_token;
}

async function authGet(token: string, path: string): Promise<unknown> {
  const r = await fetch(`${ETHERNA_GW}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}: ${await r.text().catch(() => "")}`);
  return r.json();
}

async function authPost(token: string, path: string): Promise<unknown> {
  const r = await fetch(`${ETHERNA_GW}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}: ${await r.text().catch(() => "")}`);
  return r.json();
}

function readCreditWei(c: unknown): bigint {
  const obj = c as { balance: string | number };
  if (typeof obj.balance === "string") return BigInt(obj.balance);
  return BigInt(Math.round(Number(obj.balance) * 1e18));
}

// ---------------------------------------------------------------------------
// Batch provisioning
// ---------------------------------------------------------------------------

interface ProvisionInput {
  depth: number;
  /** May be fractional — 1.1 = 26h 24min. Keep a margin above your test window
   *  so a slightly-stale block timestamp can't expire the batch mid-deploy. */
  ttlDays: number;
  marginPct?: number;
  /** Per-purchase cap on BZZ committed (NOT xDai). The /stamps `amount` param
   *  is denominated in PLUR (1 BZZ = 1e16 PLUR); we compute committed BZZ from
   *  amount × 2^depth and refuse if it exceeds this. Actual xDai debit is
   *  typically less (BZZ trades below xDai), so this is a strict upper bound. */
  maxBZZ?: number;
  /** Label sent to Etherna for ops visibility. */
  label?: string;
}

interface ProvisionResult {
  batchId: string;
  debitXDai: string;
  estimatedBZZ: string;
  purchasedAt: string;
  expiresAt: string;
}

interface BatchEstimate {
  depth: number;
  ttlDays: number;
  marginPct: number;
  amountPerChunk: string;
  estimatedBZZ: string;
}

/** Compute the /stamps `amount` and committed-BZZ estimate for given inputs.
 *  Used by both provisionEthernaBatch and the purchase-preview endpoint. */
export async function estimateEthernaBatch(input: {
  depth: number;
  ttlDays: number;
  marginPct?: number;
}): Promise<BatchEstimate> {
  const { depth, ttlDays } = input;
  const marginPct = input.marginPct ?? 25;

  await ensureEthernaToken();
  const token = await fetchToken();

  const chainstate = await authGet(token, "/api/v0.3/system/chainstate") as { currentPrice: string | number };
  const currentPrice = BigInt(chainstate.currentPrice);

  // Seconds-first arithmetic so fractional ttlDays (e.g. 1.1) works correctly.
  const ttlSeconds = BigInt(Math.round(ttlDays * 86_400));
  const blocksInTtl = ttlSeconds / BigInt(GNOSIS_BLOCK_SEC);
  const baseAmount = currentPrice * blocksInTtl;
  const amountPerChunk = (baseAmount * BigInt(100 + marginPct)) / 100n;
  const totalChunks = 1n << BigInt(depth);
  const totalPlur = amountPerChunk * totalChunks;
  // 1 BZZ = 1e16 PLUR. This is BZZ committed to the batch — the xDai debit
  // is approximately BZZ × (BZZ market price), typically a fraction of it.
  const estimatedBZZ = Number(totalPlur) / 1e16;

  return {
    depth,
    ttlDays,
    marginPct,
    amountPerChunk: amountPerChunk.toString(),
    estimatedBZZ: estimatedBZZ.toFixed(6),
  };
}

/** Poll Etherna until the batch reports usable=true, or timeout.
 *  Without this, the first /bzz upload against a fresh batch can 400/422. */
async function waitForBatchUsable(token: string, batchId: string): Promise<void> {
  const start = Date.now();
  let lastErr = "";
  while (Date.now() - start < USABILITY_POLL_TIMEOUT_MS) {
    try {
      const r = await fetch(`${ETHERNA_GW}/stamps/${batchId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        const data = await r.json() as { usable?: boolean };
        if (data.usable === true) return;
      } else {
        lastErr = `${r.status}`;
      }
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await new Promise((res) => setTimeout(res, USABILITY_POLL_INTERVAL_MS));
  }
  throw new Error(`Batch ${batchId.slice(0, 12)}… did not become usable within ${USABILITY_POLL_TIMEOUT_MS / 1000}s (last: ${lastErr || "no error"})`);
}

/**
 * Provision a new Etherna postage batch. Reads chainstate to size the purchase,
 * caps by maxBZZ (per-purchase safety floor — NOT an aggregate budget), polls
 * until the batch is usable, then returns batchId + measured xDai debit
 * (credit_before − credit_after, denominated in the user's credit balance).
 */
export async function provisionEthernaBatch(input: ProvisionInput): Promise<ProvisionResult> {
  const marginPct = input.marginPct ?? 25;
  const maxBZZ = input.maxBZZ ?? 1;

  const estimate = await estimateEthernaBatch({
    depth: input.depth,
    ttlDays: input.ttlDays,
    marginPct,
  });

  const estimatedBZZ = Number(estimate.estimatedBZZ);
  if (estimatedBZZ > maxBZZ) {
    throw new Error(
      `Batch would commit ${estimatedBZZ.toFixed(4)} BZZ — exceeds per-purchase cap ${maxBZZ} BZZ. ` +
      `Refusing to provision — raise ETHERNA_PURCHASE_MAX_BZZ to override.`,
    );
  }

  const token = await fetchToken();
  const creditBefore = readCreditWei(await authGet(token, "/api/v0.3/users/current/credit2"));

  const label = encodeURIComponent(input.label ?? `woco-user-${Date.now()}`);
  const stamps = await authPost(token, `/stamps/${estimate.amountPerChunk}/${input.depth}?label=${label}`) as { batchID: string };

  // Run debit measurement and usability polling concurrently. The credit read
  // needs ~8s for the debit to register (observed Etherna lag); usability polling
  // starts immediately so we react within 2s of the batch becoming ready rather
  // than waiting the full 8s before even starting to check.
  const [debitWei] = await Promise.all([
    (async (): Promise<bigint> => {
      await new Promise((r) => setTimeout(r, 8000));
      const creditAfter = readCreditWei(await authGet(token, "/api/v0.3/users/current/credit2"));
      return creditBefore - creditAfter;
    })(),
    waitForBatchUsable(token, stamps.batchID),
  ]);
  const debitXDai = (Number(debitWei) / 1e18).toFixed(6);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + input.ttlDays * 86_400_000);

  return {
    batchId: stamps.batchID,
    debitXDai,
    estimatedBZZ: estimate.estimatedBZZ,
    purchasedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}
