import {
  JsonRpcProvider, Contract, Wallet, keccak256, toUtf8Bytes, concat, namehash,
  AbiCoder, solidityPackedKeccak256, getBytes,
} from "ethers";
import { getChainRpcUrl } from "./event-contract.js";
import { sendSponsorTx } from "./sponsor-nonce.js";
import { getSponsorAddress } from "./sponsor-wallet.js";

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
  // Enumeration: standard ERC-721 mint/transfer; tokenId == node
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  // node → DNS-encoded name; decodeName turns it back into "label.woco.eth"
  "function names(bytes32 node) view returns (bytes)",
  "function decodeName(bytes name) view returns (string)",
  // Resolver record — current Swarm pointer for a name (EIP-1577 contenthash)
  "function contenthash(bytes32 node) view returns (bytes)",
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
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function PERMIT_TYPEHASH() view returns (bytes32)",
  // Sponsor writes
  "function register(string label, address owner, bytes contenthash, string[] textKeys, string[] textValues) returns (bytes32 node)",
  "function setContenthash(string label, bytes contenthash)",
  "function setText(string label, string key, string value)",
  // Permit write — organiser submits tx, server only signs off-chain
  "function registerWithPermit(string label, address owner, bytes contenthash, string[] textKeys, string[] textValues, uint256 expiry, bytes sig) returns (bytes32 node)",
  // Custom errors — required for ethers v6 to decode reverts by name
  "error NotAuthorisedSponsor(address caller)",
  "error LabelIsReserved(string label)",
  "error InvalidLabel(string label)",
  "error EmptyContenthash()",
  "error ArrayLengthMismatch()",
  "error PermitExpired()",
  "error PermitAlreadyUsed()",
  "error PermitInvalid()",
];

// ENS contenthash encoding for a Swarm BZZ hash (EIP-1577 / ENSIP-7).
// Layout: swarm-manifest codec varint (0xe4,0x01=228) | version 0x01 | network varint (0xfa,0x01=250) | keccak-256 code 0x1b | hash length 0x20 | 32-byte hash
const SWARM_ENS_PREFIX = Buffer.from("e40101fa011b20", "hex");

export function encodeSwarmContenthash(hexHash: string): Uint8Array {
  const clean = hexHash.replace(/^0x/, "");
  if (!/^[a-f0-9]{64}$/i.test(clean)) throw new Error("Swarm hash must be 64 hex chars (32 bytes)");
  return Buffer.concat([SWARM_ENS_PREFIX, Buffer.from(clean, "hex")]);
}

const SWARM_ENS_PREFIX_HEX = SWARM_ENS_PREFIX.toString("hex");

/** Reverse of encodeSwarmContenthash — recovers the 64-hex Swarm hash, or null for a
 *  non-Swarm / empty record. Used to build a preview URL for a name's current target. */
export function decodeSwarmContenthash(contenthash: string): string | null {
  const clean = (contenthash || "").replace(/^0x/, "").toLowerCase();
  if (!clean.startsWith(SWARM_ENS_PREFIX_HEX)) return null;
  const hash = clean.slice(SWARM_ENS_PREFIX_HEX.length);
  return /^[a-f0-9]{64}$/.test(hash) ? hash : null;
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

export interface OwnedLabel {
  label: string;
  /** 64-hex Swarm hash the name currently points at, or null if unset / non-Swarm. */
  contentHash: string | null;
}

/**
 * Enumerates every label.woco.eth currently owned by `address`, authoritatively
 * from chain (covers names claimed via any path — sponsor mint or ZeroDev permit).
 *
 * The L2Registry is a small ERC-721, so a full-range Transfer scan is cheap (a
 * handful of logs). For each token minted/transferred TO the address we confirm
 * the live owner (drops names transferred away), decode the readable name, and
 * read its current contenthash for a preview URL.
 */
export async function getOwnedLabels(address: string): Promise<OwnedLabel[]> {
  const chainId = getSubEnsChainId();
  const registry = new Contract(getRegistryAddress(chainId), REGISTRY_ABI, getProvider(chainId));
  const addr = address.toLowerCase();

  const logs = await registry.queryFilter(registry.filters.Transfer!(null, address));
  const tokenIds = [...new Set(logs.map((l) => (l as unknown as { args: { tokenId: bigint } }).args.tokenId.toString()))];

  const out: OwnedLabel[] = [];
  for (const tid of tokenIds) {
    const node = "0x" + BigInt(tid).toString(16).padStart(64, "0");
    let owner: string;
    try { owner = (await registry.ownerOf(tid) as string).toLowerCase(); } catch { continue; }
    if (owner !== addr) continue; // transferred away since the mint/transfer-in

    let name: string;
    try { name = await registry.decodeName(await registry.names(node)) as string; } catch { continue; }
    if (!name || name === "woco.eth" || !name.endsWith(".woco.eth")) continue; // skip base node / malformed
    const label = name.slice(0, -".woco.eth".length);

    let contentHash: string | null = null;
    try { contentHash = decodeSwarmContenthash(await registry.contenthash(node) as string); } catch { /* unset */ }

    out.push({ label, contentHash });
  }
  return out;
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
  const contract = writeContract(chainId);
  const tx = await sendSponsorTx(
    { chainId, address: getSponsorAddress(), provider: getProvider(chainId), label: "sub-ens.register" },
    (o) => contract.register(label, ownerAddress, contenthash, textKeys, textValues, o),
  );
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error("No receipt from register tx");
  console.log(`[sub-ens] registered label=${label} txHash=${receipt.hash} gasUsed=${receipt.gasUsed}`);
  return receipt.hash as string;
}

/**
 * Signs an EIP-712 RegisterPermit for the given (label, ownerAddress).
 * The permit authorises the organiser's wallet to call registerWithPermit() directly,
 * covering gas via ZeroDev paymaster — the server never submits a tx on this path.
 *
 * Expiry = now + PERMIT_TTL (15 min). Returned sig is 65 bytes (r + s + v).
 *
 * Matches WoCoRegistrar's EIP-712 domain: name="WoCoRegistrar", version="1",
 * chainId from the deployment, verifyingContract = registrar address.
 */
export async function signSubEnsPermit(
  label: string,
  ownerAddress: string,
): Promise<{ sig: string; expiry: number }> {
  const pk = process.env.WOCO_SPONSOR_PRIVATE_KEY;
  if (!pk) throw new Error("WOCO_SPONSOR_PRIVATE_KEY is not set");

  const chainId = getSubEnsChainId();
  const registrarAddress = getRegistrarAddress(chainId);

  // Must exactly match the PERMIT_TYPEHASH in WoCoRegistrar.sol
  const PERMIT_TYPEHASH = "0xa899c01319c2d96c76d865f0fa8e4533f1bf4f65cd5814a1564eff695487a2df";

  const DOMAIN_TYPEHASH = keccak256(
    toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
  );

  const domainSeparator = keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32", "bytes32", "uint256", "address"],
    [
      DOMAIN_TYPEHASH,
      keccak256(toUtf8Bytes("WoCoRegistrar")),
      keccak256(toUtf8Bytes("1")),
      chainId,
      registrarAddress,
    ],
  ));

  const PERMIT_TTL_SECS = 15 * 60;
  const expiry = Math.floor(Date.now() / 1000) + PERMIT_TTL_SECS;

  const structHash = keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32", "address", "uint256"],
    [PERMIT_TYPEHASH, keccak256(toUtf8Bytes(label)), ownerAddress, expiry],
  ));

  // EIP-712 final digest: "\x19\x01" + domainSeparator + structHash
  const digest = solidityPackedKeccak256(
    ["string", "bytes32", "bytes32"],
    ["\x19\x01", domainSeparator, structHash],
  );

  const wallet = new Wallet(pk);
  // Sign the raw digest (already EIP-712 structured — do NOT add personal_sign prefix)
  const sig = await wallet.signingKey.sign(getBytes(digest));
  const sigBytes = sig.serialized; // compact 65-byte sig

  console.log(`[sub-ens] signed permit label=${label} owner=${ownerAddress} expiry=${expiry} chain=${chainId}`);
  return { sig: sigBytes, expiry };
}

export async function updateSubEnsContenthash(label: string, swarmHash: string): Promise<string> {
  const chainId = getSubEnsChainId();
  const contenthash = encodeSwarmContenthash(swarmHash);

  console.log(`[sub-ens] setContenthash label=${label} hash=${swarmHash.slice(0, 10)}… chain=${chainId}`);
  const contract = writeContract(chainId);
  const tx = await sendSponsorTx(
    { chainId, address: getSponsorAddress(), provider: getProvider(chainId), label: "sub-ens.setContenthash" },
    (o) => contract.setContenthash(label, contenthash, o),
  );
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error("No receipt from setContenthash tx");
  console.log(`[sub-ens] contenthash updated label=${label} txHash=${receipt.hash}`);
  return receipt.hash as string;
}
