/**
 * ContentHashRegistry ABI — only the functions we need on the frontend.
 * Generated from contracts/src/ContentHashRegistry.sol
 */
export const REGISTRY_ABI = [
  // Write functions
  "function register(bytes32 contentHash, string projectName, string platform, string ensName, string repoUrl)",
  "function update(bytes32 contentHash, string projectName, string platform, string ensName, string repoUrl)",
  "function revoke(bytes32 contentHash)",

  // View functions
  "function isVerified(bytes32 contentHash) view returns (bool)",
  "function getRegistration(bytes32 contentHash) view returns (address owner, string projectName, string platform, string ensName, string repoUrl, uint256 registeredAt, bool revoked)",
  "function getOwnerHashes(address owner) view returns (bytes32[])",
  "function getOwnerHashCount(address owner) view returns (uint256)",
  "function registrationCount() view returns (uint256)",

  // Events
  "event HashRegistered(bytes32 indexed contentHash, address indexed owner, string projectName, string platform)",
  "event HashUpdated(bytes32 indexed contentHash, address indexed owner)",
  "event HashRevoked(bytes32 indexed contentHash, address indexed owner)",
] as const;
