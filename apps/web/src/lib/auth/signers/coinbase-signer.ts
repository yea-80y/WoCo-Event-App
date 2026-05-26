import { BrowserProvider, type Eip1193Provider, type TypedDataField } from "ethers";
import type { EIP712Signer } from "@woco/shared";
import { getCoinbaseProvider } from "../coinbase-account.js";

/**
 * EIP-712 signer backed by Coinbase Smart Wallet.
 *
 * CSW's popup IS the user confirmation — no SigningConfirmDialog layered on
 * top (same reasoning as web3-signer for MetaMask). CSW emits an ERC-6492
 * wrapped 1271 signature for smart-account addresses; the server verifier
 * handles unwrapping via viem.
 *
 * Async so the @coinbase/wallet-sdk bundle only loads when a CSW user
 * actually signs.
 */
export async function createCoinbaseSigner(parentAddress: string): Promise<EIP712Signer> {
  const cbProvider = await getCoinbaseProvider();
  const provider = new BrowserProvider(cbProvider as unknown as Eip1193Provider);
  const signer = await provider.getSigner(parentAddress);

  return async (domain, types, value) =>
    signer.signTypedData(
      domain,
      types as Record<string, TypedDataField[]>,
      value,
    );
}
