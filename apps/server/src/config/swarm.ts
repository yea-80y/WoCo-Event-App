import { Bee, PrivateKey } from "@ethersphere/bee-js";

export const ETHERNA_ENABLED = process.env.ETHERNA_ENABLED === "true";
const ETHERNA_GATEWAY_URL = process.env.ETHERNA_GATEWAY_URL || "https://gateway.etherna.io";

// getBee() always reads/writes via the local node — per-deploy Etherna uploads
// use getEthernaBee() (lib/etherna/upload.ts) and never go through here.
export const BEE_URL = process.env.BEE_URL || "http://localhost:3323";
// Internal proxy URL — for admin/whitelist calls. Distinct from BEE_URL (raw bee).
// On Hetzner: http://bee-proxy:3000 (rewritten by deploy sed). Laptop: public gateway.
export const PROXY_URL = process.env.PROXY_URL || "https://gateway.woco-net.com";
export const UPLOAD_SECRET = process.env.UPLOAD_SECRET || "";
export const POSTAGE_BATCH_ID = process.env.POSTAGE_BATCH_ID || "";
export const FEED_PRIVATE_KEY = process.env.FEED_PRIVATE_KEY || "";
/**
 * Signs the social indexer's own published reports (#312) — NOT user data.
 *
 * Deliberately separate from `FEED_PRIVATE_KEY`. The indexer role is
 * permissionless by design (`SWARM_SOCIAL_PLAN`), so ours should be shaped like
 * anyone else's: an address publishing at the standard topic in its own address
 * space, which a client chooses to read. Signing view-plane claims with the key
 * that owns every platform data feed would fuse the two roles and make "run a
 * different indexer against this platform" an incoherent configuration.
 *
 * Absent = the publisher stays off. Nothing else degrades: reports are a
 * durability layer over a tally that is still served on request.
 */
export const SOCIAL_INDEXER_PRIVATE_KEY = process.env.SOCIAL_INDEXER_PRIVATE_KEY || "";

export function normalizePk(pk: string, name = "FEED_PRIVATE_KEY"): `0x${string}` {
  const v = pk.startsWith("0x") ? pk : `0x${pk}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
    throw new Error(`${name} must be a 32-byte hex string`);
  }
  return v as `0x${string}`;
}

let _bee: Bee | null = null;
let _signer: PrivateKey | null = null;
let _indexerSigner: PrivateKey | null = null;

export function getBee(): Bee {
  if (!_bee) _bee = new Bee(BEE_URL);
  return _bee;
}

/** Tests only — install a fake Bee (or `null` to go back to the real one). */
export function __setBeeForTests(bee: Bee | null): void {
  _bee = bee;
}

export function getPlatformSigner(): PrivateKey {
  if (!_signer) {
    if (!FEED_PRIVATE_KEY) {
      throw new Error("FEED_PRIVATE_KEY not configured");
    }
    _signer = new PrivateKey(normalizePk(FEED_PRIVATE_KEY));
  }
  return _signer;
}

export function getPlatformOwner() {
  return getPlatformSigner().publicKey().address();
}

/** True when this deployment is configured to publish evidence reports at all. */
export function socialIndexerConfigured(): boolean {
  return SOCIAL_INDEXER_PRIVATE_KEY !== "";
}

export function getSocialIndexerSigner(): PrivateKey {
  if (!_indexerSigner) {
    if (!SOCIAL_INDEXER_PRIVATE_KEY) {
      throw new Error("SOCIAL_INDEXER_PRIVATE_KEY not configured");
    }
    _indexerSigner = new PrivateKey(normalizePk(SOCIAL_INDEXER_PRIVATE_KEY, "SOCIAL_INDEXER_PRIVATE_KEY"));
  }
  return _indexerSigner;
}

/** Lowercase 20-byte hex, no `0x` — the form every SOC read path here takes. */
export function getSocialIndexerOwnerHex(): string {
  return getSocialIndexerSigner().publicKey().address().toHex().replace(/^0x/, "").toLowerCase();
}

export function requirePostageBatch(): string {
  if (!POSTAGE_BATCH_ID) {
    throw new Error("POSTAGE_BATCH_ID not configured");
  }
  return POSTAGE_BATCH_ID;
}
