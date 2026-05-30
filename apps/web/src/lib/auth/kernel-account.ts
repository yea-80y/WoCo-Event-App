/**
 * ZeroDev Kernel (ERC-4337) smart-account layer — item #1b, Option 1
 * (ECDSA-over-PRF Kernel) on Arbitrum Sepolia (421614).
 *
 * The Kernel's sudo signer is the user's PRF-derived secp256k1 key (from
 * passkey-account.ts), wrapped by @zerodev/ecdsa-validator. The Kernel becomes
 * the user's on-chain identity (auth-store `_parent`) and signs the HTTP
 * `AuthorizeSession` as an ERC-1271 / ERC-6492 signature. The server verifier
 * (apps/server/src/lib/auth/verify-delegation.ts) already accepts that shape
 * via viem's universal validator — no server change.
 *
 * INVARIANTS (crypto-lead, see docs/ZERODEV_PASSKEY_INTEGRATION_PLAN.md):
 *  - #1 POD identity is NEVER derived from the Kernel. Smart-account signatures
 *    are non-deterministic; POD stays on the raw PRF key + PRF-EOA address
 *    (auth-store `_getPodSigner` / `_podAddress`).
 *  - #4 The sudo signer is exposed behind `KernelSudoValidator` so the
 *    post-buildathon swap to @zerodev/passkey-validator (Option 2) is a change
 *    to this file only.
 *
 * All heavy ZeroDev/viem code is pulled via dynamic import so the bundle only
 * loads when a passkey user actually logs in (same lazy pattern as
 * coinbase-account.ts).
 */

import type { Address } from "viem";
import type { KernelValidator } from "@zerodev/sdk/types";
import type { CreateKernelAccountReturnType, KernelAccountClient } from "@zerodev/sdk";
import type { EIP712Signer } from "@woco/shared";

/** Arbitrum Sepolia — the buildathon chain. */
export const KERNEL_CHAIN_ID = 421614;

/** EntryPoint 0.7 + stable Kernel v3.1, fixed for this whole layer. */
type KernelAccount = CreateKernelAccountReturnType<"0.7">;

/**
 * Pluggable sudo validator (invariant #4). Today: ECDSA over the PRF key.
 * Later (Option 2): @zerodev/passkey-validator. Callers depend on this shape,
 * not the concrete backing, so swapping is localized to this module.
 */
export interface KernelSudoValidator {
  validator: KernelValidator;
  kind: "ecdsa" | "passkey";
}

export interface BuiltKernel {
  /** Deterministic Kernel address (CREATE2 from validator + owner), lowercased. */
  address: string;
  account: KernelAccount;
  kernelClient: KernelAccountClient;
  sudo: KernelSudoValidator;
}

function getRpcUrl(): string {
  const url = import.meta.env.VITE_ZERODEV_RPC as string | undefined;
  if (!url) {
    throw new Error("VITE_ZERODEV_RPC is not set — cannot build the ZeroDev Kernel.");
  }
  return url;
}

/**
 * Build the Kernel smart account from a raw secp256k1 private key (the PRF key).
 * The Kernel address is deterministic, so it is stable across reloads for the
 * same passkey.
 */
export async function buildKernelFromPrivateKey(privateKey: string): Promise<BuiltKernel> {
  const [
    { createPublicClient, http },
    { privateKeyToAccount },
    { arbitrumSepolia },
    { createKernelAccount, createKernelAccountClient, createZeroDevPaymasterClient },
    { signerToEcdsaValidator },
    { getEntryPoint, KERNEL_V3_1 },
  ] = await Promise.all([
    import("viem"),
    import("viem/accounts"),
    import("viem/chains"),
    import("@zerodev/sdk"),
    import("@zerodev/ecdsa-validator"),
    import("@zerodev/sdk/constants"),
  ]);

  const rpcUrl = getRpcUrl();
  const entryPoint = getEntryPoint("0.7");
  const kernelVersion = KERNEL_V3_1;

  const publicClient = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(rpcUrl),
  });

  // PRF key (0x-prefixed) → viem local account → ECDSA sudo validator.
  const signer = privateKeyToAccount(privateKey as Address);
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer,
    entryPoint,
    kernelVersion,
  });
  const sudo: KernelSudoValidator = { validator: ecdsaValidator, kind: "ecdsa" };

  const account = await createKernelAccount(publicClient, {
    plugins: { sudo: ecdsaValidator },
    entryPoint,
    kernelVersion,
  });

  const paymaster = createZeroDevPaymasterClient({
    chain: arbitrumSepolia,
    transport: http(rpcUrl),
  });

  const kernelClient = createKernelAccountClient({
    account,
    chain: arbitrumSepolia,
    bundlerTransport: http(rpcUrl),
    client: publicClient,
    paymaster: {
      getPaymasterData: (userOperation) => paymaster.sponsorUserOperation({ userOperation }),
    },
  });

  return {
    address: account.address.toLowerCase(),
    account,
    kernelClient,
    sudo,
  };
}

/**
 * Adapt the Kernel account into our ethers-shaped `EIP712Signer`
 * `(domain, types, value) => Promise<sig>`. `primaryType` is the first key of
 * `types` (e.g. "AuthorizeSession"). Returns the ERC-1271/6492 signature the
 * server already verifies. (Mirrors coinbase-signer.ts.)
 */
export function createKernelTypedDataSigner(account: KernelAccount): EIP712Signer {
  return async (domain, types, value) => {
    const primaryType = Object.keys(types)[0];
    if (!primaryType) {
      throw new Error("createKernelTypedDataSigner: `types` is empty.");
    }
    return account.signTypedData({
      domain,
      types,
      primaryType,
      message: value,
    } as Parameters<typeof account.signTypedData>[0]);
  };
}
