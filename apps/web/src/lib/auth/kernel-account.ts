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

import type { Address, Hex } from "viem";
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
 * Total gas budget (wei) the scoped session key may consume across all its
 * userOps (the GasPolicy `allowed` cap). 0.2 ETH-equivalent — effectively
 * unlimited on Arb Sepolia where gas is ~free, but still a finite cap so a
 * leaked key can't burn the sponsor tank without bound.
 */
const SESSION_GAS_ALLOWANCE_WEI = 200000000000000000n; // 0.2 ETH

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

/**
 * EIP-1577 / ENSIP-7 contenthash prefix for a Swarm BZZ hash. Mirrors
 * SWARM_ENS_PREFIX in apps/server/.../sub-ens-contract.ts:
 * swarm-manifest codec | version 1 | swarm network | keccak-256 | len 0x20.
 */
const SWARM_CONTENTHASH_PREFIX = "e40101fa011b20";

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
    { createKernelAccount, createKernelAccountClient, createZeroDevPaymasterClient, addressToEmptyAccount },
    { getEntryPoint, KERNEL_V3_1 },
    { toPermissionValidator, serializePermissionAccount, deserializePermissionAccount },
    { toECDSASigner },
    { toCallPolicy, CallPolicyVersion, toGasPolicy, toTimestampPolicy, toRateLimitPolicy, ParamCondition },
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
    addressToEmptyAccount,
    toPermissionValidator,
    serializePermissionAccount,
    deserializePermissionAccount,
    toECDSASigner,
    toCallPolicy,
    CallPolicyVersion,
    toGasPolicy,
    toTimestampPolicy,
    toRateLimitPolicy,
    ParamCondition,
  };
}

// ---------------------------------------------------------------------------
// Shop spend permission (POS tap-and-go) — grant a capped, time-boxed draw
// authority to the VENUE's spender. Unlike the registrar session key above
// (which the user holds and drives themselves), this delegates to a third party
// the user does NOT hold the key for: the attendee names the spender via
// `addressToEmptyAccount`, sudo-signs the enable data once, and serializes the
// approval (no private key). The venue's spender combines that approval with its
// own key (server-side, today) to draw `USDC.transfer(merchant, amount)` —
// nothing else. See packages/shared SpendPermissionGrantParams.
// ---------------------------------------------------------------------------

/** Minimal ABI so the call policy pins the spender to exactly `USDC.transfer`. */
const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export interface ShopSpendGrantArgs {
  builtKernel: BuiltKernel;
  /** Venue spender to authorize (from grant-params). */
  spenderAddress: string;
  /** USDC token address on the grant chain. */
  usdcAddress: string;
  /** Merchant recipient — the ONLY address a draw may pay (pinned in policy). */
  recipient: string;
  /** Max single-draw amount, 6-dec atomic (call-policy `value` ceiling). */
  perDrawCeilingAtomic: string;
  /** Max number of draws in the window (rate-limit policy). */
  maxDraws: number;
  /** Unix seconds — permission expiry (timestamp policy `validUntil`). */
  validUntil: number;
}

/**
 * Build + sudo-sign a spend-permission approval for the venue spender and return
 * the serialized blob (no private key). ONE passkey ceremony — the sudo signer
 * is the already-unlocked PRF Kernel, same as createWocoSessionKey.
 *
 * On-chain constraints embedded in the approval (the trustless backstop):
 *  - call policy: target = USDC, fn = transfer, arg `to` EQUAL merchant,
 *    arg `value` LESS_THAN_OR_EQUAL perDrawCeiling
 *  - timestamp policy: validUntil (the window)
 *  - rate-limit policy: at most maxDraws calls (lifetime)
 *  - gas policy: finite gasless budget (paymaster-sponsored on Arb Sepolia)
 *
 * The cumulative cap is NOT an on-chain policy (this ZeroDev version has no
 * spending-limit policy) — it travels in the register request and is enforced
 * server-side. The on-chain `to`/ceiling/window/count above still bound a leaked
 * spender key to bounded, merchant-only, in-window over-charges (refundable),
 * never an attacker-directed drain.
 */
export async function grantShopSpendPermission(args: ShopSpendGrantArgs): Promise<string> {
  const d = await loadSessionDeps();

  // Empty-account signer: the attendee approves a permission for a key it does
  // NOT hold — the venue's spender. This is the ERC-7710 delegation primitive.
  const emptySpender = d.addressToEmptyAccount(args.spenderAddress as Address);
  const spenderSigner = await d.toECDSASigner({ signer: emptySpender });

  const policies = [
    d.toCallPolicy({
      policyVersion: d.CallPolicyVersion.V0_0_5,
      permissions: [
        {
          target: args.usdcAddress as Address,
          abi: ERC20_TRANSFER_ABI,
          functionName: "transfer",
          args: [
            { condition: d.ParamCondition.EQUAL, value: args.recipient as Address },
            {
              condition: d.ParamCondition.LESS_THAN_OR_EQUAL,
              value: BigInt(args.perDrawCeilingAtomic),
            },
          ],
        },
      ],
    }),
    d.toTimestampPolicy({ validUntil: args.validUntil }),
    d.toRateLimitPolicy({ count: args.maxDraws }),
    d.toGasPolicy({ allowed: SESSION_GAS_ALLOWANCE_WEI }),
  ];

  const permissionPlugin = await d.toPermissionValidator(d.publicClient, {
    signer: spenderSigner,
    policies,
    entryPoint: d.entryPoint,
    kernelVersion: d.kernelVersion,
  });

  const sessionAccount = await d.createKernelAccount(d.publicClient, {
    plugins: {
      sudo: args.builtKernel.sudo.validator,
      regular: permissionPlugin,
    },
    entryPoint: d.entryPoint,
    kernelVersion: d.kernelVersion,
  });

  // No private key argument → the serialized blob is an APPROVAL (sudo-signed
  // enable data) the venue spender combines with its own key. The attendee
  // never hands out a spendable key.
  return d.serializePermissionAccount(sessionAccount);
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
        // NOTE: EAS attest/revoke permissions were briefly added here (#4 likes)
        // but their deeply-nested-tuple ABI, baked into this key's enable-data,
        // made ZeroDev's paymaster fail to estimate the account (verificationGas
        // = 0 → AA34 / bundler reject), breaking sub-ENS claim too. EAS likes
        // need a separate session key (or selector-only pinning) — tracked
        // separately. Keep this key minimal: registerWithPermit only.
      ],
    }),
    // `allowed` is the TOTAL gas budget (wei) this session key may consume —
    // NOT "self-paid only". 0n = zero budget → every op fails PolicyFailed(1),
    // so it must be a real cap. Generous on Arb Sepolia (gas is ~free).
    // `enforcePaymaster` is intentionally NOT set: ZeroDev's sponsor call
    // simulates validation BEFORE attaching its paymaster, so enforcing one
    // there trips the same PolicyFailed. Scope stays tight via the call policy
    // (registerWithPermit only, no ETH value) + the 30-day timestamp policy.
    // TODO(post-buildathon): restore enforcePaymaster once the sponsor-then-send
    // ordering is confirmed (so a leaked key can't burn Kernel ETH on gas).
    d.toGasPolicy({ allowed: SESSION_GAS_ALLOWANCE_WEI }),
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

/**
 * Send a gasless userOp through a WoCo session-key Kernel client — the single
 * choke point every session-key action shares (sub-ENS claim, EAS like/follow),
 * so send + receipt handling lives in one place. Returns the userOp hash + full
 * receipt (callers read txHash; EAS reads logs for the attestation UID).
 */
export async function sendSessionUserOp(
  client: KernelAccountClient,
  calls: { to: Address; data: Hex; value?: bigint }[],
): Promise<{
  userOpHash: Hex;
  receipt: Awaited<ReturnType<KernelAccountClient["waitForUserOperationReceipt"]>>;
}> {
  const userOpHash = await client.sendUserOperation({ calls });
  const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash });
  return { userOpHash, receipt };
}

export interface SubEnsPermitArgs {
  /** Kernel address that owns the session key AND is the permit's `owner`. */
  kernelAddress: string;
  /** Registrar address returned by /api/sub-ens/permit (cross-checked here). */
  registrarAddress: string;
  label: string;
  expiry: number;
  /** 0x 65-byte permit signature from the server (sponsor key). */
  sig: string;
  /** 64-char hex Swarm BZZ hash (no 0x) → ENS contenthash; omit for empty. */
  swarmHash?: string;
  textKeys?: string[];
  textValues?: string[];
}

/**
 * Submit `registerWithPermit` as a gasless userOp signed by the scoped session
 * key. The permit binds only (label, owner, expiry); owner MUST be the Kernel
 * address (= the parentAddress the server authenticated when issuing the
 * permit), so the new name is owned by the user's smart account.
 *
 * Hard guard (plan flag A): the session key's call policy is pinned to
 * WOCO_REGISTRAR_ADDRESS. If the permit points at a different registrar the
 * policy would silently reject the userOp — we fail loudly up front instead.
 */
export async function registerSubEnsViaPermit(
  args: SubEnsPermitArgs,
): Promise<{ userOpHash: string; txHash: string }> {
  if (args.registrarAddress.toLowerCase() !== WOCO_REGISTRAR_ADDRESS.toLowerCase()) {
    throw new Error(
      `Registrar mismatch: permit=${args.registrarAddress} policy=${WOCO_REGISTRAR_ADDRESS}. Refusing to submit.`,
    );
  }

  const client = await getWocoSessionClient(args.kernelAddress);
  if (!client) {
    throw new Error("No WoCo session key on this device — call createWocoSessionKey first.");
  }

  const { encodeFunctionData } = await import("viem");

  const contenthash: Hex = args.swarmHash
    ? (`0x${SWARM_CONTENTHASH_PREFIX}${args.swarmHash.replace(/^0x/, "")}` as Hex)
    : "0x";

  const data = encodeFunctionData({
    abi: REGISTRAR_PERMIT_ABI,
    functionName: "registerWithPermit",
    args: [
      args.label,
      args.kernelAddress as Address,
      contenthash,
      args.textKeys ?? [],
      args.textValues ?? [],
      BigInt(args.expiry),
      args.sig as Hex,
    ],
  });

  const { userOpHash, receipt } = await sendSessionUserOp(client, [
    { to: WOCO_REGISTRAR_ADDRESS as Address, data },
  ]);
  return { userOpHash, txHash: receipt.receipt.transactionHash };
}
