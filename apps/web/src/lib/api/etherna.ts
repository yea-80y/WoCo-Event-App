import { authPost, authGet } from "./client.js";

export interface UserBatchEntry {
  batchId: string;
  depth: number;
  ttlDays: number;
  purchasedAt: string;
  expiresAt: string;
  paidUntil: string;
  gateway: string;
}

export interface PurchaseBatchResult {
  batchId: string;
  expiresAt: string;
  debit: string;
  estimatedBZZ?: string;
}

export interface PurchasePreview {
  depth: number;
  ttlDays: number;
  marginPct: number;
  estimatedBZZ: string;
  maxBZZ: number;
}

export async function getMyEthernaBatch() {
  return authGet<UserBatchEntry | null>("/api/etherna/my-batch");
}

export async function getPurchasePreview() {
  return authGet<PurchasePreview>("/api/etherna/purchase-preview");
}

/** Server-driven: depth/ttlDays come from server env, not from the client. */
export async function purchaseEthernaBatch() {
  return authPost<PurchaseBatchResult>("/api/etherna/purchase-batch", {});
}
