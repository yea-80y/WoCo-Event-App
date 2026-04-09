import { JsonRpcSigner, parseUnits, Contract, id as keccak256Utf8 } from "ethers";
import type { PaymentConfig, PaymentChainId, PaymentProof, Hex0x } from "@woco/shared";
import { USDC_ADDRESSES } from "@woco/shared";
import { switchChain } from "./chains.js";
import { apiBase } from "../api/client.js";
import { getEthersProvider } from "../wallet/provider.js";

/** WoCoEscrow ABI — only the functions we call */
const ESCROW_ABI = [
  "function payETH(bytes32 eventId, address organiser, uint256 releaseTime) payable",
  "function payToken(bytes32 eventId, address token, uint256 amount, address organiser, uint256 releaseTime)",
];

/** Fetch escrow contract address for a chain from the server */
async function getEscrowAddress(chainId: PaymentChainId): Promise<Hex0x> {
  const resp = await fetch(`${apiBase}/api/payment/escrow-addresses`);
  if (!resp.ok) throw new Error("Failed to fetch escrow addresses");
  const data = await resp.json() as { ok: boolean; addresses: Record<string, string> };
  const addr = data.addresses[chainId];
  if (!addr) throw new Error(`No escrow contract on chain ${chainId}`);
  return addr as Hex0x;
}

/** Convert event ID string to bytes32 — keccak256(utf8(eventId)), matching the contract */
function eventIdToBytes32(eventId: string): string {
  return keccak256Utf8(eventId);
}

/** Minimal ERC-20 ABI for approve + transfer */
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
 * Execute a crypto payment via the user's connected wallet.
 *
 * For escrow events: calls payETH/payToken on WoCoEscrow contract (auto-initialises on first payment).
 * For direct events: plain ETH transfer or ERC-20 transfer to organiser.
 *
 * @param payment       Series payment config (price, currency, escrow flag, etc.)
 * @param chainId       Which chain the user selected
 * @param eventId       Event ID string — needed to call the escrow contract
 * @param eventEndDate  ISO date string for the event end — sets escrow releaseTime (end + 48h)
 * @returns PaymentProof to attach to the claim request
 */
export async function executePayment(
  payment: PaymentConfig,
  chainId: PaymentChainId,
  eventId: string,
  eventEndDate?: string,
  signerAddress?: string,
): Promise<PaymentResult> {
  await switchChain(chainId);

  // Allow WalletConnect session to settle after chain change before sending the tx.
  await new Promise(resolve => setTimeout(resolve, 500));

  // Use the cached provider; construct signer directly to avoid an eth_accounts
  // round-trip that can return stale results after a chain switch.
  const provider = getEthersProvider();
  const signer = signerAddress
    ? new JsonRpcSigner(provider, signerAddress)
    : await provider.getSigner();

  // Capture the paying address — the server binds txHash → claimer via this field.
  const from = ((signerAddress ?? await signer.getAddress()).toLowerCase()) as Hex0x;

  if (payment.escrow) {
    // Route through WoCoEscrow contract
    const escrowAddr = await getEscrowAddress(chainId);
    const eventBytes32 = eventIdToBytes32(eventId);
    // releaseTime = event end date + 24 hours, or 7 days from now as fallback
    const releaseTime = eventEndDate
      ? Math.floor(new Date(eventEndDate).getTime() / 1000) + 24 * 3600
      : Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
    const organiser = payment.recipientAddress;
    if (payment.currency === "ETH") {
      return executeEscrowETHPayment(signer, payment.price, escrowAddr, eventBytes32, chainId, organiser, releaseTime, from);
    } else {
      return executeEscrowTokenPayment(signer, payment.price, escrowAddr, eventBytes32, chainId, organiser, releaseTime, from);
    }
  } else {
    // Direct payment to organiser
    if (payment.currency === "ETH") {
      return executeETHPayment(signer, payment.price, payment.recipientAddress, chainId, from);
    } else {
      return executeUSDCPayment(signer, payment.price, payment.recipientAddress, chainId, from);
    }
  }
}

async function executeEscrowETHPayment(
  signer: any,
  amount: string,
  escrowAddr: Hex0x,
  eventBytes32: string,
  chainId: PaymentChainId,
  organiser: Hex0x,
  releaseTime: number,
  from: Hex0x,
): Promise<PaymentResult> {
  const escrow = new Contract(escrowAddr, ESCROW_ABI, signer);
  const tx = await escrow.payETH(eventBytes32, organiser, releaseTime, { value: parseUnits(amount, 18) });
  await tx.wait(1);
  return { proof: { type: "tx", txHash: tx.hash, chainId, from } };
}

async function executeEscrowTokenPayment(
  signer: any,
  amount: string,
  escrowAddr: Hex0x,
  eventBytes32: string,
  chainId: PaymentChainId,
  organiser: Hex0x,
  releaseTime: number,
  from: Hex0x,
): Promise<PaymentResult> {
  const usdcAddress = USDC_ADDRESSES[chainId];
  if (!usdcAddress) throw new Error(`USDC not supported on chain ${chainId}`);

  const parsedAmount = parseUnits(amount, 6);
  const usdc = new Contract(usdcAddress, ERC20_ABI, signer);

  // Approve escrow to spend USDC, then call payToken
  const approveTx = await usdc.approve(escrowAddr, parsedAmount);
  await approveTx.wait(1);

  const escrow = new Contract(escrowAddr, ESCROW_ABI, signer);
  const tx = await escrow.payToken(eventBytes32, usdcAddress, parsedAmount, organiser, releaseTime);
  await tx.wait(1);
  return { proof: { type: "tx", txHash: tx.hash, chainId, from } };
}

async function executeETHPayment(
  signer: any,
  amount: string,
  recipient: Hex0x,
  chainId: PaymentChainId,
  from: Hex0x,
): Promise<PaymentResult> {
  const tx = await signer.sendTransaction({
    to: recipient,
    value: parseUnits(amount, 18),
  });

  // Wait for 1 confirmation
  await tx.wait(1);

  return {
    proof: {
      type: "tx",
      txHash: tx.hash,
      chainId,
      from,
    },
  };
}

async function executeUSDCPayment(
  signer: any,
  amount: string,
  recipient: Hex0x,
  chainId: PaymentChainId,
  from: Hex0x,
): Promise<PaymentResult> {
  const usdcAddress = USDC_ADDRESSES[chainId];
  if (!usdcAddress) throw new Error(`USDC not supported on chain ${chainId}`);
  const usdc = new Contract(usdcAddress, ERC20_ABI, signer);

  const parsedAmount = parseUnits(amount, 6); // USDC = 6 decimals

  // Direct transfer (no approve needed when user is the sender)
  const tx = await usdc.transfer(recipient, parsedAmount);
  await tx.wait(1);

  return {
    proof: {
      type: "tx",
      txHash: tx.hash,
      chainId,
      from,
    },
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
