/**
 * Shop crypto (USDC) on-chain settlement — the funds path for web-storefront
 * checkout. Mirrors the events USDC transfer in `pay.ts` but is shop/order
 * scoped and reuses the same audited confirmation-wait.
 *
 * The buyer pays EXACTLY `quote.amountAtomic` (server-signed, USDC 6-dec atomic)
 * to `quote.recipient` (the merchant). No client-side fiat re-derivation — the
 * HMAC-signed quote is the sole source of truth for the amount; the server
 * exact-matches the on-chain transfer against it.
 *
 * Payer binding (anti front-running): the connected wallet signs the legible,
 * domain-separated EIP-712 `ShopPayment` envelope BEFORE the transfer (it omits
 * the txHash, so it is pre-signable — no sign → wait → sign-again stall). The
 * server reconstructs the same message from the authoritative quote and requires
 * the recovered signer to equal `tx.from`. This is the universal path: it needs
 * no WoCo session, so it works in standalone deployed sites and the main app
 * alike. (A logged-in wallet buyer could instead bind via their session in one
 * prompt; that optimisation is deferred — the binding path is correct for all.)
 */

import { Contract } from "ethers";
import type {
  Hex0x,
  PaymentChainId,
  ShopPaymentBinding,
  ShopPaymentQuote,
} from "@woco/shared";
import { USDC_ADDRESSES } from "@woco/shared";
import { switchChain } from "./chains.js";
import { waitForConfirmations } from "./pay.js";
import { getEthersProvider } from "../wallet/provider.js";
import { buildShopPaymentTypedData } from "../api/shop-payment.js";

/** Minimal ERC-20 surface — only the transfer we call. */
const ERC20_ABI = ["function transfer(address to, uint256 amount) returns (bool)"];

export type ShopPayProgress = (ev: {
  phase: "switch-chain" | "sign-binding" | "send-tx" | "waiting-confirmations" | "confirmed";
  current?: number;
  total?: number;
  txHash?: string;
}) => void;

export interface ShopUSDCResult {
  txHash: string;
  chainId: PaymentChainId;
  /** EIP-712 payer proof — submitted with the settlement so the server can bind tx.from. */
  binding: ShopPaymentBinding;
}

/**
 * Execute the USDC transfer for a shop order against a server-signed quote and
 * return the proof material (txHash + EIP-712 binding). The caller hands this to
 * `submitShopCryptoPayment` to flip the order pending → paid.
 */
export async function payShopUSDC(opts: {
  quote: ShopPaymentQuote;
  onProgress?: ShopPayProgress;
}): Promise<ShopUSDCResult> {
  const { quote, onProgress } = opts;
  const chainId = quote.chainId;

  const usdcAddress = USDC_ADDRESSES[chainId];
  if (!usdcAddress) throw new Error(`USDC not supported on chain ${chainId}`);

  onProgress?.({ phase: "switch-chain" });
  await switchChain(chainId);
  // Mirror pay.ts: brief settle after a chain switch — avoids stale prompts on
  // some mobile wallets where the switch ack races the next request.
  await new Promise((r) => setTimeout(r, 500));

  const provider = await getEthersProvider();
  const signer = await provider.getSigner();
  const payer = (await signer.getAddress()).toLowerCase() as Hex0x;

  // 1. Pre-sign the legible binding (no txHash inside — server pins amount via quote).
  onProgress?.({ phase: "sign-binding" });
  const typed = buildShopPaymentTypedData(quote, payer);
  const signature = await signer.signTypedData(typed.domain, typed.types, typed.message);
  const binding: ShopPaymentBinding = { payer, signature };

  // 2. Transfer the EXACT quoted atomic amount to the merchant.
  const usdc = new Contract(usdcAddress, ERC20_ABI, signer);
  onProgress?.({ phase: "send-tx" });
  const tx = await usdc.transfer(quote.recipient, BigInt(quote.amountAtomic));

  await waitForConfirmations(tx, chainId, onProgress);

  return { txHash: tx.hash, chainId, binding };
}
