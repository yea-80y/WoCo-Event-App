import { JsonRpcProvider, parseUnits, formatUnits } from "ethers";
import type { PaymentProof, PaymentChainId, Hex0x } from "@woco/shared";
import { USDC_ADDRESSES } from "@woco/shared";
import { getRpcUrl, ERC20_TRANSFER_TOPIC, getMinConfirmations } from "./constants.js";

/**
 * ERC-4337 canonical EntryPoint addresses. If a tx targets one of these, the
 * payment was a bundled user operation — `tx.from` is the bundler, NOT the
 * user. Our current binding (`tx.from === expectedFrom`) assumes an EOA
 * signed the tx directly, so AA is not yet supported. See DEVLOG "Account
 * abstraction roadmap" for the proper fix.
 */
const ERC4337_ENTRYPOINTS = new Set<string>([
  "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789", // EntryPoint v0.6
  "0x0000000071727de22e5e9d8baf0edac6f37da032", // EntryPoint v0.7
]);

export interface PaymentExpectation {
  amount: string;        // Decimal string e.g. "5.00" or "0.005"
  currency: "ETH" | "USDC";
  recipient: Hex0x;      // Escrow address or organiser address
  /**
   * Expected tx.from — the EOA that signed the payment tx. Server binds this
   * to the claimer (verified parentAddress for wallet claims, or recovered
   * address from claimerProof signature for email/passkey claims).
   * REQUIRED for all claims — prevents an attacker from reusing another user's
   * pending payment by front-running with the same txHash.
   */
  expectedFrom: Hex0x;
}

export interface VerificationResult {
  valid: boolean;
  error?: string;
}

/** Cache of RPC providers per chain (reuse connections) */
const providers = new Map<PaymentChainId, JsonRpcProvider>();

function getProvider(chainId: PaymentChainId): JsonRpcProvider {
  let provider = providers.get(chainId);
  if (!provider) {
    provider = new JsonRpcProvider(getRpcUrl(chainId), chainId, { staticNetwork: true });
    providers.set(chainId, provider);
  }
  return provider;
}

/**
 * Verify an on-chain payment (ETH transfer or USDC ERC-20 transfer).
 *
 * 1. Fetches the transaction + receipt by txHash
 * 2. Checks confirmations >= MIN_CONFIRMATIONS
 * 3. For ETH: verifies tx.value >= expected and tx.to === recipient
 * 4. For USDC: decodes Transfer event log, verifies amount + recipient
 */
export async function verifyPayment(
  proof: PaymentProof,
  expected: PaymentExpectation,
): Promise<VerificationResult> {
  if (proof.type !== "tx" || !proof.txHash) {
    return { valid: false, error: "Only tx-type proofs are verified here" };
  }

  const provider = getProvider(proof.chainId);
  const minConf = getMinConfirmations(proof.chainId);

  // Fetch tx first so we can return "not found" fast without waiting.
  const tx = await provider.getTransaction(proof.txHash);
  if (!tx) {
    return { valid: false, error: "Transaction not found" };
  }

  // Wait for the RPC's view to actually reach the required conf depth.
  // Public RPC endpoints (e.g. 1rpc.io) are load-balanced across nodes;
  // a naive `currentBlock - receipt.blockNumber` can go NEGATIVE when the
  // block-number read hits a node that's several blocks behind the one
  // that indexed the receipt. `waitForTransaction(hash, n, timeout)` polls
  // until the same RPC node sees `n` confirmations or the timeout fires —
  // this is the authoritative barrier, not a tip-skew race.
  let receipt: Awaited<ReturnType<typeof provider.getTransactionReceipt>>;
  try {
    receipt = await provider.waitForTransaction(proof.txHash, minConf, 30_000);
  } catch {
    receipt = null;
  }

  if (!receipt) {
    // Timed out. Fall back to a best-effort receipt fetch so we can return
    // an accurate progress message to the client. The client retries.
    const partial = await provider.getTransactionReceipt(proof.txHash);
    if (!partial) {
      return { valid: false, error: "Transaction not yet confirmed" };
    }
    const head = await provider.getBlockNumber();
    const have = Math.max(0, head - partial.blockNumber + 1);
    return { valid: false, error: `Need ${minConf} confirmations, have ${have}` };
  }

  if (receipt.status !== 1) {
    return { valid: false, error: "Transaction reverted" };
  }

  // Bind tx to the claimer — prevents front-running a pending payment.
  // tx.from is the EOA that signed. We require an exact match against the
  // expected claimer address. Meta-transactions / batched relayers are not
  // supported (tx.from would be the relayer, not the user).
  //
  // Detect smart-account wallets (ERC-4337 bundled user ops, Safe-style
  // contract accounts) and return a clear error rather than the raw "tx.from
  // mismatch" message. Proper AA support requires parsing userOp calldata
  // and EIP-1271 verification — see DEVLOG "Account abstraction roadmap".
  if (!tx.from || tx.from.toLowerCase() !== expected.expectedFrom.toLowerCase()) {
    // AA detection 1: tx routed through a known ERC-4337 EntryPoint
    if (tx.to && ERC4337_ENTRYPOINTS.has(tx.to.toLowerCase())) {
      return {
        valid: false,
        error:
          "Smart-account wallet detected (ERC-4337). WoCo currently only accepts " +
          "payments from EOA wallets (MetaMask, Rabby, Coinbase Wallet, Para). " +
          "Account abstraction support is on the roadmap.",
      };
    }
    // AA detection 2: tx.from is itself a contract (Safe direct tx, etc.)
    try {
      const code = await provider.getCode(tx.from);
      if (code && code !== "0x") {
        return {
          valid: false,
          error:
            "Smart-account wallet detected (contract-based signer). WoCo currently " +
            "only accepts payments from EOA wallets. AA support is on the roadmap.",
        };
      }
    } catch {
      // getCode failure — fall through to the generic mismatch error
    }
    return {
      valid: false,
      error: `Transaction signed by ${tx.from ?? "unknown"}, expected ${expected.expectedFrom}`,
    };
  }

  if (expected.currency === "ETH") {
    return verifyETHPayment(tx, expected);
  } else {
    return verifyUSDCPayment(receipt, proof.chainId, expected);
  }
}

function verifyETHPayment(
  tx: { to: string | null; value: bigint },
  expected: PaymentExpectation,
): VerificationResult {
  if (!tx.to) {
    return { valid: false, error: "Transaction has no recipient (contract creation)" };
  }

  if (tx.to.toLowerCase() !== expected.recipient.toLowerCase()) {
    return {
      valid: false,
      error: `Payment sent to ${tx.to}, expected ${expected.recipient}`,
    };
  }

  const expectedWei = parseUnits(expected.amount, 18);
  if (tx.value < expectedWei) {
    return {
      valid: false,
      error: `Paid ${formatUnits(tx.value, 18)} ETH, expected ${expected.amount} ETH`,
    };
  }

  return { valid: true };
}

function verifyUSDCPayment(
  receipt: { logs: ReadonlyArray<{ topics: ReadonlyArray<string>; data: string; address: string }> },
  chainId: PaymentChainId,
  expected: PaymentExpectation,
): VerificationResult {
  const usdcAddr = USDC_ADDRESSES[chainId];
  if (!usdcAddr) return { valid: false, error: `USDC not supported on chain ${chainId}` };
  const usdcAddress = usdcAddr.toLowerCase();

  // Find Transfer(from, to, value) event from the USDC contract
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdcAddress) continue;
    if (log.topics[0] !== ERC20_TRANSFER_TOPIC) continue;
    if (log.topics.length < 3) continue;

    // topics[2] = to address (padded to 32 bytes)
    const toAddr = "0x" + log.topics[2].slice(26);
    if (toAddr.toLowerCase() !== expected.recipient.toLowerCase()) continue;

    // data = uint256 value
    const transferredAmount = BigInt(log.data);
    const expectedAmount = parseUnits(expected.amount, 6); // USDC = 6 decimals

    if (transferredAmount < expectedAmount) {
      return {
        valid: false,
        error: `Paid ${formatUnits(transferredAmount, 6)} USDC, expected ${expected.amount} USDC`,
      };
    }

    return { valid: true };
  }

  return { valid: false, error: "No matching USDC Transfer event found in transaction" };
}
