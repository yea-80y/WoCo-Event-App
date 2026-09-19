/**
 * Releasing a sub-ENS name — the holder authorises an irreversible burn.
 *
 * Three rails, one signed payload. The AUTHORITY is always the holder's
 * signature or their own transaction; only the GAS differs:
 *
 *  1. Relay (preferred, free to the user). The holder signs the release as
 *     EIP-712 typed data and `POST /api/sub-ens/relay-release` submits it with
 *     sponsor gas. Works for a plain wallet, which no paymaster can ever cover.
 *  2. Kernel sudo userOp. Used when the relay refuses the signature — the
 *     likely case being a COUNTERFACTUAL Kernel, whose ERC-1271 answer the
 *     ERC-6492 validator cannot check until the account is deployed. The sudo
 *     op deploys it as a side effect and the paymaster pays.
 *  3. Own-gas `release()` from the wallet. The floor: it needs nothing from us.
 *
 * NEVER a scoped session key. None is left on the device — the last one went
 * with the EAS rail (#476) — but the invariant stands whatever arrives next: a
 * 30-day device key that signs without a prompt must not be able to burn a name.
 * A stolen phone would otherwise cost the holder every name they own. The
 * deliberate action gets the deliberate gesture (a passkey prompt, or a wallet
 * confirmation).
 *
 * What is signed, and why each field, is in `release-digest.ts`.
 *
 * A name with names beneath it cannot be released (registry v2.1). That
 * refusal is shown, never routed round: every rail would meet it.
 */

import { SUB_ENS_DEPLOYMENTS, subEnsName } from "@woco/shared";
import type { Hex0x } from "@woco/shared";
import { authPost } from "../api/client.js";
import {
  RELEASE_DIGEST_ABI,
  buildReleaseTypedData,
  releaseExpiration,
  type ReleaseTypedData,
} from "./release-digest.js";
import { unroutableReleaseRefusal } from "./errors.js";
import { SUB_ENS_CHAIN_ID as CHAIN_ID, subEnsRpcUrl as rpcUrl } from "./rpc.js";
import { rememberOwner } from "./verify-name.js";

// The registry's chain and RPC live in `rpc.ts`, shared with the share sheet's
// name reads. The typed data below names that chain in its EIP-712 domain,
// which is why it must never follow the Kernel's chain constant instead.
const REGISTRY = SUB_ENS_DEPLOYMENTS[CHAIN_ID].registry;

const RELEASE_ABI = [...RELEASE_DIGEST_ABI, "function release(bytes32 node)"];

/**
 * Build the typed data the holder must sign, cross-checked against the chain.
 *
 * Built locally because that is what a wallet has to be handed; then hashed
 * and compared with the contract's own `releaseDigest`, and REFUSED on any
 * mismatch, so this file drifting from the deployed contract can never yield a
 * signature aimed at something we did not intend.
 */
export async function prepareRelease(label: string): Promise<{
  node: Hex0x;
  typedData: ReleaseTypedData;
  expiration: number;
}> {
  const { JsonRpcProvider, Contract, TypedDataEncoder, keccak256, namehash, concat, toUtf8Bytes } =
    await import("ethers");

  const provider = new JsonRpcProvider(rpcUrl());
  const registry = new Contract(REGISTRY, RELEASE_ABI, provider);

  // node = keccak(baseNode ‖ keccak(label)) — the same derivation the registry
  // and the server use. Recomputed rather than trusted from anywhere.
  const normalised = label.toLowerCase().trim();
  const node = keccak256(concat([namehash("woco.eth"), keccak256(toUtf8Bytes(normalised))])) as Hex0x;

  // "Now" is the registry chain's latest block, not this device's clock: the
  // registry compares the expiration with `block.timestamp`, which on Arbitrum
  // may run up to a day behind real time or an hour ahead of it, and the relay
  // bounds the window against the same block (audit 950 Low 13).
  const latest = await provider.getBlock("latest");
  if (!latest) throw new Error("Could not read the registry chain's clock. Nothing was signed.");
  const expiration = releaseExpiration(latest.timestamp * 1000);
  const [recordVersion, onChainDigest] = await Promise.all([
    registry.recordVersions(node) as Promise<bigint>,
    registry.releaseDigest(node, expiration) as Promise<string>,
  ]);

  const typedData = buildReleaseTypedData({
    registry: REGISTRY,
    chainId: CHAIN_ID,
    name: subEnsName(normalised),
    node,
    recordVersion,
    expiration,
  });

  // The check that keeps the chain authoritative.
  const local = TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.message);
  if (local.toLowerCase() !== onChainDigest.toLowerCase()) {
    throw new Error(
      "Refusing to sign: this app's release digest does not match the registry's. " +
        "Nothing was signed. Please report this — it means the app and the contract disagree.",
    );
  }

  return { node, typedData, expiration };
}

export interface ReleaseResult {
  txHash: string;
  /** Which rail paid — surfaced so the UI can say "we covered the fee". */
  via: "relay" | "kernel" | "wallet";
}

/**
 * Release `label`, preferring the free rail and falling back rather than
 * stranding the holder.
 *
 * A relay refusal is NOT an error the user should see unless no other rail
 * could succeed (`unroutableReleaseRefusal`): it means the sponsor would not
 * or could not submit, and the holder can always act alone. So each other
 * failure steps down a rail instead of surfacing.
 */
export async function releaseName(
  label: string,
  opts: {
    /** Present for Kernel logins — used for the sudo fallback. */
    kernelRelease?: (node: Hex0x) => Promise<{ txHash: string }>;
    /** Present for wallet logins — own-gas fallback. */
    walletRelease?: (node: Hex0x) => Promise<{ txHash: string }>;
    /**
     * Signs the release as EIP-712 typed data (`eth_signTypedData_v4`). The
     * domain names the registry's chain, which wallets require to be the
     * active one, so the implementation switches chain before signing.
     */
    signTypedData: (typed: ReleaseTypedData) => Promise<string>;
  },
): Promise<ReleaseResult> {
  const { node, typedData, expiration } = await prepareRelease(label);

  const signature = await opts.signTypedData(typedData);
  const relayed = await authPost<{ label: string; txHash: string }>(
    "/api/sub-ens/relay-release",
    { label, expiration, signature },
  );
  if (relayed.ok && relayed.data) {
    rememberOwner(label, null); // it is gone; stop rendering it immediately
    return { txHash: relayed.data.txHash, via: "relay" };
  }

  const shown = unroutableReleaseRefusal(relayed.error);
  if (shown) throw new Error(shown);

  console.warn("[sub-ens] release relay refused, falling back to own signer:", relayed.error);
  const fallback = opts.kernelRelease ?? opts.walletRelease;
  if (!fallback) throw new Error(relayed.error ?? "Could not release the name");
  const { txHash } = await fallback(node);
  rememberOwner(label, null);
  return { txHash, via: opts.kernelRelease ? "kernel" : "wallet" };
}
