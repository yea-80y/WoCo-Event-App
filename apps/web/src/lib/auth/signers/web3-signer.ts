import { BrowserProvider, type TypedDataField } from "ethers";
import type { EIP712Signer } from "@woco/shared";
import { requireProvider } from "../../wallet/provider.js";

/**
 * Create an EIP-712 signer that delegates to a browser wallet (MetaMask, etc.).
 */
export function createWeb3Signer(parentAddress: string): EIP712Signer {
  return async (domain, types, value) => {
    const browserProvider = new BrowserProvider(requireProvider());
    const signer = await browserProvider.getSigner(parentAddress);
    return signer.signTypedData(
      domain,
      types as Record<string, TypedDataField[]>,
      value,
    );
  };
}
