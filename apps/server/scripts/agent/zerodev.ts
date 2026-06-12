/**
 * Agent-side ZeroDev helpers (Node) — the half of the bounded agent wallet that
 * lives OUTSIDE the WoCo server: the user's grant + the agent's own-key draw.
 *
 * These run in the demo + MCP processes (via tsx), NOT in the compiled server —
 * the server only verifies the resulting on-chain draw (ethers, read-only). That
 * separation is the architecture: the agent is external; WoCo never holds the
 * agent key or the funds.
 *
 * Mirrors the proven browser code in apps/web/src/lib/auth/kernel-account.ts
 * (grant build) and apps/server/src/lib/shop/spend-permission.ts (reconstruct +
 * draw), but on the server's ZERODEV_RPC and with the agent as the spender key.
 */

import { createPublicClient, http, encodeFunctionData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import {
  createKernelAccount,
  createKernelAccountClient,
  createZeroDevPaymasterClient,
  addressToEmptyAccount,
  type KernelAccountClient,
} from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import {
  toPermissionValidator,
  serializePermissionAccount,
  deserializePermissionAccount,
} from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import {
  toCallPolicy,
  CallPolicyVersion,
  toTimestampPolicy,
  toRateLimitPolicy,
  toGasPolicy,
  ParamCondition,
} from "@zerodev/permissions/policies";

const ENTRY_POINT = getEntryPoint("0.7");
const KERNEL_VERSION = KERNEL_V3_1;
/** Finite gasless budget (wei) — generous on Arb Sepolia; bounds a leaked key. */
const GAS_ALLOWANCE_WEI = 200000000000000000n; // 0.2 ETH
/**
 * Explicit gas budget for the agent's enable-mode draw. The bundler's own
 * estimate is unreliable here on two counts: (1) the ZeroDev June-2026 RPC
 * incident returns a stub verificationGasLimit, and (2) this draw enables a
 * permission validator whose call policy matches USDC.transfer's ABI args
 * (recipient EQUAL + value LE ceiling) plus timestamp/rate-limit/gas policies —
 * far heavier to validate than the EAS path's flat selector-only policy. With a
 * too-low verificationGasLimit the account's validateUserOp runs out of gas and
 * reverts with EMPTY data, surfacing as `AA23 reverted 0x`. Verified on-chain:
 * 800k OOM-reverts, 3M succeeds. Sponsored + Arb gas is ~free, so we provision
 * generously (the bundler still meters actual usage). */
const DRAW_GAS_OVERRIDES = {
  verificationGasLimit: 3_000_000n,
  callGasLimit: 1_000_000n,
  preVerificationGas: 1_000_000n,
  paymasterVerificationGasLimit: 1_000_000n,
  paymasterPostOpGasLimit: 500_000n,
} as const;
/** ZeroDev incident workaround (2026-06): explicit verificationGasLimit when the
 *  RPC returns a stub estimate the bundler then rejects (used for the simple
 *  deploy op, which otherwise relies on bundler estimation). */
const VERIFICATION_GAS_FALLBACK = 800_000n;

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

function rpcUrl(): string {
  const url = process.env.ZERODEV_RPC;
  if (!url) throw new Error("ZERODEV_RPC is not set — cannot build Kernel clients.");
  return url;
}

function publicClient() {
  return createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrl()) });
}

function paymaster() {
  return createZeroDevPaymasterClient({ chain: arbitrumSepolia, transport: http(rpcUrl()) });
}

/**
 * Send a gasless userOp, retrying once with an explicit verificationGasLimit when
 * the ZeroDev RPC returns a stub estimate the bundler then rejects (2026-06
 * incident — same workaround as the browser sendSessionUserOp). Waits for the
 * receipt and throws on an on-chain revert.
 */
async function sendUserOp(
  kernelClient: KernelAccountClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  calls: any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gasOverrides?: Record<string, bigint>,
): Promise<{ userOpHash: string; txHash: string }> {
  let userOpHash: Hex;
  if (gasOverrides) {
    // Explicit gas — skip the (unreliable) bundler estimate entirely.
    userOpHash = await kernelClient.sendUserOperation({ calls, ...gasOverrides });
  } else {
    try {
      userOpHash = await kernelClient.sendUserOperation({ calls });
    } catch (err) {
      if (!/verificationGasLimit must be at least/i.test((err as Error)?.message ?? "")) throw err;
      userOpHash = await kernelClient.sendUserOperation({
        calls,
        verificationGasLimit: VERIFICATION_GAS_FALLBACK,
      });
    }
  }
  const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
  if (!receipt.success) throw new Error("userOp reverted on-chain");
  return { userOpHash, txHash: receipt.receipt.transactionHash };
}

// ---------------------------------------------------------------------------
// User side — build a Kernel from a raw key (the test user) + grant the agent.
// ---------------------------------------------------------------------------

export interface BuiltKernel {
  address: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  account: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sudoValidator: any;
  kernelClient: KernelAccountClient;
}

/** Build a ZeroDev Kernel (ECDSA sudo) from a raw secp256k1 key. */
export async function buildKernelFromPrivateKey(privateKey: string): Promise<BuiltKernel> {
  const pub = publicClient();
  const signer = privateKeyToAccount(privateKey as Hex);
  const sudoValidator = await signerToEcdsaValidator(pub, {
    signer,
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
  });
  const account = await createKernelAccount(pub, {
    plugins: { sudo: sudoValidator },
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
  });
  const pm = paymaster();
  const kernelClient = createKernelAccountClient({
    account,
    chain: arbitrumSepolia,
    bundlerTransport: http(rpcUrl()),
    client: pub,
    paymaster: { getPaymasterData: (userOperation) => pm.sponsorUserOperation({ userOperation }) },
  });
  return { address: account.address.toLowerCase(), account, sudoValidator, kernelClient };
}

/**
 * Ensure the user Kernel is DEPLOYED on-chain before the agent's first draw.
 *
 * WHY (root cause of the original AA23): the agent draws via a `regular`
 * permission plugin in ZeroDev "enable mode". On an UNDEPLOYED account that one
 * userOp must deploy the account (initCode), enable the permission validator,
 * AND validate the transfer — all in the first-ever op, which over-runs
 * validation gas and reverts with AA23 (empty data). The proven shop POS rail
 * never hits this because attendee Kernels are already deployed by the time a
 * draw happens; we reproduce that precondition with one cheap, well-estimated
 * sudo userOp (a 0-value self-call). After this, the enable-mode draw carries no
 * initCode and validates within budget. No-op if the account already has code.
 */
export async function ensureKernelDeployed(built: BuiltKernel): Promise<boolean> {
  const pub = publicClient();
  const code = await pub.getCode({ address: built.account.address as Address });
  if (code && code !== "0x") return false;
  await sendUserOp(built.kernelClient, [
    { to: built.account.address as Address, value: 0n, data: "0x" as Hex },
  ]);
  return true;
}

export interface AgentGrantArgs {
  sudoValidator: unknown;
  /** The AGENT's address — named as the empty-account spender (it holds the key). */
  agentAddress: string;
  usdcAddress: string;
  /** Organiser recipient — the ONLY address a draw may pay (pinned in policy). */
  recipient: string;
  perDrawCeilingAtomic: string;
  maxDraws: number;
  validUntil: number;
}

/**
 * Build + sudo-sign a spend-permission approval naming the agent as spender and
 * return the serialized blob (NO private key). On-chain constraints embedded:
 *  - call policy: USDC.transfer, arg `to` EQUAL recipient, `value` ≤ ceiling
 *  - timestamp policy: validUntil   - rate-limit policy: ≤ maxDraws
 *  - gas policy: finite gasless budget
 * The agent later combines this with its OWN key to draw — nothing else.
 */
export async function buildAgentSpendGrant(args: AgentGrantArgs): Promise<string> {
  const pub = publicClient();
  const emptySpender = addressToEmptyAccount(args.agentAddress as Address);
  const spenderSigner = await toECDSASigner({ signer: emptySpender });

  const policies = [
    toCallPolicy({
      policyVersion: CallPolicyVersion.V0_0_5,
      permissions: [
        {
          target: args.usdcAddress as Address,
          abi: ERC20_TRANSFER_ABI,
          functionName: "transfer",
          args: [
            { condition: ParamCondition.EQUAL, value: args.recipient as Address },
            { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: BigInt(args.perDrawCeilingAtomic) },
          ],
        },
      ],
    }),
    toTimestampPolicy({ validUntil: args.validUntil }),
    // `interval` MUST be non-zero: the on-chain RateLimitPolicy does time-bucket
    // arithmetic with it, and interval=0 (the lib default when only `count` is
    // passed) is a footgun. Set it to the permission's remaining lifetime so the
    // window never refills before expiry → `count` is an effective LIFETIME cap
    // of maxDraws draws (matches the server's intended bound).
    toRateLimitPolicy({
      count: args.maxDraws,
      interval: Math.max(args.validUntil - Math.floor(Date.now() / 1000), 1),
    }),
    toGasPolicy({ allowed: GAS_ALLOWANCE_WEI }),
  ];

  const permissionPlugin = await toPermissionValidator(pub, {
    signer: spenderSigner,
    policies,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entryPoint: ENTRY_POINT as any,
    kernelVersion: KERNEL_VERSION,
  });

  const sessionAccount = await createKernelAccount(pub, {
    plugins: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sudo: args.sudoValidator as any,
      regular: permissionPlugin,
    },
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
  });

  // No private-key arg → an APPROVAL (sudo-signed enable data), not a spendable key.
  return serializePermissionAccount(sessionAccount);
}

// ---------------------------------------------------------------------------
// Agent side — reconstruct with the agent's OWN key and draw USDC→organiser.
// ---------------------------------------------------------------------------

export interface AgentDrawArgs {
  /** Serialized approval the user granted (no key). */
  approval: string;
  /** The agent's OWN private key — the spender the approval names. */
  agentPrivateKey: string;
  usdcAddress: string;
  recipient: string;
  /** Exact draw amount, 6-dec atomic. Must be ≤ the per-draw ceiling. */
  amountAtomic: string;
}

/**
 * Draw `amountAtomic` USDC to `recipient` against the approval, signed by the
 * agent's own key, as a gasless userOp. Returns the userOp hash + settlement tx.
 * Throws on policy rejection (e.g. wrong recipient / over-ceiling / expired) —
 * the smart account enforces the bounds, which is the whole point.
 */
export async function agentDrawTransfer(
  args: AgentDrawArgs,
): Promise<{ userOpHash: string; txHash: string }> {
  const pub = publicClient();
  const agentSigner = await toECDSASigner({
    signer: privateKeyToAccount(args.agentPrivateKey as Hex),
  });
  const sessionAccount = await deserializePermissionAccount(
    pub,
    ENTRY_POINT,
    KERNEL_VERSION,
    args.approval,
    agentSigner,
  );

  const pm = paymaster();
  const kernelClient = createKernelAccountClient({
    account: sessionAccount,
    chain: arbitrumSepolia,
    bundlerTransport: http(rpcUrl()),
    client: pub,
    paymaster: { getPaymasterData: (userOperation) => pm.sponsorUserOperation({ userOperation }) },
  });

  const data = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [args.recipient as Address, BigInt(args.amountAtomic)],
  });
  const calls = [{ to: args.usdcAddress as Address, data }];

  // Explicit, generous gas — the enable-mode draw OOMs validation under the
  // bundler's stub estimate (see DRAW_GAS_OVERRIDES).
  return sendUserOp(kernelClient, calls, { ...DRAW_GAS_OVERRIDES });
}

/** Derive an address from a private key (helper for the demo's agent identity). */
export function addressFromPrivateKey(privateKey: string): string {
  return privateKeyToAccount(privateKey as Hex).address.toLowerCase();
}
