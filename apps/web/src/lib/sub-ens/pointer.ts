/**
 * Pointing a name at a site or at the app — the HOLDER signs, the platform
 * relays (registrar v2.2, Fable sponsor-key consult §2).
 *
 * No key the platform holds can change what a name points at. The holder signs
 * EIP-712 typed data, `POST /api/sub-ens/set-contenthash` submits it with the
 * names sponsor paying the gas, and `WoCoRegistrar.setContenthashWithSignature`
 * checks the signature against the name's CURRENT holder:
 *
 *   domain         { name: "WoCo Registrar", version: "1", chainId, verifyingContract: registrar }
 *   SetContenthash { name: "punkpub.woco.eth", node, contenthash, nonce, expiration }
 *
 * Why each field: the domain pins the registrar and the chain; `node` pins the
 * name and `name` shows it; `contenthash` is exactly what the name will point
 * at; `nonce` is per name and moves on every accepted write, so a signature is
 * used once; `expiration` bounds it (the contract refuses one more than 48
 * hours ahead, the relay one more than 15 minutes).
 *
 * This is asked for at BIND, not at publish: a site name points at the site's
 * feed manifest, which every publish advances, so the name follows with no
 * signature (`sites.ts` deploy → `status: "awaiting_signature"` only when the
 * name is not on it yet).
 *
 * CHAIN STAYS THE REFERENCE. The typed data is built here because that is what
 * a wallet must be handed, then its hash is compared with the registrar's own
 * `setContenthashDigest`, and a mismatch refuses to sign.
 */

import { SUB_ENS_DEPLOYMENTS, subEnsName } from "@woco/shared";
import type { Hex0x } from "@woco/shared";
import { authPost } from "../api/client.js";
import { apiError } from "../api/errors.js";
import { SUB_ENS_CHAIN_ID as CHAIN_ID, subEnsRpcUrl as rpcUrl } from "./rpc.js";
import {
  POINTER_TTL_SECS,
  buildPointerTypedData,
  swarmContenthash,
  type PointerTypedData,
} from "./pointer-digest.js";

export type { PointerTypedData };

const REGISTRAR = SUB_ENS_DEPLOYMENTS[CHAIN_ID].registrar;

const POINTER_ABI = [
  "function pointerNonce(bytes32 node) view returns (uint256)",
  "function setContenthashDigest(bytes32 node, bytes contenthash, uint256 expiration) view returns (bytes32)",
] as const;

/** Build the typed data for `label` → `swarmHash`, cross-checked against the chain. */
export async function preparePointer(label: string, swarmHash: string): Promise<PointerTypedData> {
  const { JsonRpcProvider, Contract, TypedDataEncoder, keccak256, namehash, concat, toUtf8Bytes } =
    await import("ethers");
  const provider = new JsonRpcProvider(rpcUrl());
  const registrar = new Contract(REGISTRAR, POINTER_ABI, provider);

  const normalised = label.toLowerCase().trim();
  const node = keccak256(concat([namehash("woco.eth"), keccak256(toUtf8Bytes(normalised))])) as Hex0x;
  const contenthash = swarmContenthash(swarmHash);

  const latest = await provider.getBlock("latest");
  if (!latest) throw new Error("Could not read the names chain's clock. Nothing was signed.");
  const expiration = latest.timestamp + POINTER_TTL_SECS;
  const [nonce, onChainDigest] = await Promise.all([
    registrar.pointerNonce(node) as Promise<bigint>,
    registrar.setContenthashDigest(node, contenthash, expiration) as Promise<string>,
  ]);

  const typed = buildPointerTypedData({
    registrar: REGISTRAR,
    chainId: CHAIN_ID,
    name: subEnsName(normalised),
    node,
    contenthash,
    nonce,
    expiration,
  });
  const local = TypedDataEncoder.hash(typed.domain, typed.types, typed.message);
  if (local.toLowerCase() !== onChainDigest.toLowerCase()) {
    throw new Error(
      "Refusing to sign: this app's pointer digest does not match the registrar's. " +
        "Nothing was signed. Please report this — the app and the contract disagree.",
    );
  }
  return typed;
}

/**
 * Point `label` at `swarmHash`: build, have the holder sign, relay. Returns the
 * transaction hash. `signTypedData` signs as the HOLDER (`auth.signTypedDataAsHolder`).
 * A refusal throws an `ApiError` carrying the server's code, for `subEnsErrorFrom`.
 */
export async function pointNameAt(
  label: string,
  swarmHash: string,
  signTypedData: (typed: PointerTypedData) => Promise<string>,
): Promise<string> {
  const typed = await preparePointer(label, swarmHash);
  const signature = await signTypedData(typed);
  const resp = await authPost<{ label: string; txHash: string }>("/api/sub-ens/set-contenthash", {
    label,
    swarmHash: swarmHash.replace(/^0x/, "").toLowerCase(),
    expiration: typed.message.expiration,
    signature,
  });
  if (!resp.ok || !resp.data) throw apiError(resp, "Couldn't point the name");
  return resp.data.txHash;
}
