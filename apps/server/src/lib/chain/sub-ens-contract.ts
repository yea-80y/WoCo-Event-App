import { JsonRpcProvider, Contract, Wallet, keccak256, toUtf8Bytes, concat, namehash } from "ethers";
import { getChainRpcUrl } from "./event-contract.js";

// Arbitrum Sepolia (421614) — deployed 2026-05-29, verified
// Arbitrum One (42161)      — pending mainnet deploy
const REGISTRAR_ADDRESSES: Record<number, string> = {
  421614: "0x206e5e2fBF813b5E8A2c2D6ae54106165975BEd3",
};

// L2Registry addresses (Durin factory-deployed clones)
const REGISTRY_ADDRESSES: Record<number, string> = {
  421614: "0x41Fb196Ae7D65E06880A240c8d1B91245Fb84807",
};

// namehash("woco.eth") — the base node of our L2Registry.
// Computed once at module load; namehash() is a pure function (no provider).
const WOCO_ETH_BASE_NODE = namehash("woco.eth");

const REGISTRY_ABI = [
  // ERC-721 ownerOf — reverts if token (label) doesn't exist
  "function ownerOf(uint256 tokenId) view returns (address)",
];

// Override either with env. Chain defaults to Arb Sepolia during buildathon.
function getSubEnsChainId(): number {
  return parseInt(process.env.SUB_ENS_CHAIN_ID ?? "421614");
}

function getRegistrarAddress(chainId: number): string {
  const addr = process.env.SUB_ENS_REGISTRAR_ADDRESS ?? REGISTRAR_ADDRESSES[chainId];
  if (!addr) throw new Error(`No WoCoRegistrar address for chain ${chainId}`);
  return addr;
}

function getRegistryAddress(chainId: number): string {
  const addr = process.env.SUB_ENS_REGISTRY_ADDRESS ?? REGISTRY_ADDRESSES[chainId];
  if (!addr) throw new Error(`No L2Registry address for chain ${chainId}`);
  return addr;
}

// Mirrors WoCoRegistrar._validLabel and L2Registry.makeNode:
// node = keccak256(abi.encodePacked(baseNode, keccak256(bytes(label))))
function computeLabelNode(label: string): bigint {
  const labelHash = keccak256(toUtf8Bytes(label));
  return BigInt(keccak256(concat([WOCO_ETH_BASE_NODE, labelHash])));
}

const REGISTRAR_ABI = [
  // Views
  "function available(string label) view returns (bool)",
  // Sponsor writes
  "function register(string label, address owner, bytes contenthash, string[] textKeys, string[] textValues) returns (bytes32 node)",
  "function setContenthash(string label, bytes contenthash)",
  "function setText(string label, string key, string value)",
  // Custom errors — required for ethers v6 to decode reverts by name
  "error NotAuthorisedSponsor(address caller)",
  "error LabelIsReserved(string label)",
  "error InvalidLabel(string label)",
  "error EmptyContenthash()",
  "error ArrayLengthMismatch()",
];

// ENS contenthash encoding for a Swarm BZZ hash (EIP-1577 / ENSIP-7).
// Layout: swarm-manifest codec varint (0xe4,0x01=228) | version 0x01 | network varint (0xfa,0x01=250) | keccak-256 code 0x1b | hash length 0x20 | 32-byte hash
const SWARM_ENS_PREFIX = Buffer.from("e40101fa011b20", "hex");

export function encodeSwarmContenthash(hexHash: string): Uint8Array {
  const clean = hexHash.replace(/^0x/, "");
  if (!/^[a-f0-9]{64}$/i.test(clean)) throw new Error("Swarm hash must be 64 hex chars (32 bytes)");
  return Buffer.concat([SWARM_ENS_PREFIX, Buffer.from(clean, "hex")]);
}

const _providers = new Map<number, JsonRpcProvider>();

function getProvider(chainId: number): JsonRpcProvider {
  let p = _providers.get(chainId);
  if (!p) {
    p = new JsonRpcProvider(getChainRpcUrl(chainId));
    _providers.set(chainId, p);
  }
  return p;
}

function readContract(chainId: number): Contract {
  return new Contract(getRegistrarAddress(chainId), REGISTRAR_ABI, getProvider(chainId));
}

function writeContract(chainId: number): Contract {
  const pk = process.env.WOCO_SPONSOR_PRIVATE_KEY;
  if (!pk) throw new Error("WOCO_SPONSOR_PRIVATE_KEY is not set");
  return new Contract(getRegistrarAddress(chainId), REGISTRAR_ABI, new Wallet(pk, getProvider(chainId)));
}

export async function isLabelAvailable(label: string): Promise<boolean> {
  return readContract(getSubEnsChainId()).available(label) as Promise<boolean>;
}

/**
 * Returns the current on-chain owner of label.woco.eth (lowercased), or null
 * if the label is not yet registered. Used to authorise mutation calls — the
 * caller's parentAddress must match before the sponsor wallet fires any tx.
 */
export async function getLabelOwner(label: string): Promise<string | null> {
  const chainId = getSubEnsChainId();
  const registry = new Contract(getRegistryAddress(chainId), REGISTRY_ABI, getProvider(chainId));
  try {
    const owner = await registry.ownerOf(computeLabelNode(label)) as string;
    return owner.toLowerCase();
  } catch {
    // ERC-721 reverts when the tokenId doesn't exist (unregistered label)
    return null;
  }
}

export async function mintSubEnsName(
  label: string,
  ownerAddress: string,
  swarmHash: string | null,
  textKeys: string[],
  textValues: string[],
): Promise<string> {
  const chainId = getSubEnsChainId();
  const contenthash = swarmHash ? encodeSwarmContenthash(swarmHash) : new Uint8Array(0);

  console.log(`[sub-ens] register label=${label} owner=${ownerAddress} chain=${chainId}`);
  const tx = await writeContract(chainId).register(label, ownerAddress, contenthash, textKeys, textValues);
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error("No receipt from register tx");
  console.log(`[sub-ens] registered label=${label} txHash=${receipt.hash} gasUsed=${receipt.gasUsed}`);
  return receipt.hash as string;
}

export async function updateSubEnsContenthash(label: string, swarmHash: string): Promise<string> {
  const chainId = getSubEnsChainId();
  const contenthash = encodeSwarmContenthash(swarmHash);

  console.log(`[sub-ens] setContenthash label=${label} hash=${swarmHash.slice(0, 10)}… chain=${chainId}`);
  const tx = await writeContract(chainId).setContenthash(label, contenthash);
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error("No receipt from setContenthash tx");
  console.log(`[sub-ens] contenthash updated label=${label} txHash=${receipt.hash}`);
  return receipt.hash as string;
}
