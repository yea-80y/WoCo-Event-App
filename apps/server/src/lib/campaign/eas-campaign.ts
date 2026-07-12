/**
 * On-chain EAS access for the onboarding campaign (referrals + badges).
 *
 * Mirrors likes/eas-onchain.ts: the chain is authoritative, the server stores
 * only projections. Two write paths live here because both spend PLATFORM gas
 * (WOCO_SPONSOR_PRIVATE_KEY) and are gated upstream by the route:
 *  - relayDelegatedReferral — submits the merchant's EIP-712-signed delegated
 *    attest. Attester on-chain = the merchant; we only pay the gas. The
 *    signature is verified locally against a fresh chain-read nonce before
 *    anything is sent, so a forged payload never costs a tx.
 *  - attestJoinedBadge — platform-attested cohort badge (the platform IS the
 *    authority on "who joined when", so attester = sponsor key by design).
 */

import { JsonRpcProvider, Contract, Wallet, AbiCoder, verifyTypedData } from "ethers";
import {
  EAS_ADDRESS, EAS_CHAIN_ID,
  EAS_REFERRAL_SCHEMA_UID, EAS_BADGE_SCHEMA_UID,
  EAS_DELEGATED_ATTEST_DOMAIN, EAS_DELEGATED_ATTEST_TYPES,
  buildReferralAttestMessage, encodeReferralData, ZERO_BYTES32,
  BadgeType,
} from "@woco/shared";
import type { Hex0x, DelegatedSignature } from "@woco/shared";
import { getChainRpcUrl } from "../chain/event-contract.js";

const EAS_ABI = [
  "function getAttestation(bytes32 uid) view returns (tuple(bytes32 uid, bytes32 schema, uint64 time, uint64 expirationTime, uint64 revocationTime, bytes32 refUID, address recipient, address attester, bool revocable, bytes data))",
  "function getNonce(address account) view returns (uint256)",
  "function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data) request) payable returns (bytes32)",
  "function attestByDelegation((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data,(uint8 v,bytes32 r,bytes32 s) signature,address attester,uint64 deadline) delegatedRequest) payable returns (bytes32)",
  "event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)",
];

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

// Same read-after-write retry rationale as likes/eas-onchain.ts.
const READ_ATTEMPTS = 6;
const READ_DELAY_MS = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let _provider: JsonRpcProvider | null = null;
function provider(): JsonRpcProvider {
  if (!_provider) _provider = new JsonRpcProvider(getChainRpcUrl(EAS_CHAIN_ID), EAS_CHAIN_ID);
  return _provider;
}

let _sponsor: Wallet | null = null;
function sponsor(): Wallet {
  if (!_sponsor) {
    const pk = process.env.WOCO_SPONSOR_PRIVATE_KEY;
    if (!pk) throw new Error("WOCO_SPONSOR_PRIVATE_KEY is not set");
    _sponsor = new Wallet(pk, provider());
  }
  return _sponsor;
}

const referralSchemaUid = (): Hex0x =>
  (process.env.EAS_REFERRAL_SCHEMA_UID as Hex0x | undefined) ?? EAS_REFERRAL_SCHEMA_UID;
const badgeSchemaUid = (): Hex0x =>
  (process.env.EAS_BADGE_SCHEMA_UID as Hex0x | undefined) ?? EAS_BADGE_SCHEMA_UID;

/** Serialise sponsor-wallet sends — one funded EOA, concurrent txs race nonces. */
let sendChain: Promise<unknown> = Promise.resolve();
function withSponsorLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = sendChain.then(fn, fn);
  sendChain = next.then(() => {}, () => {});
  return next;
}

function uidFromReceipt(receipt: { logs: readonly any[] }, schema: Hex0x, iface: Contract["interface"]): Hex0x {
  for (const log of receipt.logs) {
    if ((log.address as string).toLowerCase() !== EAS_ADDRESS.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "Attested" && (parsed.args.schemaUID as string).toLowerCase() === schema.toLowerCase()) {
        return (parsed.args.uid as string).toLowerCase() as Hex0x;
      }
    } catch {
      // Non-EAS log shape — skip.
    }
  }
  throw new Error("Attested event for schema not found in receipt");
}

// ---------------------------------------------------------------------------
// Referral: verify (read path) + delegated relay (write path)
// ---------------------------------------------------------------------------

export interface OnChainReferral {
  referrer: Hex0x;
  attester: Hex0x; // the referred merchant
  uid: Hex0x;
  time: number;
  revoked: boolean;
}

/**
 * Fetch + validate a referral attestation by UID — the linchpin behind
 * /record: referrer and attester are read FROM CHAIN, never from the body.
 */
export async function getVerifiedReferral(uid: string): Promise<
  { ok: true; referral: OnChainReferral } | { ok: false; error: string }
> {
  const eas = new Contract(EAS_ADDRESS, EAS_ABI, provider());
  let att: any = null;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    try {
      att = await eas.getAttestation(uid);
    } catch {
      att = null;
    }
    if (att && att.attester !== ZERO_ADDR) break;
    if (attempt < READ_ATTEMPTS - 1) await sleep(READ_DELAY_MS);
  }
  if (!att || att.attester === ZERO_ADDR) return { ok: false, error: "AttestationNotFound" };
  if ((att.schema as string).toLowerCase() !== referralSchemaUid().toLowerCase()) {
    return { ok: false, error: "SchemaMismatch" };
  }
  let referrer: Hex0x;
  try {
    const [decoded] = AbiCoder.defaultAbiCoder().decode(["address"], att.data as string);
    referrer = (decoded as string).toLowerCase() as Hex0x;
  } catch {
    return { ok: false, error: "MalformedAttestationData" };
  }
  return {
    ok: true,
    referral: {
      referrer,
      attester: (att.attester as string).toLowerCase() as Hex0x,
      uid: (att.uid as string).toLowerCase() as Hex0x,
      time: Number(att.time as bigint),
      revoked: (att.revocationTime as bigint) !== 0n,
    },
  };
}

/**
 * Relay a merchant's delegated referral attest (EOA rail). Rebuilds the exact
 * typed data from OUR chain-read nonce + the server-held pending referrer,
 * verifies the signature recovers to the attester, then submits on the
 * sponsor wallet. Caller (route) has already enforced the Stripe gate.
 */
export async function relayDelegatedReferral(input: {
  attester: Hex0x; // authenticated merchant (verified parentAddress)
  referrer: Hex0x; // from the server-held pending record, never the body
  deadline: bigint;
  signature: DelegatedSignature;
}): Promise<{ ok: true; uid: Hex0x; txHash: string } | { ok: false; error: string }> {
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (input.deadline !== 0n && input.deadline < nowSec) {
    return { ok: false, error: "Signature deadline has passed — sign again" };
  }

  const eas = new Contract(EAS_ADDRESS, EAS_ABI, sponsor());
  const nonce = (await eas.getNonce(input.attester)) as bigint;
  const message = buildReferralAttestMessage({
    attester: input.attester,
    referrer: input.referrer,
    nonce,
    deadline: input.deadline,
  });

  let recovered: string;
  try {
    recovered = verifyTypedData(
      EAS_DELEGATED_ATTEST_DOMAIN,
      EAS_DELEGATED_ATTEST_TYPES as unknown as Record<string, { name: string; type: string }[]>,
      message,
      { v: input.signature.v, r: input.signature.r, s: input.signature.s },
    );
  } catch {
    return { ok: false, error: "Malformed signature" };
  }
  if (recovered.toLowerCase() !== input.attester.toLowerCase()) {
    return { ok: false, error: "Signature does not recover to the authenticated account" };
  }

  try {
    const receipt = await withSponsorLock(async () => {
      const tx = await eas.attestByDelegation({
        schema: referralSchemaUid(),
        data: {
          recipient: input.referrer,
          expirationTime: 0n,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: encodeReferralData(input.referrer),
          value: 0n,
        },
        signature: input.signature,
        attester: input.attester,
        deadline: input.deadline,
      });
      return tx.wait();
    });
    const uid = uidFromReceipt(receipt!, referralSchemaUid(), eas.interface);
    return { ok: true, uid, txHash: receipt!.hash };
  } catch (err) {
    console.error("[campaign] attestByDelegation failed:", err);
    return { ok: false, error: "On-chain relay failed" };
  }
}

// ---------------------------------------------------------------------------
// Badge: platform-attested cohort membership
// ---------------------------------------------------------------------------

export async function attestJoinedBadge(
  recipient: Hex0x,
  epoch: number,
): Promise<{ uid: Hex0x; time: number }> {
  const eas = new Contract(EAS_ADDRESS, EAS_ABI, sponsor());
  const data = AbiCoder.defaultAbiCoder().encode(
    ["uint8", "uint32"],
    [BadgeType.Joined, epoch],
  );
  const receipt = await withSponsorLock(async () => {
    const tx = await eas.attest({
      schema: badgeSchemaUid(),
      data: {
        recipient,
        expirationTime: 0n,
        revocable: true,
        refUID: ZERO_BYTES32,
        data,
        value: 0n,
      },
    });
    return tx.wait();
  });
  const uid = uidFromReceipt(receipt!, badgeSchemaUid(), eas.interface);
  const block = await provider().getBlock(receipt!.blockNumber);
  return { uid, time: block?.timestamp ?? Math.floor(Date.now() / 1000) };
}
