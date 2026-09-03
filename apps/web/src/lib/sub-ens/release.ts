/**
 * Releasing a sub-ENS name — the holder authorises an irreversible burn.
 *
 * Three rails, one signed payload. The AUTHORITY is always the holder's
 * signature or their own transaction; only the GAS differs:
 *
 *  1. Relay (preferred, free to the user). The holder signs the release digest
 *     and `POST /api/sub-ens/relay-release` submits it with sponsor gas. Works
 *     for a plain wallet, which no paymaster can ever cover.
 *  2. Kernel sudo userOp. Used when the relay refuses the signature — the
 *     likely case being a COUNTERFACTUAL Kernel, whose ERC-1271 answer the
 *     ERC-6492 validator cannot check until the account is deployed. The sudo
 *     op deploys it as a side effect and the paymaster pays.
 *  3. Own-gas `release()` from the wallet. The floor: it needs nothing from us.
 *
 * NEVER the scoped session key. Its CallPolicy is `registerWithPermit` on the
 * registrar ONLY, by documented invariant — and that is deliberate: a 30-day
 * device key must not be able to silently burn a name. A stolen phone would
 * otherwise cost the holder every name they own. The deliberate action gets the
 * deliberate gesture (a passkey prompt, or a wallet confirmation).
 *
 * The digest subtlety that makes or breaks all of this is in `release-digest.ts`.
 */

import { SUB_ENS_DEPLOYMENTS } from "@woco/shared";
import type { Hex0x } from "@woco/shared";
import { authPost } from "../api/client.js";
import {
  RELEASE_DIGEST_ABI,
  buildReleaseInnerHash,
  releaseExpiration,
} from "./release-digest.js";
import { rememberOwner } from "./verify-name.js";

/** The chain the registry lives on — the same one the Kernel runs on. */
const CHAIN_ID = 421614 as const;
const REGISTRY = SUB_ENS_DEPLOYMENTS[CHAIN_ID].registry;

const RELEASE_ABI = [...RELEASE_DIGEST_ABI, "function release(bytes32 node)"];

function rpcUrl(): string {
  const env = import.meta.env as Record<string, string | undefined>;
  return env.VITE_ZERODEV_RPC || "https://sepolia-rollup.arbitrum.io/rpc";
}

/**
 * Build the exact bytes the holder must sign, cross-checked against the chain.
 *
 * We derive the inner hash locally because that is what a wallet has to be
 * handed — `releaseDigest` is already EIP-191-wrapped, so signing IT would
 * prefix twice and produce a signature the contract rejects. Having derived it,
 * we assert that hashing it reproduces the contract's own `releaseDigest` and
 * REFUSE on any mismatch, so this file drifting from the deployed contract can
 * never yield a signature aimed at something we did not intend.
 */
export async function prepareRelease(label: string): Promise<{
  node: Hex0x;
  innerHash: Hex0x;
  expiration: number;
}> {
  const { JsonRpcProvider, Contract, AbiCoder, keccak256, namehash, concat, toUtf8Bytes, hashMessage } =
    await import("ethers");

  const provider = new JsonRpcProvider(rpcUrl());
  const registry = new Contract(REGISTRY, RELEASE_ABI, provider);

  // node = keccak(baseNode ‖ keccak(label)) — the same derivation the registry
  // and the server use. Recomputed rather than trusted from anywhere.
  const node = keccak256(
    concat([namehash("woco.eth"), keccak256(toUtf8Bytes(label.toLowerCase().trim()))]),
  ) as Hex0x;

  const expiration = releaseExpiration();
  const [typehash, recordVersion, onChainDigest] = await Promise.all([
    registry.RELEASE_TYPEHASH() as Promise<string>,
    registry.recordVersions(node) as Promise<bigint>,
    registry.releaseDigest(node, expiration) as Promise<string>,
  ]);

  const coder = AbiCoder.defaultAbiCoder();
  const innerHash = buildReleaseInnerHash(
    {
      typehash: typehash as Hex0x,
      registry: REGISTRY,
      chainId: CHAIN_ID,
      node,
      recordVersion,
      expiration,
    },
    { encode: (t, v) => coder.encode(t, v), keccak256 },
  );

  // The check that keeps the chain authoritative.
  if (hashMessage(getBytes32(innerHash)).toLowerCase() !== onChainDigest.toLowerCase()) {
    throw new Error(
      "Refusing to sign: this app's release digest does not match the registry's. " +
        "Nothing was signed. Please report this — it means the app and the contract disagree.",
    );
  }

  return { node, innerHash, expiration };
}

/** ethers' `getBytes` without importing it at module scope. */
function getBytes32(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
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
 * A relay refusal is NOT an error the user should see: it means the sponsor
 * would not or could not submit, and the holder can always act alone. So each
 * failure steps down a rail instead of surfacing.
 */
export async function releaseName(
  label: string,
  opts: {
    /** Present for Kernel logins — used for the sudo fallback. */
    kernelRelease?: (node: Hex0x) => Promise<{ txHash: string }>;
    /** Present for wallet logins — own-gas fallback. */
    walletRelease?: (node: Hex0x) => Promise<{ txHash: string }>;
    /** Signs the 32 raw bytes as an EIP-191 personal-sign message. */
    signInnerHash: (innerHash: Hex0x) => Promise<string>;
  },
): Promise<ReleaseResult> {
  const { node, innerHash, expiration } = await prepareRelease(label);

  const signature = await opts.signInnerHash(innerHash);
  const relayed = await authPost<{ label: string; txHash: string }>(
    "/api/sub-ens/relay-release",
    { label, expiration, signature },
  );
  if (relayed.ok && relayed.data) {
    rememberOwner(label, null); // it is gone; stop rendering it immediately
    return { txHash: relayed.data.txHash, via: "relay" };
  }

  // A refusal the user MUST see rather than route around: their own identity
  // name, which the server declines to sponsor on purpose.
  if (relayed.error === "profile_name") {
    throw new Error(
      "That's the name your profile is known by. Change your profile name first, then release this one.",
    );
  }

  console.warn("[sub-ens] release relay refused, falling back to own signer:", relayed.error);
  const fallback = opts.kernelRelease ?? opts.walletRelease;
  if (!fallback) throw new Error(relayed.error ?? "Could not release the name");
  const { txHash } = await fallback(node);
  rememberOwner(label, null);
  return { txHash, via: opts.kernelRelease ? "kernel" : "wallet" };
}
