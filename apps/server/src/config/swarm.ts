import { Bee, PrivateKey } from "@ethersphere/bee-js";

export const BEE_URL = process.env.BEE_URL || "http://localhost:3323";
export const POSTAGE_BATCH_ID = process.env.POSTAGE_BATCH_ID || "";
export const FEED_PRIVATE_KEY = process.env.FEED_PRIVATE_KEY || "";

export function normalizePk(pk: string): `0x${string}` {
  const v = pk.startsWith("0x") ? pk : `0x${pk}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
    throw new Error("FEED_PRIVATE_KEY must be a 32-byte hex string");
  }
  return v as `0x${string}`;
}

let _bee: Bee | null = null;
let _signer: PrivateKey | null = null;

export function getBee(): Bee {
  if (!_bee) _bee = new Bee(BEE_URL);
  return _bee;
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

export function requirePostageBatch(): string {
  if (!POSTAGE_BATCH_ID) {
    throw new Error("POSTAGE_BATCH_ID not configured");
  }
  return POSTAGE_BATCH_ID;
}
