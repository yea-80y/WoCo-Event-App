/**
 * Referral confirmation — client write path. The signed-in MERCHANT attests
 * "I was referred by {referrer}" with their own account as attester, zero gas
 * on every rail:
 *  - passkey + web3auth → Kernel attests directly, gasless via the EAS-scoped
 *    session key + paymaster (same plumbing as likes — same EAS address and
 *    `attest` selector, so the existing call policy covers it).
 *  - web3 EOA → signs the EAS 1.3 delegated-attest EIP-712 payload (free);
 *    the server relays `attestByDelegation` and pays gas. On-chain attester
 *    is still the EOA.
 *  - coinbase (smart wallet) → can't produce the ECDSA delegated sig, so it
 *    sends the attest tx itself (own trivial testnet gas, like likes).
 *
 * Both rails end in a server confirm (`/record` with the UID, or `/relay`
 * with the signature) which is Stripe-gated server-side. Caller must be
 * signed in (requireAccountForAction) before invoking.
 */

import type { Hex0x, DelegatedSignature, ReferralStatus } from "@woco/shared";
import {
  EAS_ADDRESS, EAS_CHAIN_ID, EAS_REFERRAL_SCHEMA_UID,
  EAS_DELEGATED_ATTEST_DOMAIN, EAS_DELEGATED_ATTEST_TYPES,
  buildReferralAttestMessage, encodeReferralData, ZERO_BYTES32,
} from "@woco/shared";
import { auth } from "../auth/auth-store.svelte.js";
import { getEasSessionClient, sendSessionUserOp } from "../auth/kernel-account.js";
import { switchChain } from "../payment/chains.js";
import { requireProvider } from "../wallet/provider.js";
import { EAS_SESSION_ABI, EAS_EVENTS_ABI } from "./eas-abi.js";
import { recordReferral, relayReferral } from "../api/campaign.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** Delegated signatures get an hour — the relay happens immediately after. */
const DELEGATION_TTL_SECONDS = 3600n;

async function encodeAttest(referrer: Hex0x): Promise<Hex0x> {
  const { encodeFunctionData } = await import("viem");
  return encodeFunctionData({
    abi: EAS_SESSION_ABI,
    functionName: "attest",
    args: [
      {
        schema: EAS_REFERRAL_SCHEMA_UID,
        data: {
          recipient: referrer, // credit flows to the EAS recipient field
          expirationTime: 0n,
          revocable: false, // attribution is permanent
          refUID: ZERO_BYTES32,
          data: encodeReferralData(referrer),
          value: 0n,
        },
      },
    ],
  }) as Hex0x;
}

async function uidFromLogs(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
): Promise<Hex0x> {
  const { parseEventLogs } = await import("viem");
  const parsed = parseEventLogs({ abi: EAS_EVENTS_ABI, eventName: "Attested", logs: logs as never });
  const hit = parsed.find(
    (l) => (l.args as { schemaUID: string }).schemaUID.toLowerCase() === EAS_REFERRAL_SCHEMA_UID.toLowerCase(),
  );
  const uid = (hit?.args as { uid?: Hex0x } | undefined)?.uid;
  if (!uid) throw new Error("Attested event with the referral schema not found in receipt");
  return uid;
}

function assertAttesterIsParent(attester: string): void {
  if (auth.parent && attester.toLowerCase() !== auth.parent.toLowerCase()) {
    throw new Error(
      `Wallet account (${attester}) is not the signed-in account (${auth.parent}). Switch back to confirm the referral.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Kernel rail — direct gasless attest, then /record with the UID
// ---------------------------------------------------------------------------

async function kernelConfirm(referrer: Hex0x): Promise<ReferralStatus> {
  const kernelAddress = await auth.ensureEasSessionKey();
  assertAttesterIsParent(kernelAddress);
  const client = await getEasSessionClient(kernelAddress);
  if (!client) throw new Error("No EAS session key on this device for the Kernel.");

  const data = await encodeAttest(referrer);
  const { receipt } = await sendSessionUserOp(client, [{ to: EAS_ADDRESS, data }]);
  if (!receipt.success) throw new Error("Referral attestation reverted on-chain.");
  const uid = await uidFromLogs((receipt.logs ?? []) as never);

  const resp = await recordReferral(uid);
  if (!resp.ok || !resp.data) throw new Error(resp.error ?? "Server rejected the referral record");
  return resp.data;
}

// ---------------------------------------------------------------------------
// Web3 EOA rail — sign delegated attest (free), server relays
// ---------------------------------------------------------------------------

async function delegatedConfirm(referrer: Hex0x): Promise<ReferralStatus> {
  const { BrowserProvider, Contract, Signature } = await import("ethers");
  // Signing is chain-independent, but the wallet must be ON Arb Sepolia for
  // the EIP-712 domain chainId to display/verify consistently.
  await switchChain(EAS_CHAIN_ID);
  const provider = new BrowserProvider(requireProvider());
  const signer = await provider.getSigner();
  const attester = (await signer.getAddress()).toLowerCase() as Hex0x;
  assertAttesterIsParent(attester);

  const eas = new Contract(
    EAS_ADDRESS,
    ["function getNonce(address account) view returns (uint256)"],
    provider,
  );
  const nonce = (await eas.getNonce(attester)) as bigint;
  const deadline = BigInt(Math.floor(Date.now() / 1000)) + DELEGATION_TTL_SECONDS;

  const message = buildReferralAttestMessage({ attester, referrer, nonce, deadline });
  const raw = await signer.signTypedData(
    EAS_DELEGATED_ATTEST_DOMAIN,
    EAS_DELEGATED_ATTEST_TYPES as unknown as Record<string, { name: string; type: string }[]>,
    message,
  );
  const sig = Signature.from(raw);
  const delegated: DelegatedSignature = { v: sig.v, r: sig.r as Hex0x, s: sig.s as Hex0x };

  const resp = await relayReferral(deadline, delegated);
  if (!resp.ok || !resp.data) throw new Error(resp.error ?? "Server rejected the referral relay");
  return resp.data;
}

// ---------------------------------------------------------------------------
// Coinbase smart wallet — own-gas direct attest (no ECDSA delegated sig)
// ---------------------------------------------------------------------------

async function web3DirectConfirm(referrer: Hex0x): Promise<ReferralStatus> {
  await switchChain(EAS_CHAIN_ID);
  const { BrowserProvider } = await import("ethers");
  const provider = new BrowserProvider(requireProvider());
  const signer = await provider.getSigner();
  assertAttesterIsParent(await signer.getAddress());

  const tx = await signer.sendTransaction({ to: EAS_ADDRESS, data: await encodeAttest(referrer) });
  const receipt = await tx.wait();
  const logs = (receipt?.logs ?? []).map((l) => ({
    address: l.address, topics: l.topics as readonly string[], data: l.data,
  }));
  const uid = await uidFromLogs(logs);

  const resp = await recordReferral(uid);
  if (!resp.ok || !resp.data) throw new Error(resp.error ?? "Server rejected the referral record");
  return resp.data;
}

/**
 * Confirm the signed-in merchant's pending referral on-chain. `referrer` must
 * match the server-held pending record (the server enforces this).
 */
export async function confirmReferral(referrer: Hex0x): Promise<ReferralStatus> {
  switch (auth.kind) {
    case "passkey":
    case "web3auth":
      return kernelConfirm(referrer);
    case "web3":
      return delegatedConfirm(referrer);
    case "coinbase":
      return web3DirectConfirm(referrer);
    default:
      throw new Error(`Referral confirmation is not available for "${auth.kind}" accounts yet.`);
  }
}

