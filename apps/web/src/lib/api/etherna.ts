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
}

export async function getMyEthernaBatch() {
  return authGet<UserBatchEntry | null>("/api/etherna/my-batch");
}

export async function purchaseEthernaBatch(opts?: { depth?: number; ttlDays?: number }) {
  return authPost<PurchaseBatchResult>("/api/etherna/purchase-batch", { ...(opts ?? {}) });
}
