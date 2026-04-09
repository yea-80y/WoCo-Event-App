import { JsonRpcProvider, parseUnits, formatUnits } from "ethers";
import type { PaymentProof, PaymentChainId, Hex0x } from "@woco/shared";
import { USDC_ADDRESSES } from "@woco/shared";
import { getRpcUrl, ERC20_TRANSFER_TOPIC, getMinConfirmations } from "./constants.js";

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

  // Fetch tx and receipt in parallel
  const [tx, receipt] = await Promise.all([
    provider.getTransaction(proof.txHash),
    provider.getTransactionReceipt(proof.txHash),
  ]);

  if (!tx) {
    return { valid: false, error: "Transaction not found" };
  }
  if (!receipt) {
    return { valid: false, error: "Transaction not yet confirmed" };
  }
  if (receipt.status !== 1) {
    return { valid: false, error: "Transaction reverted" };
  }

  // Check confirmations (per-chain threshold)
  const currentBlock = await provider.getBlockNumber();
  const confirmations = currentBlock - receipt.blockNumber + 1;
  const minConf = getMinConfirmations(proof.chainId);
  if (confirmations < minConf) {
    return { valid: false, error: `Need ${minConf} confirmations, have ${confirmations}` };
  }

  // Bind tx to the claimer — prevents front-running a pending payment.
  // tx.from is the EOA that signed. We require an exact match against the
  // expected claimer address. Meta-transactions / batched relayers are not
  // supported (tx.from would be the relayer, not the user).
  if (!tx.from || tx.from.toLowerCase() !== expected.expectedFrom.toLowerCase()) {
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
