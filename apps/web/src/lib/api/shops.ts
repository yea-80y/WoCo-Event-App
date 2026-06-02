/**
 * Shop API client — CRUD for shops + products + orders.
 * All authenticated calls use authPost/authGet from client.ts.
 * Public reads (getShop, getProducts) use plain fetch.
 */

import type {
  Shop,
  Product,
  Order,
  ShopDirectoryEntry,
  CreateShopRequest,
  UpdateShopRequest,
  UpsertProductRequest,
  CreateOrderRequest,
  OrderLineRequest,
} from "@woco/shared";
import { apiBase, authPost, authGet, authPatch, authDelete } from "./client.js";

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

export async function getShop(shopId: string): Promise<Shop | null> {
  try {
    const r = await fetch(`${apiBase}/api/shops/${shopId}`);
    const j: { ok: boolean; data?: Shop } = await r.json();
    return j.ok && j.data ? j.data : null;
  } catch {
    return null;
  }
}

export async function getProducts(shopId: string): Promise<Product[]> {
  try {
    const r = await fetch(`${apiBase}/api/shops/${shopId}/products`);
    const j: { ok: boolean; data?: Product[] } = await r.json();
    return j.ok && j.data ? j.data : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Authenticated — owner only
// ---------------------------------------------------------------------------

export async function getMyShops(): Promise<ShopDirectoryEntry[]> {
  const r = await authGet<ShopDirectoryEntry[]>("/api/shops/mine");
  if (!r.ok || !r.data) throw new Error(r.error ?? "Failed to load shops");
  return r.data;
}

export async function createShop(req: CreateShopRequest): Promise<Shop> {
  const r = await authPost<Shop>("/api/shops", req as unknown as Record<string, unknown>);
  if (!r.ok || !r.data) throw new Error(r.error ?? "Failed to create shop");
  return r.data;
}

export async function updateShop(shopId: string, req: UpdateShopRequest): Promise<Shop> {
  const r = await authPatch<Shop>(`/api/shops/${shopId}`, req as unknown as Record<string, unknown>);
  if (!r.ok || !r.data) throw new Error(r.error ?? "Failed to update shop");
  return r.data;
}

export async function upsertProduct(shopId: string, req: UpsertProductRequest): Promise<Product> {
  const r = await authPost<Product>(
    `/api/shops/${shopId}/products`,
    req as unknown as Record<string, unknown>,
  );
  if (!r.ok || !r.data) throw new Error(r.error ?? "Failed to save product");
  return r.data;
}

export async function deleteProduct(shopId: string, productId: string): Promise<void> {
  const r = await authDelete<void>(`/api/shops/${shopId}/products/${productId}`);
  if (!r.ok) throw new Error(r.error ?? "Failed to delete product");
}

/** Create a pending order (server prices it — client lines carry productId + qty only). */
export async function createOrder(shopId: string, req: CreateOrderRequest): Promise<Order> {
  const resp = await fetch(`${apiBase}/api/shops/${shopId}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const j: { ok: boolean; data?: Order; error?: string } = await resp.json();
  if (!j.ok || !j.data) throw new Error(j.error ?? "Failed to create order");
  return j.data;
}

/** Create a pending order as an authenticated operator (POS path). */
export async function createOrderAuth(shopId: string, lines: OrderLineRequest[]): Promise<Order> {
  const r = await authPost<Order>(`/api/shops/${shopId}/orders`, {
    lines,
    rail: "crypto",
  });
  if (!r.ok || !r.data) throw new Error(r.error ?? "Failed to create order");
  return r.data;
}
