import { BrowserProvider } from "ethers";
import type { EIP712Signer } from "@woco/shared";

/**
 * Connect an EXTERNAL "backup wallet" for account recovery and expose it as an
 * EIP712Signer. This is intentionally separate from the session wallet plumbing:
 * the backup is a wallet the user controls elsewhere (e.g. MetaMask) that acts
 * as their recovery key. It only ever SIGNS — it never sends a transaction and
 * never becomes the logged-in identity.
 *
 * We talk to the injected provider directly (a fresh BrowserProvider) so this
 * cannot disturb a passkey session that has no injected wallet attached.
 */
export interface BackupWallet {
  address: string;
  signTypedData: EIP712Signer;
}

export async function connectBackupWallet(): Promise<BackupWallet> {
  const injected = (globalThis as { ethereum?: unknown }).ethereum;
  if (!injected) {
    throw new Error("No wallet found. Install a browser wallet (e.g. MetaMask) to use as your backup.");
  }

  const provider = new BrowserProvider(injected as ConstructorParameters<typeof BrowserProvider>[0]);
  // Prompt the user to pick the account that will be their backup.
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const address = (await signer.getAddress()).toLowerCase();

  const signTypedData: EIP712Signer = (domain, types, value) =>
    signer.signTypedData(
      domain as Parameters<typeof signer.signTypedData>[0],
      types as Parameters<typeof signer.signTypedData>[1],
      value as Parameters<typeof signer.signTypedData>[2],
    );

  return { address, signTypedData };
}
