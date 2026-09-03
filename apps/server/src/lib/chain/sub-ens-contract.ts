import {
  JsonRpcProvider, Contract, Wallet, keccak256, toUtf8Bytes, concat, namehash,
  AbiCoder, solidityPackedKeccak256, getBytes,
} from "ethers";
import { SUB_ENS_DEFAULT_CHAIN_ID, getSubEnsDeployment } from "@woco/shared";
import { getChainRpcUrl } from "./event-contract.js";
import { sendSponsorTx } from "./sponsor-nonce.js";
import { getSponsorAddress } from "./sponsor-wallet.js";

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
  // #464 rename rail. `release` is holder-or-approvee only and never passes
  // through the registrar, so the server can only ever encode this calldata for
  // the holder's own wallet to send — it can never release a name itself.
  "function release(bytes32 node)",
  // Written by every release and read by nothing on-chain: the frozen layer
  // keeps who let a name go and when, so a future registrar can enforce a
  // re-mint hold that `release` would otherwise have made impossible.
  "function lastRelease(bytes32 node) view returns (address previousOwner, uint64 releasedAt)",
  "event Released(bytes32 indexed node, address indexed previousOwner, address indexed operator)",
  // #464 signature rail (2026-09-03): the holder signs `releaseDigest(node, expiration)`
  // — read from the chain, never re-derived here — and ANYONE may submit it. This is
  // the one release path the sponsor wallet can relay, and it can only relay what
  // the holder signed: `signer` must be the holder or an ERC-721 approvee, checked
  // on-chain before the signature is examined. The digest carries the registry,
  // chain, node, record version and deadline, so a signature is single-use.
  "function releaseWithSignature(bytes32 node, uint256 expiration, address signer, bytes signature)",
  "function releaseDigest(bytes32 node, uint256 expiration) view returns (bytes32)",
  "function RELEASE_TYPEHASH() view returns (bytes32)",
  // Registry custom errors, so a relay route can name the refusal instead of 500ing.
  "error Unauthorized(bytes32 node)",
  "error SignatureExpired()",
  "error ReleaseBaseNode()",
  "error ReleaseUnregistered(bytes32 node)",
];

// Addresses live in `@woco/shared` (#472) so the client cannot drift from them.
// Env still overrides, per address, for a redeploy that lands before a release.
export function getSubEnsChainId(): number {
  return parseInt(process.env.SUB_ENS_CHAIN_ID ?? String(SUB_ENS_DEFAULT_CHAIN_ID));
}

/**
 * An env override wins over the shared map — but an EMPTY override is a
 * misconfiguration, not "unset". A bare `SUB_ENS_REGISTRAR_ADDRESS=` reaches
 * the process as `""` from both dotenv and a Docker `env_file`, and `??` keeps
 * it, which would hand an empty address to a contract call. Refusing is also
 * why `.env.example` declares these keys COMMENTED rather than bare: falling
 * back to the built-in default here would mask the misconfiguration on the one
 * path where the operator explicitly asked for something else.
 */
function resolveOverride(raw: string | undefined, name: string, fallback: () => string): string {
  if (raw === undefined) return fallback();
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`${name} is set but empty — unset it to use the built-in default`);
  return trimmed;
}

export function getRegistrarAddress(chainId: number): string {
  return resolveOverride(
    process.env.SUB_ENS_REGISTRAR_ADDRESS,
    "SUB_ENS_REGISTRAR_ADDRESS",
    () => getSubEnsDeployment(chainId).registrar,
  );
}

export function getRegistryAddress(chainId: number): string {
  return resolveOverride(
    process.env.SUB_ENS_REGISTRY_ADDRESS,
    "SUB_ENS_REGISTRY_ADDRESS",
    () => getSubEnsDeployment(chainId).registry,
  );
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
  // setContenthash is the ONLY post-mint record write the platform retains.
  // `setText(string,string,string)` was REMOVED from WoCoRegistrar (#422) — it
  // was never called from here, so it was standing authority over holders'
  // profile records with no operational benefit. Do not re-add the fragment.
  "function setContenthash(string label, bytes contenthash)",
  // #464 mint rate cap — per RECIPIENT, 30 mints / 30 days at deploy. Read it
  // before promising a mint: exceeding it reverts, on the sponsor path and the
  // permit path alike. `setMintRateCap` is owner-only (the multisig on mainnet),
  // here so the fragment exists, never callable by the sponsor key.
  "function mintAllowance(address recipient) view returns (uint32 remaining, uint64 windowResetsAt)",
  "function setMintRateCap(uint32 max, uint64 windowSeconds)",
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
  "error MintRateCapExceeded(address recipient, uint64 windowResetsAt)",
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
/**
 * The 32-byte node for `label`, as hex.
 *
 * Exported so the release relay derives the node it submits from a VALIDATED
 * label rather than accepting one in the request body — a body-supplied node
 * would let a caller aim a signature at a name the ownership check never saw.
 */
export function labelNode(label: string): string {
  return "0x" + computeLabelNode(label).toString(16).padStart(64, "0");
}

/**
 * Submit a holder-signed release. The SIGNATURE is the authority — the contract
 * checks `signer` is the holder or an ERC-721 approvee before it looks at the
 * signature at all — so the sponsor here is only paying the gas. It cannot
 * forge a release, and refusing to relay one never traps a holder, who can
 * always submit `release` themselves.
 *
 * Uses a REGISTRY-bound writer: `writeContract` binds the REGISTRAR ABI, and
 * `releaseWithSignature` lives on the registry.
 */
export async function relayReleaseWithSignature(
  node: string,
  expiration: number,
  signer: string,
  signature: string,
): Promise<{ txHash: string }> {
  const chainId = getSubEnsChainId();
  const pk = process.env.WOCO_SPONSOR_PRIVATE_KEY;
  if (!pk) throw new Error("WOCO_SPONSOR_PRIVATE_KEY is not set");
  const provider = getProvider(chainId);
  const registry = new Contract(
    getRegistryAddress(chainId),
    REGISTRY_ABI,
    new Wallet(pk, provider),
  );

  // SIMULATE FIRST, and outside the sponsor nonce queue. A reverting tx still
  // occupies that queue for several RPC round trips while it is populated,
  // estimated and signed — and the queue is shared with ticket fulfilment. A
  // refused release must never get that far.
  await registry.releaseWithSignature.staticCall(node, expiration, signer, signature);

  const tx = await sendSponsorTx(
    { chainId, address: getSponsorAddress(), provider, label: "sub-ens.release" },
    (o) => registry.releaseWithSignature(node, expiration, signer, signature, o),
  );
  // Awaited OUTSIDE sendSponsorTx, like the mint: holding the nonce lock across
  // a block confirmation would serialise every sponsor tx behind this one.
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error("No receipt from releaseWithSignature tx");
  // Deliberately no signature in the log line — it is a bearer authorisation
  // for a burn until it is mined or the record version moves.
  console.log(`[sub-ens] released node=${node.slice(0, 10)}… txHash=${receipt.hash}`);
  return { txHash: receipt.hash as string };
}

export interface MintAllowance {
  /** Mints this recipient may still make in the current window. */
  remaining: number;
  /** Unix seconds at which the window resets. */
  windowResetsAt: number;
}

/**
 * How many more names `recipient` may mint before the registrar's per-recipient
 * rate cap (#464, 30 per 30 days at deploy) refuses.
 *
 * Read BEFORE promising a mint on either rail. The sponsor rail would otherwise
 * revert after we have paid for gas estimation, and the permit rail is worse:
 * the server signs a permit the organiser's wallet then submits and watches
 * revert, which the client reads as an account-abstraction failure and quietly
 * retries on the sponsor path — where it reverts again (#471).
 */
/**
 * Turn a mint-allowance read into a refusal, or null to proceed.
 *
 * `null` allowance means the READ FAILED, and that is deliberately NOT a
 * refusal: the cap is an abuse brake, not a security boundary, and the contract
 * enforces it regardless of what we managed to read. Blocking every mint
 * because an RPC blipped would be a worse outage than the one this prevents.
 *
 * Pure, so the fail-open direction is testable without a chain.
 */
export function mintRateCapVerdict(
  allowance: MintAllowance | null,
): { error: "mint_rate_cap"; windowResetsAt: number } | null {
  if (!allowance) return null;
  if (allowance.remaining > 0) return null;
  return { error: "mint_rate_cap", windowResetsAt: allowance.windowResetsAt };
}

export async function getMintAllowance(recipient: string): Promise<MintAllowance> {
  const [remaining, windowResetsAt] = await readContract(getSubEnsChainId())
    .mintAllowance(recipient) as [bigint, bigint];
  return { remaining: Number(remaining), windowResetsAt: Number(windowResetsAt) };
}

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

/**
 * The raw contenthash record for a label, or null when unset / unreadable.
 *
 * Used at the profile bind to WARN — never to refuse — when the name being
 * adopted as an identity currently points at a site: the pointer keeps working
 * and the binding points protect it from then on, but the user should know the
 * name they are making their identity is already a live URL.
 */
export async function getLabelContenthash(label: string): Promise<string | null> {
  const chainId = getSubEnsChainId();
  const registry = new Contract(getRegistryAddress(chainId), REGISTRY_ABI, getProvider(chainId));
  const node = "0x" + computeLabelNode(label).toString(16).padStart(64, "0");
  try {
    const raw = await registry.contenthash(node) as string;
    return raw && raw !== "0x" ? raw : null;
  } catch {
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
