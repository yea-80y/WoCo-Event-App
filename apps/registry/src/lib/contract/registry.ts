/**
 * Registry contract interaction layer using ethers v6.
 */
import { Contract, JsonRpcProvider, type Signer, zeroPadValue, hexlify } from "ethers";
import { REGISTRY_ABI } from "./abi";
import { getRegistryAddress, getDefaultChainId, getDefaultRpcUrl } from "./addresses";

export interface Registration {
  owner: string;
  projectName: string;
  platform: string;
  ensName: string;
  repoUrl: string;
  registeredAt: number;
  revoked: boolean;
}

export interface VerificationResult {
  verified: boolean;
  registration: Registration | null;
}

/**
 * Normalise a content hash string to bytes32.
 * - If already 66 chars (0x + 64 hex): use as-is
 * - If 64 hex chars (no prefix): add 0x
 * - Otherwise: pad or error
 */
export function toBytes32(hash: string): string {
  let h = hash.trim();
  if (h.startsWith("0x")) h = h.slice(2);
  if (!/^[0-9a-fA-F]+$/.test(h)) throw new Error("Invalid hex string");
  if (h.length > 64) throw new Error("Hash too long for bytes32");
  // Left-pad to 64 hex chars if needed (right-aligned)
  return zeroPadValue(hexlify("0x" + h), 32);
}

/** Get a read-only contract instance (no wallet needed) */
function getReadOnlyContract(): Contract | null {
  const chainId = getDefaultChainId();
  const address = getRegistryAddress(chainId);
  if (!address) return null;
  const provider = new JsonRpcProvider(getDefaultRpcUrl());
  return new Contract(address, REGISTRY_ABI, provider);
}

/** Get a writable contract instance (requires signer) */
function getWritableContract(signer: Signer, chainId: number): Contract | null {
  const address = getRegistryAddress(chainId);
  if (!address) return null;
  return new Contract(address, REGISTRY_ABI, signer);
}

/** Check if a content hash is verified (registered and not revoked) */
export async function verifyHash(contentHash: string): Promise<VerificationResult> {
  const contract = getReadOnlyContract();
  if (!contract) throw new Error("Registry contract not configured");

  const bytes32Hash = toBytes32(contentHash);

  const [isVerified, regTuple] = await Promise.all([
    contract.isVerified(bytes32Hash) as Promise<boolean>,
    contract.getRegistration(bytes32Hash) as Promise<[string, string, string, string, string, bigint, boolean]>,
  ]);

  const [owner, projectName, platform, ensName, repoUrl, registeredAt, revoked] = regTuple;

  // If owner is zero address, hash was never registered
  if (owner === "0x0000000000000000000000000000000000000000") {
    return { verified: false, registration: null };
  }

  return {
    verified: isVerified,
    registration: {
      owner,
      projectName,
      platform,
      ensName,
      repoUrl,
      registeredAt: Number(registeredAt),
      revoked,
    },
  };
}

/** Register a content hash on-chain */
export async function registerHash(
  signer: Signer,
  chainId: number,
  contentHash: string,
  projectName: string,
  platform: string,
  ensName: string,
  repoUrl: string,
): Promise<string> {
  const contract = getWritableContract(signer, chainId);
  if (!contract) throw new Error("Registry contract not configured for this chain");

  const bytes32Hash = toBytes32(contentHash);
  const tx = await contract.register(bytes32Hash, projectName, platform, ensName, repoUrl);
  const receipt = await tx.wait();
  return receipt.hash;
}

/** Update metadata for a registered hash */
export async function updateHash(
  signer: Signer,
  chainId: number,
  contentHash: string,
  projectName: string,
  platform: string,
  ensName: string,
  repoUrl: string,
): Promise<string> {
  const contract = getWritableContract(signer, chainId);
  if (!contract) throw new Error("Registry contract not configured for this chain");

  const bytes32Hash = toBytes32(contentHash);
  const tx = await contract.update(bytes32Hash, projectName, platform, ensName, repoUrl);
  const receipt = await tx.wait();
  return receipt.hash;
}

/** Revoke a registration */
export async function revokeHash(
  signer: Signer,
  chainId: number,
  contentHash: string,
): Promise<string> {
  const contract = getWritableContract(signer, chainId);
  if (!contract) throw new Error("Registry contract not configured for this chain");

  const bytes32Hash = toBytes32(contentHash);
  const tx = await contract.revoke(bytes32Hash);
  const receipt = await tx.wait();
  return receipt.hash;
}

/** Get all hashes registered by an address */
export async function getOwnerHashes(owner: string): Promise<string[]> {
  const contract = getReadOnlyContract();
  if (!contract) throw new Error("Registry contract not configured");

  const hashes: string[] = await contract.getOwnerHashes(owner);
  return hashes;
}

/** Get total registration count */
export async function getRegistrationCount(): Promise<number> {
  const contract = getReadOnlyContract();
  if (!contract) throw new Error("Registry contract not configured");

  const count: bigint = await contract.registrationCount();
  return Number(count);
}

/** Query HashRegistered events for browsing (paginated by block range) */
export async function queryRegistrations(
  fromBlock: number = 0,
  toBlock: number | string = "latest",
): Promise<Array<{ contentHash: string; owner: string; projectName: string; platform: string; blockNumber: number }>> {
  const contract = getReadOnlyContract();
  if (!contract) throw new Error("Registry contract not configured");

  const filter = contract.filters.HashRegistered();
  const events = await contract.queryFilter(filter, fromBlock, toBlock);

  return events.map(event => {
    const args = (event as unknown as { args: [string, string, string, string] }).args;
    return {
      contentHash: args[0],
      owner: args[1],
      projectName: args[2],
      platform: args[3],
      blockNumber: event.blockNumber,
    };
  });
}
