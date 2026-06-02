import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../middleware/auth.js";
import {
  getShop,
  getShopStrict,
  writeShop,
  getProducts,
  upsertProduct,
  deleteProduct,
  getOrders,
  appendOrder,
  updateOrder,
  genOrderCode,
  getCreatorShops,
  upsertCreatorShop,
} from "../lib/shop/service.js";
import { priceOrder } from "@woco/shared";
import type {
  Shop,
  Product,
  Order,
  CreateShopRequest,
  UpdateShopRequest,
  UpsertProductRequest,
  CreateOrderRequest,
  ShopDirectoryEntry,
  OrderStatus,
} from "@woco/shared";

const shopsRouter = new Hono();

// ---------------------------------------------------------------------------
// Rate limiter — public order creation writes to Swarm (postage cost); bound
// floods per IP. Mirrors the contact-form / email-claim limiters.
// ---------------------------------------------------------------------------

const orderRateMap = new Map<string, number[]>();
const ORDER_RATE_LIMIT = 20;
const ORDER_RATE_WINDOW = 60_000;

function clientIp(c: { req: { header: (k: string) => string | undefined } }): string {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

// Status transitions an owner may apply from the dashboard / POS.
const OWNER_SETTABLE_STATUS: ReadonlySet<OrderStatus> = new Set([
  "fulfilled",
  "cancelled",
]);

// ---------------------------------------------------------------------------
// POST /api/shops — create or update a shop (owner stamped server-side)
// ---------------------------------------------------------------------------

shopsRouter.post("/", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  try {
    const body = (await c.req.json()) as CreateShopRequest & { shopId?: string };
    if (!body?.name || !body?.currency || !body?.payment) {
      return c.json({ ok: false, error: "name, currency and payment are required" }, 400);
    }

    const now = new Date().toISOString();
    let createdAt = now;
    const shopId = body.shopId ?? randomUUID();

    // On update, only the owner may overwrite. Strict read: a transient Swarm
    // failure must not be read as "new shop" and skip the ownership check.
    if (body.shopId) {
      const res = await getShopStrict(body.shopId);
      if (res.status === "error") {
        return c.json({ ok: false, error: "Read failed — refusing to write" }, 503);
      }
      if (res.status === "present") {
        if (res.shop.ownerAddress.toLowerCase() !== parentAddress) {
          return c.json({ ok: false, error: "Not the shop owner" }, 403);
        }
        createdAt = res.shop.createdAt;
      }
    }

    const shop: Shop = {
      v: 1,
      shopId,
      ownerAddress: parentAddress as Shop["ownerAddress"],
      name: body.name,
      description: body.description,
      logoRef: body.logoRef,
      currency: body.currency,
      categories: body.categories ?? [],
      payment: body.payment,
      loyalty: body.loyalty,
      createdAt,
      updatedAt: now,
    };
    await writeShop(shop);

    // Directory upsert is fire-and-forget (non-fatal — the shop itself is written).
    const products = await getProducts(shopId).catch(() => []);
    upsertCreatorShop(parentAddress, {
      shopId,
      name: shop.name,
      logoRef: shop.logoRef,
      ownerAddress: shop.ownerAddress,
      productCount: products.length,
      currency: shop.currency,
      createdAt,
      updatedAt: now,
    } satisfies ShopDirectoryEntry).catch((e) =>
      console.warn("[shops] creator directory upsert failed:", e),
    );

    return c.json({ ok: true, data: { shopId } });
  } catch (err) {
    console.error("[shops/create]", err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Create failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/shops/mine — merchant's own shops. MUST precede /:id.
// ---------------------------------------------------------------------------

shopsRouter.get("/mine", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  try {
    const shops = await getCreatorShops(parentAddress);
    return c.json({ ok: true, data: shops });
  } catch {
    return c.json({ ok: false, error: "Failed to read shop directory" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/shops/:id — public shop config
// ---------------------------------------------------------------------------

shopsRouter.get("/:id", async (c) => {
  try {
    const shop = await getShop(c.req.param("id"));
    if (!shop) return c.json({ ok: false, error: "Shop not found" }, 404);
    return c.json({ ok: true, data: shop });
  } catch {
    return c.json({ ok: false, error: "Failed to read shop" }, 500);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/shops/:id — partial update of shop config (owner)
// ---------------------------------------------------------------------------

shopsRouter.patch("/:id", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const shopId = c.req.param("id");
  try {
    const existing = await getShop(shopId);
    if (!existing) return c.json({ ok: false, error: "Shop not found" }, 404);
    if (existing.ownerAddress.toLowerCase() !== parentAddress) {
      return c.json({ ok: false, error: "Not the shop owner" }, 403);
    }
    const patch = (await c.req.json()) as UpdateShopRequest;
    const updated: Shop = {
      ...existing,
      ...patch,
      // Identity fields are not client-mutable.
      shopId,
      ownerAddress: existing.ownerAddress,
      currency: existing.currency,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await writeShop(updated);
    return c.json({ ok: true, data: updated });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Update failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/shops/:id/products — public catalog
// ---------------------------------------------------------------------------

shopsRouter.get("/:id/products", async (c) => {
  try {
    const products = await getProducts(c.req.param("id"));
    return c.json({ ok: true, data: products });
  } catch {
    return c.json({ ok: false, error: "Failed to read catalog" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/shops/:id/products — create or replace a product (owner)
// ---------------------------------------------------------------------------

shopsRouter.post("/:id/products", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const shopId = c.req.param("id");
  try {
    const shop = await getShop(shopId);
    if (!shop) return c.json({ ok: false, error: "Shop not found" }, 404);
    if (shop.ownerAddress.toLowerCase() !== parentAddress) {
      return c.json({ ok: false, error: "Not the shop owner" }, 403);
    }
    const body = (await c.req.json()) as UpsertProductRequest;
    if (!body?.name || typeof body.price !== "string") {
      return c.json({ ok: false, error: "name and price are required" }, 400);
    }

    const now = new Date().toISOString();
    const productId = body.productId ?? randomUUID();
    const prior = body.productId
      ? (await getProducts(shopId)).find((p) => p.productId === body.productId)
      : undefined;

    const product: Product = {
      productId,
      shopId,
      name: body.name,
      description: body.description,
      imageRef: body.imageRef,
      imageRefs: body.imageRefs,
      price: body.price,
      compareAtPrice: body.compareAtPrice,
      sku: body.sku,
      categoryId: body.categoryId,
      variants: body.variants,
      stock: body.stock,
      channels: body.channels,
      podRewards: body.podRewards,
      active: body.active ?? true,
      sortIndex: body.sortIndex ?? prior?.sortIndex ?? 0,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    const products = await upsertProduct(shopId, product);
    return c.json({ ok: true, data: { product, products } });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Save failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/shops/:id/products/:productId (owner)
// ---------------------------------------------------------------------------

shopsRouter.delete("/:id/products/:productId", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const shopId = c.req.param("id");
  try {
    const shop = await getShop(shopId);
    if (!shop) return c.json({ ok: false, error: "Shop not found" }, 404);
    if (shop.ownerAddress.toLowerCase() !== parentAddress) {
      return c.json({ ok: false, error: "Not the shop owner" }, 403);
    }
    const products = await deleteProduct(shopId, c.req.param("productId"));
    return c.json({ ok: true, data: { products } });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Delete failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/shops/:id/orders — order log (owner only — sensitive)
// ---------------------------------------------------------------------------

shopsRouter.get("/:id/orders", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const shopId = c.req.param("id");
  try {
    const shop = await getShop(shopId);
    if (!shop) return c.json({ ok: false, error: "Shop not found" }, 404);
    if (shop.ownerAddress.toLowerCase() !== parentAddress) {
      return c.json({ ok: false, error: "Not the shop owner" }, 403);
    }
    const orders = await getOrders(shopId);
    return c.json({ ok: true, data: orders });
  } catch {
    return c.json({ ok: false, error: "Failed to read orders" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/shops/:id/orders — place an order. Public + rate-limited.
// Server prices every line from the live catalog (never trusts client prices)
// and returns the order with its pickup code. Payment verification is wired in
// build step 2 — orders are created "pending" until then.
// ---------------------------------------------------------------------------

shopsRouter.post("/:id/orders", async (c) => {
  const ip = clientIp(c);
  const now = Date.now();
  const hits = (orderRateMap.get(ip) ?? []).filter((t) => now - t < ORDER_RATE_WINDOW);
  if (hits.length >= ORDER_RATE_LIMIT) {
    return c.json({ ok: false, error: "Too many requests. Please wait before trying again." }, 429);
  }
  hits.push(now);
  orderRateMap.set(ip, hits);

  const shopId = c.req.param("id");
  try {
    const shop = await getShop(shopId);
    if (!shop) return c.json({ ok: false, error: "Shop not found" }, 404);

    const body = (await c.req.json()) as CreateOrderRequest;
    const products = await getProducts(shopId);
    const { lines, total } = priceOrder(products, body.lines);

    const order: Order = {
      v: 1,
      orderId: randomUUID(),
      shopId,
      code: genOrderCode(),
      lines,
      total,
      currency: shop.currency,
      rail: body.rail,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    await appendOrder(shopId, order);
    return c.json({ ok: true, data: order });
  } catch (err) {
    // Pricing/validation errors are client faults (bad product, qty, variant).
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Order failed" }, 400);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/shops/:id/orders/:orderId — owner status transition (fulfil/cancel)
// ---------------------------------------------------------------------------

shopsRouter.patch("/:id/orders/:orderId", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const shopId = c.req.param("id");
  try {
    const shop = await getShop(shopId);
    if (!shop) return c.json({ ok: false, error: "Shop not found" }, 404);
    if (shop.ownerAddress.toLowerCase() !== parentAddress) {
      return c.json({ ok: false, error: "Not the shop owner" }, 403);
    }
    const { status } = (await c.req.json()) as { status?: OrderStatus };
    if (!status || !OWNER_SETTABLE_STATUS.has(status)) {
      return c.json({ ok: false, error: "Invalid status transition" }, 400);
    }
    const patch =
      status === "fulfilled" ? { status, fulfilledAt: new Date().toISOString() } : { status };
    const updated = await updateOrder(shopId, c.req.param("orderId"), patch);
    if (!updated) return c.json({ ok: false, error: "Order not found" }, 404);
    return c.json({ ok: true, data: updated });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Update failed" }, 500);
  }
});

export { shopsRouter };
