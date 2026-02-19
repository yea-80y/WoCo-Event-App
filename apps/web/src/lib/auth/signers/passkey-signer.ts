import { Wallet } from "ethers";
import type { EIP712Signer } from "@woco/shared";

/**
 * Create an EIP-712 signer that signs with a passkey-derived private key.
 * No confirmation dialog — the biometric prompt at login is the user consent.
 */
export function createPasskeySigner(privateKey: string): EIP712Signer {
  const wallet = new Wallet(privateKey);
  return (domain, types, value) => wallet.signTypedData(domain, types, value);
}
