/**
 * Shop platform-fee configuration.
 *
 * Card uses the fixed `PLATFORM_FEE_BP` (1.5%, in shared). Crypto is
 * operationally lighter (no mint/POD/PNG/email/sponsor gas — just a feed flip)
 * so it starts at 0.25% with a roadmap to ratchet toward a flat micro-fee. Both
 * components are env-overridable so the rate can be reduced over time without a
 * rebuild:
 *   SHOP_CRYPTO_FEE_BP          (default 25 = 0.25%)
 *   SHOP_CRYPTO_FEE_FLAT_MINOR  (default 0  = no flat component)
 *
 * The crypto fee is NOT collected on the launch online direct-transfer rail
 * (a single ERC-20 transfer can't split merchant/platform non-custodially) —
 * the buyer pays the FULL amount to the merchant. The rate is recorded on the
 * quote/order so the future escrow/splitter/aggregator path knows the agreed
 * terms; collection moves there. See docs/WOCO_SHOP_PLAN.md §2.
 */

import { DEFAULT_CRYPTO_FEE } from "@woco/shared";
import type { CryptoFeeConfig } from "@woco/shared";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  // Reject NaN / negative / non-integer overrides rather than silently mispricing.
  if (!Number.isInteger(n) || n < 0) {
    console.warn(`[shop-fees] Ignoring invalid ${name}=${raw} — using ${fallback}`);
    return fallback;
  }
  return n;
}

/** Resolve the effective crypto fee config (env overrides over shared defaults). */
export function getCryptoFeeConfig(): CryptoFeeConfig {
  return {
    bp: intEnv("SHOP_CRYPTO_FEE_BP", DEFAULT_CRYPTO_FEE.bp),
    flatMinor: intEnv("SHOP_CRYPTO_FEE_FLAT_MINOR", DEFAULT_CRYPTO_FEE.flatMinor),
  };
}
