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
import { StorageKeys } from "@woco/shared";
import { ensureDeviceKey, encrypt, decrypt, AAD } from "./storage/encryption.js";
import { getKV, putKV, delKV } from "./storage/indexeddb.js";

/** Arbitrum Sepolia — the buildathon chain. */
export const KERNEL_CHAIN_ID = 421614;

/**
 * WoCoRegistrar (Arb Sepolia) — the ONLY contract the scoped session key may
 * call. Matches production `server.env` SUB_ENS_REGISTRAR_ADDRESS and the
 * `registrarAddress` returned by POST /api/sub-ens/permit. (The `0x206e5e2f…`
 * default baked into the server source is a STALE fallback, overridden by env
 * in production — see plan flag A.) Phase 4 cross-checks this against the live
 * permit response before sending the userOp.
 */
export const WOCO_REGISTRAR_ADDRESS =
  "0x7c0DE55a1713e6C1a53Db50314C7CB608179aAf1" as const;

/** Scoped session-key lifetime — mirrors the 30-day HTTP session window. */
const SESSION_KEY_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Minimal ABI fragment so the call policy pins the session key to exactly
 * `registerWithPermit` on the registrar (function-selector scoped, not merely
 * target-scoped). Mirrors REGISTRAR_ABI in apps/server/src/lib/chain/sub-ens-contract.ts.
 */
const REGISTRAR_PERMIT_ABI = [
  {
    type: "function",
    name: "registerWithPermit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "label", type: "string" },
      { name: "owner", type: "address" },
      { name: "contenthash", type: "bytes" },
      { name: "textKeys", type: "string[]" },
      { name: "textValues", type: "string[]" },
      { name: "expiry", type: "uint256" },
      { name: "sig", type: "bytes" },
    ],
    outputs: [{ name: "node", type: "bytes32" }],
  },
] as const;

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

// ---------------------------------------------------------------------------
// Phase 3 — scoped on-chain ZeroDev session keys (@zerodev/permissions)
//
// A session key is a fresh secp256k1 key whose authority on the Kernel is
// constrained by policies: it may ONLY call registerWithPermit on the
// WoCoRegistrar (call policy), it may NEVER spend the Kernel's own ETH
// (gas policy: allowed=0 + enforcePaymaster), and it expires (timestamp
// policy). The serialized permission account — which embeds the session
// private key — is encrypted at rest (AAD bound to the Kernel address) so a
// leaked IndexedDB blob is useless to another identity and, even for the same
// identity, can do nothing but fire gasless registerWithPermit calls until it
// expires. This is invariant #3: scoped, never sudo.
// ---------------------------------------------------------------------------

/** Shared ZeroDev/viem runtime bits for the session-key path (lazy-loaded). */
async function loadSessionDeps() {
  const [
    { createPublicClient, http },
    { generatePrivateKey, privateKeyToAccount },
    { arbitrumSepolia },
    { createKernelAccount, createKernelAccountClient, createZeroDevPaymasterClient },
    { getEntryPoint, KERNEL_V3_1 },
    { toPermissionValidator, serializePermissionAccount, deserializePermissionAccount },
    { toECDSASigner },
    { toCallPolicy, CallPolicyVersion, toGasPolicy, toTimestampPolicy },
  ] = await Promise.all([
    import("viem"),
    import("viem/accounts"),
    import("viem/chains"),
    import("@zerodev/sdk"),
    import("@zerodev/sdk/constants"),
    import("@zerodev/permissions"),
    import("@zerodev/permissions/signers"),
    import("@zerodev/permissions/policies"),
  ]);

  const rpcUrl = getRpcUrl();
  const entryPoint = getEntryPoint("0.7");
  const kernelVersion = KERNEL_V3_1;
  const publicClient = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(rpcUrl),
  });

  return {
    rpcUrl,
    entryPoint,
    kernelVersion,
    publicClient,
    arbitrumSepolia,
    http,
    generatePrivateKey,
    privateKeyToAccount,
    createKernelAccount,
    createKernelAccountClient,
    createZeroDevPaymasterClient,
    toPermissionValidator,
    serializePermissionAccount,
    deserializePermissionAccount,
    toECDSASigner,
    toCallPolicy,
    CallPolicyVersion,
    toGasPolicy,
    toTimestampPolicy,
  };
}

/**
 * Mint a fresh scoped session key for the given Kernel, serialize it (the
 * serialized blob includes the session private key + the sudo-signed enable
 * data), encrypt it under the Kernel address, and persist it to IndexedDB.
 *
 * The sudo validator (ECDSA over the in-memory PRF key) signs the enable data
 * synchronously — no additional passkey prompt beyond the one that already
 * unlocked the PRF key for this session. Returns the session-account address.
 */
export async function createWocoSessionKey(builtKernel: BuiltKernel): Promise<string> {
  const d = await loadSessionDeps();

  const sessionPk = d.generatePrivateKey();
  const sessionSigner = await d.toECDSASigner({
    signer: d.privateKeyToAccount(sessionPk),
  });

  const validUntil = Math.floor(Date.now() / 1000) + SESSION_KEY_TTL_SECONDS;

  const policies = [
    d.toCallPolicy({
      policyVersion: d.CallPolicyVersion.V0_0_5,
      permissions: [
        {
          target: WOCO_REGISTRAR_ADDRESS as Address,
          abi: REGISTRAR_PERMIT_ABI,
          functionName: "registerWithPermit",
        },
      ],
    }),
    // allowed=0 + enforcePaymaster: the session key cannot spend the Kernel's
    // own ETH — it can only ever run gasless through the ZeroDev paymaster.
    d.toGasPolicy({ allowed: 0n, enforcePaymaster: true }),
    d.toTimestampPolicy({ validUntil }),
  ];

  const permissionPlugin = await d.toPermissionValidator(d.publicClient, {
    signer: sessionSigner,
    policies,
    entryPoint: d.entryPoint,
    kernelVersion: d.kernelVersion,
  });

  const sessionAccount = await d.createKernelAccount(d.publicClient, {
    plugins: {
      sudo: builtKernel.sudo.validator,
      regular: permissionPlugin,
    },
    entryPoint: d.entryPoint,
    kernelVersion: d.kernelVersion,
  });

  const serialized = await d.serializePermissionAccount(sessionAccount, sessionPk);

  const deviceKey = await ensureDeviceKey();
  const blob = await encrypt(deviceKey, AAD.WOCO_AA_SESSION(builtKernel.address), serialized);
  await putKV(StorageKeys.WOCO_AA_SESSION, blob);

  return sessionAccount.address.toLowerCase();
}

/** True if a session key is persisted for this device (independent of whether
 *  it still decrypts / is unexpired). */
export async function hasWocoSessionKey(): Promise<boolean> {
  return (await getKV(StorageKeys.WOCO_AA_SESSION)) != null;
}

/** Drop the persisted session key (logout / identity switch). */
export async function clearWocoSessionKey(): Promise<void> {
  await delKV(StorageKeys.WOCO_AA_SESSION);
}

/**
 * Rebuild a gasless Kernel client backed by the stored session key — no passkey
 * prompt. Returns null when no session key is stored (caller falls back to
 * createWocoSessionKey or the sponsor path). Decryption is AAD-bound to
 * `kernelAddress`, so a session minted by a different Kernel will not open.
 */
export async function getWocoSessionClient(
  kernelAddress: string,
): Promise<KernelAccountClient | null> {
  const blob = await getKV<import("@woco/shared").EncryptedBlob>(StorageKeys.WOCO_AA_SESSION);
  if (!blob) return null;

  const d = await loadSessionDeps();

  const deviceKey = await ensureDeviceKey();
  const serialized = await decrypt<string>(
    deviceKey,
    AAD.WOCO_AA_SESSION(kernelAddress),
    blob,
  );

  const sessionAccount = await d.deserializePermissionAccount(
    d.publicClient,
    d.entryPoint,
    d.kernelVersion,
    serialized,
  );

  const paymaster = d.createZeroDevPaymasterClient({
    chain: d.arbitrumSepolia,
    transport: d.http(d.rpcUrl),
  });

  return d.createKernelAccountClient({
    account: sessionAccount,
    chain: d.arbitrumSepolia,
    bundlerTransport: d.http(d.rpcUrl),
    client: d.publicClient,
    paymaster: {
      getPaymasterData: (userOperation) => paymaster.sponsorUserOperation({ userOperation }),
    },
  });
}
