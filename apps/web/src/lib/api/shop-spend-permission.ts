/**
 * Shop spend-permission rail (POS tap-and-go) — client API.
 *
 * Flow:
 *   1. fetchSpendGrantParams — server-dictated scope (spender, merchant, USDC,
 *      window, per-draw ceiling, max draws).
 *   2. grantShopSpendPermission (lib/auth/kernel-account) — attendee builds +
 *      sudo-signs the approval to EXACTLY that scope (one passkey ceremony) and
 *      returns the serialized blob (no private key).
 *   3. registerSpendPermission — hand the approval + chosen cap to the server.
 *   4. paySpendPermission — the POS settles each order by drawing against it; no
 *      further attendee interaction. Funds move Kernel→merchant directly.
 *
 * This module is pure HTTP. The signing/approval build lives in kernel-account.ts
 * so the funds/signature code stays in one audited place.
 */

import type {
  Order,
  ShopSpendPermission,
  SpendPermissionGrantParams,
  RegisterSpendPermissionRequest,
} from "@woco/shared";
import { apiBase, authPost } from "./client.js";

/** Server-dictated grant scope — the approval MUST be built to match it. Public. */
export async function fetchSpendGrantParams(shopId: string): Promise<SpendPermissionGrantParams> {
  const resp = await fetch(`${apiBase}/api/shops/${shopId}/spend-permission/grant-params`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  let data: { ok: boolean; data?: SpendPermissionGrantParams; error?: string };
  try {
    data = await resp.json();
  } catch {
    throw new Error(`Grant params failed: HTTP ${resp.status}`);
  }
  if (!data.ok || !data.data) {
    throw new Error(data.error || `Grant params failed: HTTP ${resp.status}`);
  }
  return data.data;
}

/** Register a granted approval. Auth-gated: caller's parentAddress must be the
 *  granting Kernel (= req.kernelAddress). */
export async function registerSpendPermission(
  shopId: string,
  req: RegisterSpendPermissionRequest,
): Promise<ShopSpendPermission> {
  const res = await authPost<ShopSpendPermission>(
    `/api/shops/${shopId}/spend-permission`,
    req as unknown as Record<string, unknown>,
  );
  if (!res.ok || !res.data) throw new Error(res.error || "Register failed");
  return res.data;
}

/** Settle an order by drawing against a permission (POS operator or grantor). */
export async function paySpendPermission(
  shopId: string,
  orderId: string,
  permissionId: string,
): Promise<Order> {
  const res = await authPost<Order>(
    `/api/shops/${shopId}/orders/${orderId}/pay-spend-permission`,
    { permissionId },
  );
  if (!res.ok || !res.data) throw new Error(res.error || "Spend payment failed");
  return res.data;
}

/** Revoke a permission (granting attendee only) — stops further server draws. */
export async function revokeSpendPermission(shopId: string, permissionId: string): Promise<void> {
  const res = await authPost<void>(
    `/api/shops/${shopId}/spend-permission/${permissionId}/revoke`,
    {},
  );
  if (!res.ok) throw new Error(res.error || "Revoke failed");
}
