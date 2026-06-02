/**
 * Shop pricing — client-first, server-verified.
 *
 * These helpers are PURE (no Swarm, no secrets) so the client prices/validates
 * a cart locally for instant UX, and the server re-runs the exact same code
 * against the live catalog before taking payment. The server's result is the
 * authoritative one — client-supplied prices are never trusted (same posture
 * as ticket claims). Keeping the logic here guarantees both sides agree byte
 * for byte; a divergence would surface as an amount-mismatch, not a silent
 * overcharge.
 *
 * Money is integer minor units internally, never floats — fiat/USDC amounts
 * must round-trip exactly.
 */

import type { Product, OrderLine, OrderLineRequest } from "./types.js";

// ---------------------------------------------------------------------------
// Money — integer minor units
// ---------------------------------------------------------------------------

/** Parse a 2dp decimal string into integer minor units. Throws on malformed input. */
export function moneyToMinor(s: string): number {
  const t = s.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) throw new Error(`Invalid money amount: ${s}`);
  const neg = t.startsWith("-");
  const [whole, frac = ""] = t.replace("-", "").split(".");
  const minor = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return neg ? -minor : minor;
}

/** Format integer minor units back to a 2dp decimal string. */
export function minorToMoney(n: number): string {
  const neg = n < 0;
  const a = Math.abs(n);
  return `${neg ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Pricing — price every line from the catalog. Same code runs client + server.
// ---------------------------------------------------------------------------

export function priceOrder(
  products: Product[],
  lines: OrderLineRequest[],
): { lines: OrderLine[]; total: string } {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error("Order has no lines");
  const byId = new Map(products.map((p) => [p.productId, p]));
  const out: OrderLine[] = [];
  let totalMinor = 0;

  for (const req of lines) {
    if (!Number.isInteger(req.qty) || req.qty < 1) throw new Error("Invalid quantity");
    const p = byId.get(req.productId);
    if (!p || !p.active) throw new Error(`Product unavailable: ${req.productId}`);

    let unitMinor = moneyToMinor(p.price);
    let name = p.name;
    if (req.variantId) {
      const v = p.variants?.find((x) => x.variantId === req.variantId);
      if (!v) throw new Error(`Variant unavailable: ${req.variantId}`);
      unitMinor += moneyToMinor(v.priceDelta);
      name = `${p.name} — ${v.label}`;
    }
    if (unitMinor < 0) throw new Error("Negative line price");

    out.push({ productId: p.productId, variantId: req.variantId, name, qty: req.qty, unitPrice: minorToMoney(unitMinor) });
    totalMinor += unitMinor * req.qty;
  }
  return { lines: out, total: minorToMoney(totalMinor) };
}
