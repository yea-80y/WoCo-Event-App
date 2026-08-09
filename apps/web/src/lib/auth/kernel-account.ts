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
import { StorageKeys, EAS_ADDRESS } from "@woco/shared";
import { EAS_SESSION_ABI } from "../eas/eas-abi.js";
import { ensureDeviceKey, encrypt, decrypt, AAD } from "./storage/encryption.js";
import { getKV, putKV, delKV } from "./storage/indexeddb.js";
import {
  KERNEL_SELECTOR_CONFIG_ABI,
  RECOVERY_CALLER_HOOK,
  RECOVERY_EXECUTOR_FN,
  buildRegisterGuardianCallData,
  buildUninstallRecoveryCallData,
  recoveryRouteSelector,
} from "./recovery-route.js";

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
 *
 * `opts.address` OVERRIDES the counterfactual CREATE2 address. This is required
 * only on the recovery path: after `recoverAccount` rotates the deployed Kernel's
 * sudo owner to a fresh passkey, the new PRF key would otherwise derive a *different*
 * counterfactual address (CREATE2 mixes the original owner). Passing the original,
 * deployed Kernel address pins the account object to the recovered account so the
 * new owner controls the SAME address (matches recovery-spike-caller-hook.ts step
 * [4], PASS). NEVER pass this on the normal login path — divergence there is a bug
 * the `_ensureKernel` guard must still catch.
 */
export async function buildKernelFromPrivateKey(
  privateKey: string,
  opts?: { address?: string },
): Promise<BuiltKernel> {
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
    ...(opts?.address ? { address: opts.address as Address } : {}),
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
    // `interval` MUST be non-zero: the on-chain RateLimitPolicy does time-bucket
    // math with it, and interval=0 (the lib default when only `count` is passed)
    // is a footgun. Set it to the permission's remaining lifetime so the window
    // never refills before expiry → `count` is an effective LIFETIME cap of
    // maxDraws. (Same fix as the agent rail's buildAgentSpendGrant.)
    d.toRateLimitPolicy({
      count: args.maxDraws,
      interval: Math.max(args.validUntil - Math.floor(Date.now() / 1000), 1),
    }),
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
    // Pin to the built Kernel's address (see createWocoSessionKey) — a
    // recovered attendee's approval must draw from the preserved account, not
    // the rotated sudo key's counterfactual.
    address: args.builtKernel.address as Address,
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
        // INVARIANT: this key is registerWithPermit-ONLY. EAS attest/revoke
        // were briefly added here (#4 likes); their deeply-nested-tuple ABI,
        // baked into this key's enable-data, made the paymaster fail to estimate
        // the account (verificationGas=0 → AA34 / bundler reject) and poisoned
        // sub-ENS claims too. EAS likes now have their OWN key with selector-only
        // pinning — see createEasSessionKey below. Never re-add EAS perms here.
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
    // Pin to the built Kernel's address. Without this the session account is
    // recomputed as the sudo key's counterfactual CREATE2 address — which for a
    // RECOVERED account (owner rotated, address preserved) is a DIFFERENT,
    // fresh Kernel: the userOp would deploy + act from the wrong address while
    // every server check authenticates the preserved one (split-brain).
    address: builtKernel.address as Address,
  });

  const serialized = await d.serializePermissionAccount(sessionAccount, sessionPk);

  const deviceKey = await ensureDeviceKey();
  const blob = await encrypt(deviceKey, AAD.WOCO_AA_SESSION(builtKernel.address), serialized);
  await putKV(StorageKeys.WOCO_AA_SESSION, blob);

  return sessionAccount.address.toLowerCase();
}

/**
 * Address embedded in a stored serialized permission-account blob, or null when
 * the blob is missing, was encrypted for a different Kernel (AAD mismatch), or
 * doesn't parse. Cheap: decrypt + JSON only — no account deserialization, no RPC.
 * The serialized format is @zerodev/permissions' base64(JSON) with
 * `accountParams.accountAddress` (the userOp sender the blob will act as).
 */
async function storedSessionKeyAddress(
  storageKey: string,
  aad: string,
): Promise<string | null> {
  const blob = await getKV<import("@woco/shared").EncryptedBlob>(storageKey);
  if (!blob) return null;
  try {
    const deviceKey = await ensureDeviceKey();
    const serialized = await decrypt<string>(deviceKey, aad, blob);
    const bytes = Uint8Array.from(atob(serialized), (c) => c.codePointAt(0) ?? 0);
    const params = JSON.parse(new TextDecoder().decode(bytes)) as {
      accountParams?: { accountAddress?: string };
    };
    return params?.accountParams?.accountAddress?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/** True if a session key usable by THIS Kernel is persisted on this device.
 *  A blob for a different Kernel (pre-pinning recovered-account mint, or an
 *  account switch) reports false so the caller re-mints instead of wedging. */
export async function hasWocoSessionKey(kernelAddress: string): Promise<boolean> {
  const stored = await storedSessionKeyAddress(
    StorageKeys.WOCO_AA_SESSION,
    AAD.WOCO_AA_SESSION(kernelAddress),
  );
  return stored === kernelAddress.toLowerCase();
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
  let serialized: string;
  try {
    serialized = await decrypt<string>(deviceKey, AAD.WOCO_AA_SESSION(kernelAddress), blob);
  } catch {
    // AAD mismatch — the blob belongs to a different Kernel (account switch
    // without logout). Unusable for this identity; wipe so the caller re-mints.
    await clearWocoSessionKey();
    return null;
  }

  const sessionAccount = await d.deserializePermissionAccount(
    d.publicClient,
    d.entryPoint,
    d.kernelVersion,
    serialized,
  );

  // Heal: blobs minted before address-pinning embed the sudo key's
  // counterfactual as sender — for a recovered account that is the WRONG
  // Kernel. Wipe so the caller re-mints a correctly-pinned key.
  if (sessionAccount.address.toLowerCase() !== kernelAddress.toLowerCase()) {
    console.warn(
      "[kernel] stored sub-ENS session key is for",
      sessionAccount.address,
      "not the active Kernel",
      kernelAddress,
      "— discarding",
    );
    await clearWocoSessionKey();
    return null;
  }

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

// ---------------------------------------------------------------------------
// EAS likes/following session key (#4) — a SECOND scoped session key, fully
// independent of the sub-ENS key above. Pinned to EAS attest + revoke by
// 4-byte SELECTOR (not the deeply-nested AttestationRequest ABI) — the nested
// tuple in enable-data is exactly what broke paymaster gas estimation and
// poisoned the shared key. Selector-only keeps the enable-data flat. Stored in
// its own slot (WOCO_AA_EAS_SESSION) with its own AAD so the two keys can never
// interfere with each other's estimation again.
// ---------------------------------------------------------------------------

/** 4-byte selectors for EAS attest/revoke, derived from the canonical ABI. */
async function easSelectors(): Promise<{ attest: Hex; revoke: Hex }> {
  const { toFunctionSelector } = await import("viem");
  const attest = EAS_SESSION_ABI.find((i) => i.type === "function" && i.name === "attest");
  const revoke = EAS_SESSION_ABI.find((i) => i.type === "function" && i.name === "revoke");
  if (!attest || !revoke) throw new Error("EAS_SESSION_ABI missing attest/revoke");
  return {
    attest: toFunctionSelector(attest),
    revoke: toFunctionSelector(revoke),
  };
}

/**
 * Mint a fresh EAS session key for the Kernel — selector-scoped to EAS
 * attest+revoke only — serialize, encrypt (AAD-bound to the Kernel), and persist
 * to its own IndexedDB slot. Same single-passkey-ceremony model as
 * createWocoSessionKey (the in-memory PRF sudo signs the enable data).
 */
export async function createEasSessionKey(builtKernel: BuiltKernel): Promise<string> {
  const d = await loadSessionDeps();
  const sel = await easSelectors();

  const sessionPk = d.generatePrivateKey();
  const sessionSigner = await d.toECDSASigner({ signer: d.privateKeyToAccount(sessionPk) });
  const validUntil = Math.floor(Date.now() / 1000) + SESSION_KEY_TTL_SECONDS;

  const policies = [
    d.toCallPolicy({
      policyVersion: d.CallPolicyVersion.V0_0_5,
      // Selector-only (PermissionManual): target + 4-byte selector, NO abi —
      // keeps the nested AttestationRequest tuple out of enable-data.
      permissions: [
        { target: EAS_ADDRESS as Address, selector: sel.attest },
        { target: EAS_ADDRESS as Address, selector: sel.revoke },
      ],
    }),
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
    plugins: { sudo: builtKernel.sudo.validator, regular: permissionPlugin },
    entryPoint: d.entryPoint,
    kernelVersion: d.kernelVersion,
    // Pin to the built Kernel's address (see createWocoSessionKey) — a recovered
    // account's attester must be the preserved Kernel, not the rotated sudo
    // key's counterfactual. This was the 2026-07-10 likes split-brain: the
    // attestation landed from a freshly-deployed wrong-address Kernel while the
    // HTTP session authenticated the real account, so /api/likes/record 403'd.
    address: builtKernel.address as Address,
  });

  const serialized = await d.serializePermissionAccount(sessionAccount, sessionPk);
  const deviceKey = await ensureDeviceKey();
  const blob = await encrypt(deviceKey, AAD.WOCO_AA_EAS_SESSION(builtKernel.address), serialized);
  await putKV(StorageKeys.WOCO_AA_EAS_SESSION, blob);

  return sessionAccount.address.toLowerCase();
}

/** True if an EAS session key usable by THIS Kernel is persisted on this
 *  device (same wrong-Kernel semantics as hasWocoSessionKey). */
export async function hasEasSessionKey(kernelAddress: string): Promise<boolean> {
  const stored = await storedSessionKeyAddress(
    StorageKeys.WOCO_AA_EAS_SESSION,
    AAD.WOCO_AA_EAS_SESSION(kernelAddress),
  );
  return stored === kernelAddress.toLowerCase();
}

/** Drop the persisted EAS session key (logout / identity switch). */
export async function clearEasSessionKey(): Promise<void> {
  await delKV(StorageKeys.WOCO_AA_EAS_SESSION);
}

/**
 * Rebuild a gasless Kernel client backed by the stored EAS session key — no
 * passkey prompt. Returns null when none is stored. Decryption is AAD-bound to
 * `kernelAddress` (same guard as getWocoSessionClient).
 */
export async function getEasSessionClient(
  kernelAddress: string,
): Promise<KernelAccountClient | null> {
  const blob = await getKV<import("@woco/shared").EncryptedBlob>(StorageKeys.WOCO_AA_EAS_SESSION);
  if (!blob) return null;

  const d = await loadSessionDeps();
  const deviceKey = await ensureDeviceKey();
  let serialized: string;
  try {
    serialized = await decrypt<string>(deviceKey, AAD.WOCO_AA_EAS_SESSION(kernelAddress), blob);
  } catch {
    // AAD mismatch — blob belongs to a different Kernel (see getWocoSessionClient).
    await clearEasSessionKey();
    return null;
  }

  const sessionAccount = await d.deserializePermissionAccount(
    d.publicClient,
    d.entryPoint,
    d.kernelVersion,
    serialized,
  );

  // Heal (same as getWocoSessionClient): a pre-pinning blob for a recovered
  // account would attest from the wrong Kernel — discard so the caller
  // re-mints against the active address.
  if (sessionAccount.address.toLowerCase() !== kernelAddress.toLowerCase()) {
    console.warn(
      "[kernel] stored EAS session key is for",
      sessionAccount.address,
      "not the active Kernel",
      kernelAddress,
      "— discarding",
    );
    await clearEasSessionKey();
    return null;
  }

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
/**
 * ZeroDev incident workaround (2026-06): their RPC intermittently returns a
 * stub verificationGasLimit of 1 from gas estimation, which their own bundler
 * then rejects ("verificationGasLimit must be at least 10000"). An explicitly
 * provided value bypasses the broken estimate — viem only fills MISSING gas
 * fields — and the paymaster signs over the op we actually send, so the
 * sponsorship stays valid.
 *
 * Ceiling sized for the WORST case: a brand-new account's FIRST userOp, which
 * deploys the Kernel AND runs session-key enable-mode validation with the heavy
 * EAS call policy in a single simulateValidation. That path measured ~3M; 800k
 * (fine for already-deployed "use mode" ops) reverted with AA26 over
 * verificationGasLimit on first like/follow. Same latent ceiling as the agent
 * commerce / shop rail (project_agent_commerce_aa23). Sponsored + only the limit,
 * not the spend — unused verification gas is not charged.
 *
 * 2026-07 ZeroDev TAM response: could not reproduce; estimation now returns
 * healthy values (~660k on a fresh enable-mode op) and they recommend
 * provider=ULTRA_RELAY on the RPC URL (applied in .env). Primary path trusts
 * their estimate again; this retry only fires on the exact stub error, so it
 * stays as insurance until the fix has soaked in production use.
 */
const VERIFICATION_GAS_FALLBACK = 3_000_000n;

/**
 * An ERC-4337 userOp that REVERTS in its execution phase still lands on-chain
 * inside a successful bundler transaction, with `UserOperationEvent.success =
 * false`. viem's `waitForUserOperationReceipt` resolves on the first receipt it
 * finds and never inspects `success`, so without this check a reverted op is
 * indistinguishable from a successful one — which on the recovery path meant
 * "You're protected" for an account with no recovery route, and "Account
 * recovered" for an account whose owner never rotated (#151).
 *
 * Gas estimation catches DETERMINISTIC reverts before they are ever sent, so
 * this fires mainly where estimation is bypassed: `recoverAccount` supplies an
 * explicit `callGasLimit`, which viem passes straight through.
 */
function assertUserOpSucceeded(
  userOpHash: Hex,
  receipt: { success?: boolean; reason?: string; receipt?: { transactionHash?: string } },
): void {
  if (receipt?.success === true) return;
  const reason = receipt?.reason ? `: ${receipt.reason}` : "";
  throw new Error(
    `UserOperation ${userOpHash} was included but reverted on-chain${reason} ` +
      `(tx ${receipt?.receipt?.transactionHash ?? "unknown"}).`,
  );
}

function isStubVerificationGasError(err: unknown): boolean {
  const seen = new Set<unknown>();
  for (let e = err; e && typeof e === "object" && !seen.has(e); e = (e as { cause?: unknown }).cause) {
    seen.add(e);
    const msg = (e as { message?: string }).message ?? "";
    if (/verificationGasLimit must be at least/i.test(msg)) return true;
  }
  return false;
}

export async function sendSessionUserOp(
  client: KernelAccountClient,
  calls: { to: Address; data: Hex; value?: bigint }[],
): Promise<{
  userOpHash: Hex;
  receipt: Awaited<ReturnType<KernelAccountClient["waitForUserOperationReceipt"]>>;
}> {
  let userOpHash: Hex;
  try {
    userOpHash = await client.sendUserOperation({ calls });
  } catch (err) {
    if (!isStubVerificationGasError(err)) throw err;
    // Full error (contains the rejected userOp JSON) — evidence for the ZeroDev ticket.
    console.warn("[kernel] stub verificationGasLimit — failing request was:", err);
    console.warn(
      "[kernel] retrying with explicit verificationGasLimit",
      VERIFICATION_GAS_FALLBACK,
    );
    userOpHash = await client.sendUserOperation({
      calls,
      verificationGasLimit: VERIFICATION_GAS_FALLBACK,
    });
  }
  const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash });
  assertUserOpSucceeded(userOpHash, receipt);
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

// ---------------------------------------------------------------------------
// Account recovery (docs/PASSKEY_RECOVERY_PLAN.md) — guardian-gated signer
// rotation, so a passkey Kernel can safely HOLD funds. The sudo signer (ECDSA
// over PRF) is unchanged for daily use; recovery is a SEPARATE escape path.
//
// DEPLOYED-account model (the realistic WoCo case — sub-ENS / likes already
// deploy these Kernels), verified end-to-end on Arb Sepolia by
// scripts/recovery-spike-caller-hook.ts (recovery tx 0x17f0622…, address
// preserved, old key dead): install the recovery ACTION as a fallback module
// (type 3) + a CALLER HOOK that pins the permitted guardian account address; a
// SEPARATE guardian account *calls* target.doRecovery(...), authorised by the
// hook on msg.sender. (The alternative — bolting a weighted validator onto the
// deployed account as its OWN recovery validator — reverts AA23 InvalidValidator;
// it works only baked-in at genesis. See recovery-spike-deployed.ts.)
//
// M-of-N is preserved by making the GUARDIAN account itself a weighted-ECDSA
// Kernel: "backup EOA" = 1 signer @ threshold 1 (v1), "social 2-of-3" = same
// mechanism with more signers. So who can recover is set entirely by the
// guardian account's config, not by this install.
//
// Both action + hook are cross-chain singletons live on Arb Sepolia.
// Client-first: install + rotation are sponsored userOps, no server secret.
// ---------------------------------------------------------------------------

// Addresses, ABIs and calldata for the route live in ./recovery-route.js (imported
// at the top of this file) — pure, no I/O, unit-tested against live-chain bytes.

/**
 * Guardian set for the weighted-ECDSA guardian ACCOUNT. v1 = a single backup EOA
 * (one signer, weight 100, threshold 100). Social recovery = more signers + an
 * M-of-N threshold — SAME shape, no rewrite.
 */
export interface GuardianConfig {
  signers: { address: Address; weight: number }[];
  threshold: number;
}

/** ZeroDev/viem runtime for the recovery path (lazy-loaded, off the hot path). */
async function loadRecoveryDeps() {
  const [
    { createPublicClient, http, encodeFunctionData, toFunctionSelector, parseAbi, parseAbiParameters, encodeAbiParameters, concat, erc20Abi },
    { arbitrumSepolia },
    { createKernelAccount, createKernelAccountClient, createZeroDevPaymasterClient, addressToEmptyAccount },
    { getEntryPoint, KERNEL_V3_1 },
    { getValidatorAddress },
    { createWeightedECDSAValidator },
  ] = await Promise.all([
    import("viem"),
    import("viem/chains"),
    import("@zerodev/sdk"),
    import("@zerodev/sdk/constants"),
    import("@zerodev/ecdsa-validator"),
    import("@zerodev/weighted-ecdsa-validator"),
  ]);

  const rpcUrl = getRpcUrl();
  const entryPoint = getEntryPoint("0.7");
  const kernelVersion = KERNEL_V3_1;
  const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrl) });

  return {
    rpcUrl, entryPoint, kernelVersion, publicClient, arbitrumSepolia, http,
    encodeFunctionData, toFunctionSelector, parseAbi, parseAbiParameters, encodeAbiParameters, concat, erc20Abi,
    createKernelAccount, createKernelAccountClient, createZeroDevPaymasterClient, addressToEmptyAccount,
    getValidatorAddress, createWeightedECDSAValidator,
  };
}

type RecoveryDeps = Awaited<ReturnType<typeof loadRecoveryDeps>>;

function recoverySponsor(d: RecoveryDeps) {
  const paymaster = d.createZeroDevPaymasterClient({ chain: d.arbitrumSepolia, transport: d.http(d.rpcUrl) });
  return {
    getPaymasterData: (userOperation: Parameters<typeof paymaster.sponsorUserOperation>[0]["userOperation"]) =>
      paymaster.sponsorUserOperation({ userOperation }),
  };
}

/**
 * Build the weighted-ECDSA guardian Kernel account. The address is a pure
 * function of `config` (signer addresses + weights + threshold), so passing
 * placeholder signers (setup) and real signers (recovery) yields the SAME
 * address — which is exactly the value pinned in the caller hook.
 */
async function buildGuardianAccount(
  d: RecoveryDeps,
  config: GuardianConfig,
  signers: unknown[],
) {
  const validator = await d.createWeightedECDSAValidator(d.publicClient, {
    entryPoint: d.entryPoint,
    kernelVersion: d.kernelVersion,
    config: { threshold: config.threshold, signers: config.signers },
    signers: signers as Parameters<typeof d.createWeightedECDSAValidator>[1]["signers"],
  });
  return d.createKernelAccount(d.publicClient, {
    entryPoint: d.entryPoint,
    kernelVersion: d.kernelVersion,
    plugins: { sudo: validator },
  });
}

/**
 * Deterministic address of the guardian account for a given config — the value
 * registered in the caller hook. Computed with placeholder (empty-account)
 * signers; signing capability is irrelevant to the CREATE2 address.
 */
export async function deriveGuardianAddress(config: GuardianConfig): Promise<string> {
  const d = await loadRecoveryDeps();
  const signers = config.signers.map((s) => d.addressToEmptyAccount(s.address));
  const account = await buildGuardianAccount(d, config, signers);
  return account.address.toLowerCase();
}

/** Send a sudo-signed userOp through the built Kernel, with the same stub-verificationGas retry as sendSessionUserOp. */
async function sendSudoUserOp(
  client: KernelAccountClient,
  op: { callData?: Hex; calls?: { to: Address; data: Hex; value?: bigint }[]; callGasLimit?: bigint },
): Promise<{ userOpHash: Hex; txHash: string; blockNumber?: bigint }> {
  let userOpHash: Hex;
  try {
    userOpHash = await client.sendUserOperation(op as Parameters<typeof client.sendUserOperation>[0]);
  } catch (err) {
    if (!isStubVerificationGasError(err)) throw err;
    console.warn("[kernel] recovery op got stub verificationGasLimit — failing request was:", err);
    console.warn("[kernel] retrying with explicit verificationGasLimit", VERIFICATION_GAS_FALLBACK);
    userOpHash = await client.sendUserOperation({
      ...op,
      verificationGasLimit: VERIFICATION_GAS_FALLBACK,
    } as Parameters<typeof client.sendUserOperation>[0]);
  }
  const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash });
  assertUserOpSucceeded(userOpHash, receipt);
  // blockNumber is surfaced so callers can PIN a read-back to the block the op
  // landed in, instead of asking "latest" and trusting whichever replica answers.
  return {
    userOpHash,
    txHash: receipt.receipt.transactionHash,
    blockNumber: receipt.receipt.blockNumber,
  };
}

/**
 * "Set up account recovery" ceremony — ONE sudo-signed (passkey) userOp on the
 * user's OWN Kernel that installs the recovery action + caller hook pinning
 * `guardianAddress` (derive it with deriveGuardianAddress). Deploys the Kernel
 * if still counterfactual. Sponsored; no server secret. After this, the live
 * passkey still controls the account exactly as before — only an extra recovery
 * route exists.
 */
export async function setupRecovery(
  builtKernel: BuiltKernel,
  guardianAddress: string,
): Promise<{ userOpHash: string; txHash: string }> {
  const d = await loadRecoveryDeps();
  const callData = buildRegisterGuardianCallData(d, guardianAddress as Address);
  return sendSudoUserOp(builtKernel.kernelClient, { callData });
}

// --- Removing recovery (#165) ----------------------------------------------
//
// There is NO per-guardian revoke. The ZeroDev caller hook's `onInstall` ORs each
// guardian into `allowed[guardian][kernel]` and nothing ever clears it, so a
// replaced backup keeps permanent takeover power (#148). What CAN be removed is
// the SELECTOR ROUTE itself, which sits in front of every guardian:
//
//   Kernel.sol:454-456   uninstallModule(3, …) → _uninstallSelector(bytes4(deInitData[0:4]), deInitData[4:])
//   SelectorManager:63-73 zeroes hook, target and callType for that selector
//   Kernel.sol:182-184   fallback(): if (config.hook == address(0)) revert InvalidSelector()
//
// so afterwards EVERY `doRecovery` call reverts before the hook or the action is
// reached — from any caller, including every registered guardian. Verified against
// `zerodevapp/kernel@release/v3.1`, and the live account reports
// `accountId() == "kernel.advanced.v0.3.1"`.
//
// TWO THINGS THIS DOES NOT DO, and the product must not claim otherwise:
//  - `_uninstallSelector` discards the hook it returns and never calls its
//    `onUninstall`, so `allowed[…]` survives. RE-INSTALLING against the same hook
//    address resurrects every past guardian.
//  - it cannot un-disclose the escrow: each guardian's SOC still holds a bundle
//    sealed to it (podSeed + feed-signer key). Removal ends TAKEOVER, not the
//    secrets a backup was already given.

/**
 * Session-memoised "is the configured RPC really Arbitrum Sepolia?". `null` while
 * unknown, so a failed check is retried rather than cached as a refusal.
 */
let _rpcChainVerified: boolean | null = null;

async function isConfiguredChain(client: { getChainId: () => Promise<number> }): Promise<boolean> {
  if (_rpcChainVerified !== null) return _rpcChainVerified;
  try {
    const chainId = await client.getChainId();
    if (chainId !== KERNEL_CHAIN_ID) {
      console.error(`[kernel] RPC serves chain ${chainId}, expected ${KERNEL_CHAIN_ID} — refusing to read account state.`);
      _rpcChainVerified = false;
      return false;
    }
    _rpcChainVerified = true;
    return true;
  } catch (e) {
    console.warn("[kernel] could not confirm the RPC chain id:", e);
    return false; // not memoised: a transient failure must not poison the session
  }
}

/**
 * Is the recovery route installed on this account? Three states, never two: an
 * unreadable chain is `"unknown"`, NOT `"absent"` — the same absent-vs-unknown
 * discipline as the SOC read stack (#138/#155). Callers must never report a
 * removal, or an unprotected account, off `"unknown"`.
 */
export type RecoveryRouteState = "installed" | "absent" | "unknown";

export interface RecoveryRouteStatus {
  state: RecoveryRouteState;
  /**
   * Does the Kernel have code? `undefined` when we could not tell. Load-bearing
   * for `removeAllBackups`: sending the uninstall against an UNDEPLOYED account
   * would deploy it as a side effect, so that is the one case it must not send —
   * and therefore the one case where the pre-read alone decides.
   */
  deployed?: boolean;
  /** Caller hook pinned in front of the route (only when `installed`). */
  hook?: string;
  /** Recovery action the route delegatecalls (only when `installed`). */
  target?: string;
}

/**
 * On-chain truth for "does a recovery route exist on this account" — gasless
 * `eth_call`, no writes. This is the signal the UI must trust; the server's
 * `RecoveryStatus` is a forgeable hint (#148).
 *
 * An undeployed Kernel reads `"absent"`. Note the reason precisely: it is NOT that
 * a Kernel can never be born with a fallback route — `Kernel.initialize` self-calls
 * arbitrary `initConfig` calldata (`Kernel.sol:116-121`), so one could be. It is
 * that WoCo's factory args install a sudo validator and nothing else, and
 * `setupRecovery` is what deploys the account here.
 *
 * `atBlock` pins the read to a block, so a post-transaction read-back cannot be
 * answered by a replica that has not caught up: such a node errors on an unknown
 * block, which surfaces honestly as `"unknown"` instead of as stale state.
 */
export async function readRecoveryRoute(
  kernelAddress: string,
  atBlock?: bigint,
): Promise<RecoveryRouteStatus> {
  const [{ createPublicClient, http, toFunctionSelector, parseAbi, zeroAddress }, { arbitrumSepolia }] =
    await Promise.all([import("viem"), import("viem/chains")]);
  try {
    const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(getRpcUrl()) });

    // viem does NOT check that the endpoint serves the chain named in `chain`, and
    // this function is the one place a definitive NEGATIVE is minted. A wrong-chain
    // RPC answers "no code" for a perfectly real Kernel, which the recovery portal
    // would render as "recovery isn't possible for this account" — to a locked-out
    // user. Memoised, so it costs one call per session.
    if (!(await isConfiguredChain(publicClient))) return { state: "unknown" };

    const at = atBlock === undefined ? {} : { blockNumber: atBlock };
    const code = await publicClient.getCode({ address: kernelAddress as Address, ...at });
    if (!code || code === "0x") return { state: "absent", deployed: false };

    const config = (await publicClient.readContract({
      address: kernelAddress as Address,
      abi: KERNEL_SELECTOR_CONFIG_ABI,
      functionName: "selectorConfig",
      args: [recoveryRouteSelector({ toFunctionSelector, parseAbi })],
      ...at,
    })) as { hook: Address; target: Address; callType: Hex };

    if (!config.hook || config.hook.toLowerCase() === zeroAddress.toLowerCase()) {
      return { state: "absent", deployed: true };
    }
    return {
      state: "installed",
      deployed: true,
      hook: config.hook.toLowerCase(),
      target: config.target.toLowerCase(),
    };
  } catch (e) {
    console.warn("[kernel] readRecoveryRoute failed:", e);
    return { state: "unknown" };
  }
}

export interface RemoveAllBackupsResult {
  /** The account is not deployed, so no route can exist and no userOp was sent. */
  alreadyAbsent: boolean;
  userOpHash?: string;
  txHash?: string;
}

/**
 * "Remove all backups" — one sudo userOp that uninstalls the `doRecovery` route,
 * disabling EVERY registered guardian at once (per-guardian revoke does not exist).
 *
 * Success is proven by an on-chain READ-BACK, never by the transaction: Kernel
 * does not revert when the selector was never installed, so a green receipt says
 * nothing about whether anything was removed. Throws if the route survives, and
 * throws if the chain cannot be re-read afterwards — an unverified removal must
 * never be reported as done.
 *
 * WHY IT SENDS THE USEROP EVEN WHEN THE ROUTE LOOKS ABSENT. `getCode` and
 * `selectorConfig` are answers from ONE load-balanced RPC, not chain truth. A
 * replica lagging behind the install answers "absent" for a route that exists —
 * and the user hitting that window is not hypothetical, it is "I added a backup,
 * changed my mind, clicked Remove". Short-circuiting there would print "Backups
 * removed. Account recovery is off." while the guardian kept permanent takeover:
 * exactly the false safety certificate #148 exists to abolish. So a "removed"
 * claim never rests on the pre-read. The uninstall is idempotent and sponsored,
 * so sending it needlessly costs a no-op userOp — a fair price for the claim.
 *
 * The one exception is an UNDEPLOYED account, where sending would deploy it as a
 * side effect. `expectInstalled` covers that hole from the other side: if the
 * caller was showing the user "you are protected", an undeployed reading is a
 * contradiction, and a contradiction is reported as such rather than as success.
 */
export async function removeAllBackups(
  builtKernel: BuiltKernel,
  opts: { expectInstalled?: boolean } = {},
): Promise<RemoveAllBackupsResult> {
  const before = await readRecoveryRoute(builtKernel.address);
  if (before.deployed === false) {
    if (opts.expectInstalled) {
      throw new Error(
        "Couldn't confirm this account's state on-chain, so nothing was changed. " +
          "Your backups have NOT been removed — please try again in a moment.",
      );
    }
    return { alreadyAbsent: true };
  }

  const d = await loadRecoveryDeps();
  const { userOpHash, txHash, blockNumber } = await sendSudoUserOp(builtKernel.kernelClient, {
    callData: buildUninstallRecoveryCallData(d),
  });

  // PINNED to the block the uninstall landed in. Asked at "latest", this read can
  // be served by a replica that has not seen the transaction yet — which would
  // report a route that is already gone as still installed, and tell the user their
  // removal failed when it succeeded. A node that lacks the block errors instead,
  // and that surfaces as the honest "couldn't confirm" below.
  const after = await readRecoveryRoute(builtKernel.address, blockNumber);
  if (after.state === "installed") {
    throw new Error(
      `Removal did not take effect: the recovery route is still installed as of block ` +
        `${after.deployed ? blockNumber : "?"} (tx ${txHash}). Your backups have NOT been ` +
        "removed — please try again.",
    );
  }
  if (after.state === "unknown") {
    throw new Error(
      `Couldn't confirm the removal on-chain yet (tx ${txHash}). It may well have worked — ` +
        "reopen this screen in a moment to check before assuming either way.",
    );
  }
  return { alreadyAbsent: false, userOpHash, txHash };
}

export interface RecoverAccountArgs {
  /** The locked-out user's Kernel address to recover. */
  targetAddress: string;
  /** Guardian set used at setup — MUST reproduce the registered guardian address. */
  guardianConfig: GuardianConfig;
  /** Live guardian signers (viem accounts) meeting the threshold. */
  guardianSigners: unknown[];
  /** New owner the sudo signer is rotated to (a freshly-registered passkey's
   *  PRF-EOA address, or a self-custodied EOA). Same address ⇒ funds intact. */
  newOwnerAddress: string;
}

/**
 * Perform recovery: the guardian account (weighted-ECDSA Kernel) calls
 * target.doRecovery, rotating the target's sudo ECDSA owner to `newOwnerAddress`.
 * The caller hook authorises by msg.sender == the registered guardian account.
 * Guardians can ONLY rotate the signer — never spend. Kernel address preserved.
 *
 * Run from the recovery portal where the guardian factor(s) are present
 * (e.g. the user's backup EOA). Sponsored (the locked-out user has no gas).
 */
export async function recoverAccount(args: RecoverAccountArgs): Promise<{ userOpHash: string; txHash: string }> {
  const d = await loadRecoveryDeps();
  const guardianAccount = await buildGuardianAccount(d, args.guardianConfig, args.guardianSigners);
  const guardianClient = d.createKernelAccountClient({
    account: guardianAccount,
    chain: d.arbitrumSepolia,
    bundlerTransport: d.http(d.rpcUrl),
    client: d.publicClient,
    paymaster: recoverySponsor(d),
  });

  // doRecovery(validatorModule, ownerEnableData): ECDSA enable data IS the raw
  // 20-byte owner address (matches recovery-spike.ts, PASS). The validator
  // module address is the chain-wide ECDSA validator singleton.
  const data = d.encodeFunctionData({
    abi: d.parseAbi([RECOVERY_EXECUTOR_FN]),
    functionName: "doRecovery",
    args: [d.getValidatorAddress(d.entryPoint, d.kernelVersion), args.newOwnerAddress as Hex],
  });

  return sendSudoUserOp(guardianClient, {
    calls: [{ to: args.targetAddress as Address, data }],
    callGasLimit: 1_000_000n,
  });
}

/**
 * Escape hatch — sweep funds OUT of the Kernel to a self-custodied external
 * address while the passkey still works (so funds are never structurally
 * trapped, independent of recovery being configured). Sudo-signed, sponsored.
 * Sweeps native ETH (full balance — gas is paymaster-paid) and any listed ERC-20s
 * (full balanceOf) in a single userOp. No-op (throws) if nothing to move.
 */
export async function sweepToExternal(
  builtKernel: BuiltKernel,
  args: { to: string; erc20Tokens?: string[] },
): Promise<{ userOpHash: string; txHash: string }> {
  const d = await loadRecoveryDeps();
  const account = builtKernel.address as Address;
  const to = args.to as Address;

  const calls: { to: Address; data: Hex; value?: bigint }[] = [];

  const nativeBalance = await d.publicClient.getBalance({ address: account });
  if (nativeBalance > 0n) {
    calls.push({ to, value: nativeBalance, data: "0x" });
  }

  for (const token of args.erc20Tokens ?? []) {
    const bal = (await d.publicClient.readContract({
      address: token as Address,
      abi: d.erc20Abi,
      functionName: "balanceOf",
      args: [account],
    })) as bigint;
    if (bal > 0n) {
      calls.push({
        to: token as Address,
        value: 0n,
        data: d.encodeFunctionData({ abi: d.erc20Abi, functionName: "transfer", args: [to, bal] }),
      });
    }
  }

  if (calls.length === 0) throw new Error("sweepToExternal: nothing to sweep (no native or token balance).");

  const callData = await builtKernel.account.encodeCalls(calls);
  return sendSudoUserOp(builtKernel.kernelClient, { callData });
}

/**
 * Caller-hook guardian registry getter — `allowed(guardian, kernel) → bool`
 * (selector `0x5c658165`, confirmed against the deployed hook). This is the
 * ON-CHAIN truth about who can call `doRecovery` on an account; every other
 * "is this account protected / is this the guardian" signal in the product is
 * an untrusted server hint (#162).
 */
const RECOVERY_HOOK_ALLOWED_ABI = [
  {
    type: "function",
    name: "allowed",
    stateMutability: "view",
    inputs: [
      { name: "guardian", type: "address" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * Is `guardianAddress` actually registered on-chain as a permitted recovery
 * caller for `targetAddress`? Gasless `eth_call`, no writes.
 *
 * Returns `true`/`false` when the chain answered, and `null` when the read
 * FAILED — callers must not treat an unreadable chain as "not registered"
 * (the same absent-vs-unknown distinction #138 is about).
 *
 * Note this reports the CURRENT registry, which is append-only in the deployed
 * ZeroDev hook: a guardian that was ever installed stays `true` forever, so a
 * `true` here does NOT mean "this is the only guardian" (#148).
 */
export async function isGuardianRegistered(
  guardianAddress: string,
  targetAddress: string,
): Promise<boolean | null> {
  const [{ createPublicClient, http }, { arbitrumSepolia }] = await Promise.all([
    import("viem"),
    import("viem/chains"),
  ]);
  try {
    const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(getRpcUrl()) });
    return (await publicClient.readContract({
      address: RECOVERY_CALLER_HOOK as Address,
      abi: RECOVERY_HOOK_ALLOWED_ABI,
      functionName: "allowed",
      args: [guardianAddress as Address, targetAddress as Address],
    })) as boolean;
  } catch (e) {
    console.warn("[kernel] isGuardianRegistered read failed:", e);
    return null;
  }
}

/**
 * ECDSAValidator singleton (Kernel v3) per-account owner storage getter. The
 * deployed validator stores `mapping(address account => ECDSAValidatorStorage{
 * address owner })`, exposed as the public getter `ecdsaValidatorStorage(address)
 * returns (address owner)`.
 */
const ECDSA_VALIDATOR_STORAGE_ABI = [
  {
    type: "function",
    name: "ecdsaValidatorStorage",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "owner", type: "address" }],
  },
] as const;

/**
 * Does this EOA already own its OWN Kernel on chain? Computes the EOA's
 * counterfactual address and reads that Kernel's live ECDSA owner.
 *
 * Returns the lowercased owner when the chain answered, `null` when it answered
 * "no owner", and `"error"` when the read failed — the three states must stay
 * apart, because the caller refuses on `"error"` and would otherwise read a failed
 * read as "this credential is free" (the #138 mistake, on a path whose write
 * destroys a non-re-derivable secret).
 *
 * One-sided by nature: a positive answer proves an account exists, but absence
 * proves nothing, because Kernels deploy lazily and an account that never
 * transacted has no on-chain trace at all. Callers must pair it with local
 * evidence — see `recovery-owner-collision.ts`.
 */
/**
 * This EOA's counterfactual Kernel address — a pure CREATE2 function of the key,
 * no chain state involved. Returned separately from its owner because the two
 * answer different questions: the owner says "does an account exist here", the
 * ADDRESS says "is that account the one we are talking about". Conflating them
 * makes a rightful holder recovering their OWN account look like a collision.
 * `null` if it cannot be computed.
 */
export async function counterfactualKernelOf(eoaAddress: string): Promise<string | null> {
  try {
    const [{ createPublicClient, http }, { arbitrumSepolia }, { getEntryPoint, KERNEL_V3_1 }, { getKernelAddressFromECDSA }] =
      await Promise.all([
        import("viem"),
        import("viem/chains"),
        import("@zerodev/sdk/constants"),
        import("@zerodev/ecdsa-validator"),
      ]);
    const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(getRpcUrl()) });
    const addr = await getKernelAddressFromECDSA({
      entryPoint: getEntryPoint("0.7"),
      kernelVersion: KERNEL_V3_1,
      eoaAddress: eoaAddress as Address,
      index: 0n,
      publicClient,
    });
    return addr.toLowerCase();
  } catch (e) {
    console.warn("[kernel] counterfactualKernelOf failed:", e);
    return null;
  }
}

export async function readCounterfactualOwner(
  eoaAddress: string,
): Promise<string | null | "error"> {
  try {
    const [{ createPublicClient, http }, { arbitrumSepolia }, { getEntryPoint, KERNEL_V3_1 }, { getKernelAddressFromECDSA }] =
      await Promise.all([
        import("viem"),
        import("viem/chains"),
        import("@zerodev/sdk/constants"),
        import("@zerodev/ecdsa-validator"),
      ]);
    const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(getRpcUrl()) });
    const counterfactual = await getKernelAddressFromECDSA({
      entryPoint: getEntryPoint("0.7"),
      kernelVersion: KERNEL_V3_1,
      eoaAddress: eoaAddress as Address,
      index: 0n,
      publicClient,
    });
    // readKernelEcdsaOwner collapses "no owner" and "read failed" into null. Here
    // that distinction is the whole point, so the inner read is repeated rather
    // than reused — a failure must surface as "error", never as "free".
    const { getValidatorAddress } = await import("@zerodev/ecdsa-validator");
    const { zeroAddress } = await import("viem");
    const owner = (await publicClient.readContract({
      address: getValidatorAddress(getEntryPoint("0.7"), KERNEL_V3_1) as Address,
      abi: ECDSA_VALIDATOR_STORAGE_ABI,
      functionName: "ecdsaValidatorStorage",
      args: [counterfactual as Address],
    })) as Address;
    return !owner || owner.toLowerCase() === zeroAddress.toLowerCase() ? null : owner.toLowerCase();
  } catch (e) {
    console.warn("[kernel] readCounterfactualOwner failed:", e);
    return "error";
  }
}

/**
 * Read the CURRENT on-chain ECDSA sudo owner of a deployed Kernel via a gasless
 * `eth_call` — the trust backstop for the cross-device portability envelope
 * (CROSS_DEVICE_RECOVERY.md §3). A recovered account's preserved address is only
 * honoured on a new device if its Kernel's live owner equals that device's
 * PRF-EOA, so a stale/forged envelope cannot point at someone else's account.
 *
 * Returns the lowercased owner address, or `null` if the Kernel is not deployed
 * (owner unset / zero) or the read fails. No new on-chain writes; verification
 * only. The ECDSA validator singleton address is resolved per Kernel version, so
 * this stays correct if the version constant changes.
 */
export async function readKernelEcdsaOwner(kernelAddress: string): Promise<string | null> {
  const [{ createPublicClient, http, zeroAddress }, { arbitrumSepolia }, { getEntryPoint, KERNEL_V3_1 }, { getValidatorAddress }] =
    await Promise.all([
      import("viem"),
      import("viem/chains"),
      import("@zerodev/sdk/constants"),
      import("@zerodev/ecdsa-validator"),
    ]);

  try {
    const validatorAddress = getValidatorAddress(getEntryPoint("0.7"), KERNEL_V3_1);
    const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(getRpcUrl()) });
    const owner = (await publicClient.readContract({
      address: validatorAddress as Address,
      abi: ECDSA_VALIDATOR_STORAGE_ABI,
      functionName: "ecdsaValidatorStorage",
      args: [kernelAddress as Address],
    })) as Address;
    if (!owner || owner.toLowerCase() === zeroAddress.toLowerCase()) return null;
    return owner.toLowerCase();
  } catch (e) {
    console.warn("[kernel] readKernelEcdsaOwner failed:", e);
    return null;
  }
}
