import { BrowserProvider } from "ethers";
import type { EIP712Signer } from "@woco/shared";

/**
 * Connect an EXTERNAL "backup wallet" for account recovery and expose it as a
 * provider-agnostic `BackupWallet`. This is intentionally separate from the
 * session wallet plumbing: the backup is a wallet the user controls elsewhere
 * (e.g. MetaMask) that acts as their recovery key. It only ever SIGNS — it never
 * becomes the logged-in identity.
 *
 * A backup plays TWO crypto roles, which need different signing capabilities:
 *  - ESCROW (setup + recovery): derive the X25519 escrow key from a deterministic
 *    EIP-712 signature → `signTypedData`. Every wallet can do this.
 *  - GUARDIAN (recovery only): sign the weighted-ECDSA guardian userOp that calls
 *    `target.doRecovery` → a viem/EIP-1193 `Signer`. NOT every provider exposes
 *    one (a future email wallet might only give typed-data signing), so it is
 *    OPTIONAL and gated by `recoveryReady`. A backup that is not `recoveryReady`
 *    can be derived but MUST NOT be installed as a real backup — that would trap
 *    the user with an account they can never recover.
 *
 * We talk to the injected provider directly (a fresh BrowserProvider) so this
 * cannot disturb a passkey session that has no injected wallet attached.
 */
export interface BackupWallet {
  address: string;
  /** EIP-712 typed-data signer — derives the escrow X25519 key (setup + recovery). */
  signTypedData: EIP712Signer;
  /**
   * Build the viem `Signer` (OneOf<EIP1193Provider | WalletClient | LocalAccount |
   * SmartAccount>) that signs the guardian userOp during `recoverAccount`. Absent
   * ⇒ this backup cannot complete a recovery yet (see `recoveryReady`).
   */
  getGuardianSigner?: () => Promise<unknown>;
  /** True iff `getGuardianSigner` is available → safe to install as a real backup. */
  recoveryReady: boolean;
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

  // Guardian signer: a viem WalletClient bound to the chosen account, talking to
  // the same injected provider. weighted-ECDSA signs the approval as an EIP-191
  // personal_sign (chain-agnostic), so we do NOT force a chain switch here.
  const getGuardianSigner = async () => {
    const [{ createWalletClient, custom }, { arbitrumSepolia }] = await Promise.all([
      import("viem"),
      import("viem/chains"),
    ]);
    return createWalletClient({
      account: address as `0x${string}`,
      chain: arbitrumSepolia,
      transport: custom(injected as Parameters<typeof custom>[0]),
    });
  };

  return { address, signTypedData, getGuardianSigner, recoveryReady: true };
}
