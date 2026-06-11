/**
 * EAS likes (#4) — client write path. Turns a like/unlike into an on-chain EAS
 * `attest` / `revoke` on Arbitrum Sepolia, with the user's **own account as the
 * attester** (Option 1, user-attested → trustless graph).
 *
 * Two rails, same calldata, same resulting attester (= `auth.parent`):
 *  - **passkey** → the Kernel smart account attests GASLESS via its scoped
 *    session key + ZeroDev paymaster (reuses the sub-ENS rail).
 *  - **web3 (MetaMask/WalletConnect)** → the parent EOA signs + sends the tx
 *    directly (own trivial testnet gas). Unlike Swarm feeds, the parent IS
 *    allowed to sign its own public on-chain claims (see
 *    project_signing_role_architecture).
 *
 * Para/email gasless (universal) is Option 2 (delegated attestation) — future.
 *
 * The caller is responsible for sign-in (requireAccountForAction) before
 * invoking these. Returns the on-chain UID (needed later to revoke).
 */

import type { Hex0x, LikeSubject } from "@woco/shared";
import {
  EAS_ADDRESS, EAS_SCHEMA_UID, EAS_CHAIN_ID,
} from "@woco/shared";
import { auth } from "../auth/auth-store.svelte.js";
import { getEasSessionClient, sendSessionUserOp } from "../auth/kernel-account.js";
import { switchChain } from "../payment/chains.js";
import { requireProvider } from "../wallet/provider.js";
import { EAS_SESSION_ABI, EAS_EVENTS_ABI } from "./eas-abi.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const ZERO_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/** Guard: refuse to build calldata against an unregistered schema. */
function assertSchemaReady(): void {
  if (!EAS_SCHEMA_UID || EAS_SCHEMA_UID === ZERO_HASH) {
    throw new Error("EAS_SCHEMA_UID is not set — register the likes schema first.");
  }
}

/** ABI-encode the `attest` calldata for a like on `subject`. */
async function encodeAttest(subject: LikeSubject): Promise<Hex0x> {
  const { encodeFunctionData, encodeAbiParameters } = await import("viem");
  const schemaData = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint8" }],
    [subject.id, subject.type],
  );
  return encodeFunctionData({
    abi: EAS_SESSION_ABI,
    functionName: "attest",
    args: [
      {
        schema: EAS_SCHEMA_UID,
        data: {
          // recipient unused — the liked entity lives in `data.subject`; owner
          // is resolved live from chain, never baked into the attestation.
          recipient: ZERO_ADDRESS,
          expirationTime: 0n,
          revocable: true,
          refUID: ZERO_HASH,
          data: schemaData,
          value: 0n,
        },
      },
    ],
  }) as Hex0x;
}

/** ABI-encode the `revoke` calldata for an existing like UID. */
async function encodeRevoke(uid: Hex0x): Promise<Hex0x> {
  const { encodeFunctionData } = await import("viem");
  return encodeFunctionData({
    abi: EAS_SESSION_ABI,
    functionName: "revoke",
    args: [{ schema: EAS_SCHEMA_UID, data: { uid, value: 0n } }],
  }) as Hex0x;
}

/** Pull the on-chain UID out of an `Attested` log for our schema. */
async function uidFromLogs(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
): Promise<Hex0x> {
  const { parseEventLogs } = await import("viem");
  const parsed = parseEventLogs({
    abi: EAS_EVENTS_ABI,
    eventName: "Attested",
    // viem wants 0x-typed fields; receipt logs already carry them.
    logs: logs as never,
  });
  const hit = parsed.find(
    (l) => (l.args as { schemaUID: string }).schemaUID.toLowerCase() === EAS_SCHEMA_UID.toLowerCase(),
  );
  const uid = (hit?.args as { uid?: Hex0x } | undefined)?.uid;
  if (!uid) throw new Error("Attested event with our schema not found in receipt");
  return uid;
}

// ---------------------------------------------------------------------------
// Passkey (gasless via Kernel session key)
// ---------------------------------------------------------------------------

async function passkeySend(data: Hex0x): Promise<{ uid: Hex0x | null; txHash: string }> {
  const kernelAddress = await auth.ensureEasSessionKey(); // mints the EAS-scoped key on first use
  const client = await getEasSessionClient(kernelAddress);
  if (!client) throw new Error("No EAS session key on this device for the Kernel.");

  const { receipt } = await sendSessionUserOp(client, [{ to: EAS_ADDRESS, data }]);
  const logs = (receipt.logs ?? []) as never;
  const uid = receipt.success ? await uidFromLogs(logs).catch(() => null) : null;
  return { uid, txHash: receipt.receipt.transactionHash };
}

// ---------------------------------------------------------------------------
// Web3 parent EOA (own gas)
// ---------------------------------------------------------------------------

async function web3Send(data: Hex0x): Promise<{ uid: Hex0x | null; txHash: string }> {
  await switchChain(EAS_CHAIN_ID);
  // Fresh provider post-switch so the cached network isn't stale.
  const { BrowserProvider } = await import("ethers");
  const provider = new BrowserProvider(requireProvider());
  const signer = await provider.getSigner();

  // Security: the on-chain attester MUST be the authenticated parent, else the
  // server /record (attester == verified parentAddress) rejects it. Fail fast
  // on a wallet account-switch instead of burning gas on a tx we can't index.
  const signerAddr = (await signer.getAddress()).toLowerCase();
  if (auth.parent && signerAddr !== auth.parent.toLowerCase()) {
    throw new Error(
      `Wallet account (${signerAddr}) is not the signed-in account (${auth.parent}). Switch back to like.`,
    );
  }

  const tx = await signer.sendTransaction({ to: EAS_ADDRESS, data });
  const receipt = await tx.wait();
  const logs = (receipt?.logs ?? []).map((l) => ({
    address: l.address,
    topics: l.topics as readonly string[],
    data: l.data,
  }));
  const uid = await uidFromLogs(logs).catch(() => null);
  return { uid, txHash: tx.hash };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function send(data: Hex0x): Promise<{ uid: Hex0x | null; txHash: string }> {
  switch (auth.kind) {
    case "passkey":
      return passkeySend(data);
    case "web3":
    case "coinbase":
      return web3Send(data);
    default:
      // Para/email/local: Option 2 (delegated attestation) not built yet.
      throw new Error(`On-chain likes are not available for "${auth.kind}" accounts yet.`);
  }
}

/** Attest a like on `subject`. Returns the on-chain UID (for later revoke). */
export async function attestLike(subject: LikeSubject): Promise<{ uid: Hex0x; txHash: string }> {
  assertSchemaReady();
  const { uid, txHash } = await send(await encodeAttest(subject));
  if (!uid) throw new Error("Like submitted but no UID returned — tx may have reverted.");
  return { uid, txHash };
}

/** Revoke an existing like by its UID. */
export async function revokeLike(uid: Hex0x): Promise<{ txHash: string }> {
  assertSchemaReady();
  const { txHash } = await send(await encodeRevoke(uid));
  return { txHash };
}
