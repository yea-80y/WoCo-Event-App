import type { PaymentChainId, PaymentProof } from "@woco/shared";

export type ShortfallData = {
  txHash: string;
  chainId: PaymentChainId;
  paid: string;
  expected: string;
  currency: string;
  at: string;
};

interface UseShortfallOpts {
  eventId: string;
  seriesId: string;
}

/**
 * Payment-shortfall receipt state. Surfaces a dedicated card when an on-chain
 * payment confirmed but came in below the server's required amount (price moved
 * beyond slippage between quote and verification — tx is on-chain, ticket was
 * NOT issued). Persisted to sessionStorage so the buyer can navigate away and
 * return to it before dismissing.
 */
export function useShortfall(opts: UseShortfallOpts) {
  const storageKey = `woco:payment-shortfall:${opts.eventId}:${opts.seriesId}`;

  function hydrate(): ShortfallData | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = sessionStorage.getItem(storageKey);
      return raw ? (JSON.parse(raw) as ShortfallData) : null;
    } catch {
      return null;
    }
  }

  let data = $state<ShortfallData | null>(hydrate());

  return {
    get data() { return data; },
    /**
     * Detect a server "Paid X ETH/USDC, expected Y" response. If matched,
     * stash the receipt and return true so the caller can short-circuit its
     * generic error path.
     */
    apply(msg: string, proof: PaymentProof): boolean {
      const m = msg.match(/Paid\s+([\d.]+)\s+(ETH|USDC),\s*expected\s+([\d.]+)\s+(?:ETH|USDC)/i);
      if (!m || proof.type !== "tx" || !proof.txHash) return false;
      const next: ShortfallData = {
        txHash: proof.txHash,
        chainId: proof.chainId,
        paid: m[1],
        expected: m[3],
        currency: m[2].toUpperCase(),
        at: new Date().toISOString(),
      };
      data = next;
      try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* ignore */ }
      return true;
    },
    dismiss(): void {
      data = null;
      try { sessionStorage.removeItem(storageKey); } catch { /* ignore */ }
    },
  };
}
