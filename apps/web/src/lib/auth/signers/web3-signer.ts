import type { TypedDataField } from "ethers";
import type { EIP712Signer } from "@woco/shared";
import { getEthersProvider } from "../../wallet/provider.js";

/**
 * Create an EIP-712 signer that delegates to a browser wallet (MetaMask, etc.).
 * ethers is imported lazily so signer factories stay off the boot path.
 */
export function createWeb3Signer(parentAddress: string): EIP712Signer {
  return async (domain, types, value) => {
    const { JsonRpcSigner } = await import("ethers");
    const signer = new JsonRpcSigner(await getEthersProvider(), parentAddress);
    return signer.signTypedData(
      domain,
      types as Record<string, TypedDataField[]>,
      value,
    );
  };
}
