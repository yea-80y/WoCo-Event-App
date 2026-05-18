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
const SECONDS_PER_DAY = 86_400n;

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
  ttlDays: number;
  marginPct?: number;
  /** Per-purchase cap in xDai. Refuse to call /stamps if estimated cost exceeds this. */
  maxXDai?: number;
  /** Label sent to Etherna for ops visibility. */
  label?: string;
}

interface ProvisionResult {
  batchId: string;
  debitXDai: string;
  purchasedAt: string;
  expiresAt: string;
}

/**
 * Provision a new Etherna postage batch. Reads chainstate to size the purchase,
 * caps by maxXDai (per-purchase safety floor — NOT an aggregate budget), and
 * returns the batchId plus actual xDai debit (credit_before − credit_after).
 */
export async function provisionEthernaBatch(input: ProvisionInput): Promise<ProvisionResult> {
  const depth = input.depth;
  const ttlDays = input.ttlDays;
  const marginPct = input.marginPct ?? 25;
  const maxXDai = input.maxXDai ?? 5;

  await ensureEthernaToken();
  const token = await fetchToken();

  const chainstate = await authGet(token, "/api/v0.3/system/chainstate") as { currentPrice: string | number };
  const currentPrice = BigInt(chainstate.currentPrice);

  const blocksInTtl = BigInt(ttlDays) * SECONDS_PER_DAY / BigInt(GNOSIS_BLOCK_SEC);
  const baseAmount = currentPrice * blocksInTtl;
  const amountPerChunk = (baseAmount * BigInt(100 + marginPct)) / 100n;
  const totalChunks = 1n << BigInt(depth);
  const totalPlur = amountPerChunk * totalChunks;
  // 1 BZZ = 1e16 PLUR; on Etherna, 1 BZZ ≈ 1 xDai of credit (we anchor against
  // measured debit, not this constant — this estimate just gates the safety cap).
  const estimatedXDai = Number(totalPlur) / 1e16;

  if (estimatedXDai > maxXDai) {
    throw new Error(
      `Batch cost ${estimatedXDai.toFixed(4)} xDai exceeds per-purchase cap ${maxXDai} xDai. ` +
      `Refusing to provision — raise ETHERNA_PURCHASE_MAX_XDAI to override.`,
    );
  }

  const creditBefore = readCreditWei(await authGet(token, "/api/v0.3/users/current/credit2"));

  const label = encodeURIComponent(input.label ?? `woco-user-${Date.now()}`);
  const stamps = await authPost(token, `/stamps/${amountPerChunk}/${depth}?label=${label}`) as { batchID: string };

  // Allow the credit debit to settle. Etherna's docs say it can take a few
  // seconds for the post-purchase balance to register; the test script waits 8s.
  await new Promise((r) => setTimeout(r, 8000));

  const creditAfter = readCreditWei(await authGet(token, "/api/v0.3/users/current/credit2"));
  const debitWei = creditBefore - creditAfter;
  const debitXDai = (Number(debitWei) / 1e18).toFixed(6);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlDays * 86_400_000);

  return {
    batchId: stamps.batchID,
    debitXDai,
    purchasedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}
