import { JsonRpcSigner, Contract, id as keccak256Utf8 } from "ethers";
import type { PaymentConfig, PaymentChainId, PaymentProof, PaymentQuote, Hex0x } from "@woco/shared";
import { USDC_ADDRESSES, getMinConfirmations } from "@woco/shared";
import { switchChain } from "./chains.js";
import { apiBase } from "../api/client.js";
import { getEthersProvider } from "../wallet/provider.js";

/**
 * Progress callback for long-running payment steps. The `phase` identifies the
 * step; `current` / `total` are optional counts (used during confirmation
 * waits). UI surfaces this so users understand what the wallet is doing.
 */
export type PaymentProgress = (ev: {
  phase:
    | "switch-chain"
    | "approve-token"
    | "send-tx"
    | "waiting-confirmations"
    | "confirmed";
  current?: number;
  total?: number;
  txHash?: string;
}) => void;

/**
 * Wait for a transaction to reach the server's required confirmation count
 * (plus a one-block buffer to absorb RPC-node head skew). Reports progress on
 * each new block so the UI isn't a frozen spinner.
 */
async function waitForConfirmations(
  tx: { hash: string; wait: (n: number) => Promise<unknown> },
  chainId: PaymentChainId,
  onProgress?: PaymentProgress,
): Promise<void> {
  const provider = getEthersProvider();
  const required = getMinConfirmations(chainId) + 1; // +1 = buffer for RPC skew
  onProgress?.({ phase: "waiting-confirmations", current: 0, total: required, txHash: tx.hash });

  const waitPromise = tx.wait(required);

  let done = false;
  waitPromise.then(() => { done = true; }).catch(() => { done = true; });

  while (!done) {
    await new Promise((r) => setTimeout(r, 2000));
    if (done) break;
    try {
      const receipt = await provider.getTransactionReceipt(tx.hash);
      if (!receipt) continue;
      const current = await provider.getBlockNumber() - receipt.blockNumber + 1;
      const clamped = Math.max(0, Math.min(current, required));
      onProgress?.({ phase: "waiting-confirmations", current: clamped, total: required, txHash: tx.hash });
    } catch {
      // RPC blip — keep polling; waitPromise is the authoritative barrier
    }
  }

  await waitPromise;
  onProgress?.({ phase: "confirmed", current: required, total: required, txHash: tx.hash });
}

/** WoCoEscrow ABI — only the functions we call */
const ESCROW_ABI = [
  "function payETH(bytes32 eventId, address organiser, uint256 releaseTime) payable",
  "function payToken(bytes32 eventId, address token, uint256 amount, address organiser, uint256 releaseTime)",
];

async function getEscrowAddress(chainId: PaymentChainId): Promise<Hex0x> {
  const resp = await fetch(`${apiBase}/api/payment/escrow-addresses`);
  if (!resp.ok) throw new Error("Failed to fetch escrow addresses");
  const data = await resp.json() as { ok: boolean; addresses: Record<string, string> };
  const addr = data.addresses[chainId];
  if (!addr) throw new Error(`No escrow contract on chain ${chainId}`);
  return addr as Hex0x;
}

function eventIdToBytes32(eventId: string): string {
  return keccak256Utf8(eventId);
}

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
];

export interface PaymentResult {
  proof: PaymentProof;
}

/**
 * Execute a crypto payment against a server-signed quote.
 *
 * The quote commits the server to an exact wei amount + recipient. The wallet
 * sends that exact value; the server later HMAC-verifies its own signature on
 * the quote and exact-matches tx.value === quote.amountWei. No oracle race.
 *
 * For escrow events: calls payETH/payToken on WoCoEscrow contract. The quote's
 * recipient is the escrow address; the organiser address travels separately
 * via `payment.recipientAddress` so the contract knows where to release to.
 *
 * @returns PaymentProof carrying the full signed quote (server verifies statelessly)
 */
export async function executePayment(opts: {
  quote: PaymentQuote;
  payment: PaymentConfig;
  eventId: string;
  eventEndDate?: string;
  signerAddress?: string;
  onProgress?: PaymentProgress;
}): Promise<PaymentResult> {
  const { quote, payment, eventId, eventEndDate, signerAddress, onProgress } = opts;
  const chainId = quote.chainId;
  const amountWei = BigInt(quote.amountWei);

  onProgress?.({ phase: "switch-chain" });
  await switchChain(chainId);
  await new Promise((r) => setTimeout(r, 500));

  const provider = getEthersProvider();
  const signer = signerAddress
    ? new JsonRpcSigner(provider, signerAddress)
    : await provider.getSigner();

  const from = ((signerAddress ?? await signer.getAddress()).toLowerCase()) as Hex0x;

  if (payment.escrow) {
    const escrowAddr = await getEscrowAddress(chainId);
    const eventBytes32 = eventIdToBytes32(eventId);
    const releaseTime = eventEndDate
      ? Math.floor(new Date(eventEndDate).getTime() / 1000) + 24 * 3600
      : Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
    const organiser = payment.recipientAddress;

    if (quote.currency === "ETH") {
      return executeEscrowETHPayment(signer, amountWei, escrowAddr, eventBytes32, chainId, organiser, releaseTime, from, quote, onProgress);
    } else {
      return executeEscrowTokenPayment(signer, amountWei, escrowAddr, eventBytes32, chainId, organiser, releaseTime, from, quote, onProgress);
    }
  } else {
    if (quote.currency === "ETH") {
      return executeETHPayment(signer, amountWei, payment.recipientAddress, chainId, from, quote, onProgress);
    } else {
      return executeUSDCPayment(signer, amountWei, payment.recipientAddress, chainId, from, quote, onProgress);
    }
  }
}

async function executeEscrowETHPayment(
  signer: any,
  amountWei: bigint,
  escrowAddr: Hex0x,
  eventBytes32: string,
  chainId: PaymentChainId,
  organiser: Hex0x,
  releaseTime: number,
  from: Hex0x,
  quote: PaymentQuote,
  onProgress?: PaymentProgress,
): Promise<PaymentResult> {
  const escrow = new Contract(escrowAddr, ESCROW_ABI, signer);
  onProgress?.({ phase: "send-tx" });
  const tx = await escrow.payETH(eventBytes32, organiser, releaseTime, { value: amountWei });
  await waitForConfirmations(tx, chainId, onProgress);
  return { proof: { type: "tx", txHash: tx.hash, chainId, from, quote } };
}

async function executeEscrowTokenPayment(
  signer: any,
  amountWei: bigint,
  escrowAddr: Hex0x,
  eventBytes32: string,
  chainId: PaymentChainId,
  organiser: Hex0x,
  releaseTime: number,
  from: Hex0x,
  quote: PaymentQuote,
  onProgress?: PaymentProgress,
): Promise<PaymentResult> {
  const usdcAddress = USDC_ADDRESSES[chainId];
  if (!usdcAddress) throw new Error(`USDC not supported on chain ${chainId}`);

  const usdc = new Contract(usdcAddress, ERC20_ABI, signer);

  onProgress?.({ phase: "approve-token" });
  const approveTx = await usdc.approve(escrowAddr, amountWei);
  await approveTx.wait(1);

  const escrow = new Contract(escrowAddr, ESCROW_ABI, signer);
  onProgress?.({ phase: "send-tx" });
  const tx = await escrow.payToken(eventBytes32, usdcAddress, amountWei, organiser, releaseTime);
  await waitForConfirmations(tx, chainId, onProgress);
  return { proof: { type: "tx", txHash: tx.hash, chainId, from, quote } };
}

async function executeETHPayment(
  signer: any,
  amountWei: bigint,
  recipient: Hex0x,
  chainId: PaymentChainId,
  from: Hex0x,
  quote: PaymentQuote,
  onProgress?: PaymentProgress,
): Promise<PaymentResult> {
  onProgress?.({ phase: "send-tx" });
  const tx = await signer.sendTransaction({
    to: recipient,
    value: amountWei,
  });
  await waitForConfirmations(tx, chainId, onProgress);
  return {
    proof: { type: "tx", txHash: tx.hash, chainId, from, quote },
  };
}

async function executeUSDCPayment(
  signer: any,
  amountWei: bigint,
  recipient: Hex0x,
  chainId: PaymentChainId,
  from: Hex0x,
  quote: PaymentQuote,
  onProgress?: PaymentProgress,
): Promise<PaymentResult> {
  const usdcAddress = USDC_ADDRESSES[chainId];
  if (!usdcAddress) throw new Error(`USDC not supported on chain ${chainId}`);
  const usdc = new Contract(usdcAddress, ERC20_ABI, signer);

  onProgress?.({ phase: "send-tx" });
  const tx = await usdc.transfer(recipient, amountWei);
  await waitForConfirmations(tx, chainId, onProgress);
  return {
    proof: { type: "tx", txHash: tx.hash, chainId, from, quote },
  };
}

/**
 * Check USDC balance for the connected wallet on a specific chain.
 */
export async function getUSDCBalance(
  chainId: PaymentChainId,
  address: string,
): Promise<string> {
  const provider = getEthersProvider();
  const usdcAddress = USDC_ADDRESSES[chainId];
  if (!usdcAddress) throw new Error(`USDC not supported on chain ${chainId}`);
  const usdc = new Contract(usdcAddress, ERC20_ABI, provider);
  const balance: bigint = await usdc.balanceOf(address);
  const { formatUnits } = await import("ethers");
  return formatUnits(balance, 6);
}
