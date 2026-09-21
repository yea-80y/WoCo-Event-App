import {
  JsonRpcProvider, Contract, Wallet, keccak256, toUtf8Bytes, concat, namehash, hexlify,
} from "ethers";
import { SUB_ENS_DEFAULT_CHAIN_ID, getSubEnsDeployment, subEnsName } from "@woco/shared";
import { getChainRpcUrl } from "./event-contract.js";
import { sendSponsorTx } from "./sponsor-nonce.js";
import { warmSubEnsWebCertWhenResolvable } from "../sub-ens/cert-warmup.js";
import { publicContenthashQueryUrl } from "../ens-gateway/public-url.js";

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
  // #464 rename rail. `release` is the holder's (or, for a name beneath
  // another, that name's holder's) and never passes through the registrar, so
  // the server can only ever encode this calldata for the holder's own wallet
  // to send — it can never release a name itself.
  "function release(bytes32 node)",
  // Written by every release: the frozen layer keeps who let a name go and
  // when. Registrar v2.1 reads it so a holder retaking their own released
  // label is not charged a mint.
  "function lastRelease(bytes32 node) view returns (address previousOwner, uint64 releasedAt)",
  "event Released(bytes32 indexed node, address indexed previousOwner, address indexed operator)",
  // #464 signature rail: the holder signs the EIP-712 `Release` whose digest is
  // `releaseDigest(node, expiration)` (registry v2.1; built and checked on the
  // client) and ANYONE may submit it. This is the one release path the sponsor
  // wallet can relay, and it can only relay what the holder signed: `signer`
  // must be the holder, checked on-chain before the signature is examined. The
  // digest carries the registry, chain, name, record version and deadline, so a
  // signature is single-use, and the registry refuses a deadline more than 48
  // hours ahead of the block.
  "function releaseWithSignature(bytes32 node, uint256 expiration, address signer, bytes signature)",
  "function releaseDigest(bytes32 node, uint256 expiration) view returns (bytes32)",
  // Registry custom errors, so a relay route can name the refusal instead of 500ing.
  // ERC721NonexistentToken is the one OpenZeppelin raises for a token that was
  // never minted or has been burned, and it is load-bearing here: ethers v6
  // decodes a custom error by NAME only when its fragment is in the ABI (same
  // reason as the REGISTRAR_ABI error block below). Without it the one revert
  // that means "unregistered" arrives indistinguishable from an RPC failure,
  // and an ownership read cannot tell absence from an outage.
  "error ERC721NonexistentToken(uint256 tokenId)",
  "error Unauthorized(bytes32 node)",
  "error SignatureExpired()",
  "error ReleaseBaseNode()",
  "error ReleaseUnregistered(bytes32 node)",
  // Registry v2.1: a name with names beneath it is not released until they are
  // gone, and a release signature may not expire more than 48 hours ahead.
  "error HasChildren(bytes32 node, uint256 count)",
  "error ExpirationTooFar()",
  // Registry v2.2 (audit 950). None is reachable from a call this server makes:
  // it never approves, never sends `createSubnode` a batch, never initialises.
  // Listed so that an unexpected one arrives NAMED rather than as bare revert
  // data. `approve` / `setApprovalForAll` always refuse; `multicall` is gone.
  "error DelegationNotSupported()",
  "error BatchNodeMismatch(bytes32 node)",
  "error NotDeployer(address caller)",
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
  // Sponsor mint: an EMPTY name — the name, its holder and the holder's own
  // address records. The registrar writes nothing a sponsor chooses (registrar
  // v2.2, Fable sponsor-key consult).
  "function register(string label, address owner) returns (bytes32 node)",
  // The ONE post-mint write, and the platform only relays it: the HOLDER signs
  // EIP-712 `SetContenthash` (domain "WoCo Registrar"/"1"), anyone submits.
  // The sponsor-only `setContenthash(string,bytes)` is GONE — a sponsor key can
  // repoint no name. Do not re-add the fragment.
  "function setContenthashWithSignature(string label, bytes contenthash, uint256 expiration, bytes signature)",
  "function setContenthashDigest(bytes32 node, bytes contenthash, uint256 expiration) view returns (bytes32)",
  "function pointerNonce(bytes32 node) view returns (uint256)",
  // Registrar-wide mint cap (#469); /api/health watches its headroom.
  "function globalMintAllowance() view returns (uint32 remaining, uint64 windowResetsAt)",
  "function maxGlobalMintsPerWindow() view returns (uint32)",
  // #464 mint rate cap — per RECIPIENT, 30 mints / 30 days at deploy. Read it
  // before promising a mint: exceeding it reverts. `setMintRateCap` is
  // owner-only (the multisig on mainnet), here so the fragment exists, never
  // callable by the sponsor key.
  "function mintAllowance(address recipient) view returns (uint32 remaining, uint64 windowResetsAt)",
  "function setMintRateCap(uint32 max, uint64 windowSeconds)",
  // `registerWithPermit` is NOT here: the gasless mint rail that used it is
  // gone (#501), and registrar v2 removed the function. A fragment for a call
  // nothing makes is a call site waiting to be written by accident.
  // Custom errors — required for ethers v6 to decode reverts by name
  "error NotAuthorisedSponsor(address caller)",
  "error LabelIsReserved(string label)",
  "error InvalidLabel(string label)",
  "error EmptyContenthash()",
  "error MintRateCapExceeded(address recipient, uint64 windowResetsAt)",
  "error GlobalMintCapExceeded(uint64 windowResetsAt)",
  "error LabelNotRegistered(string label)",
  "error NotHolderSignature(bytes32 node)",
  "error SignatureExpired()",
  "error ExpirationTooFar()",
  "error NameMovedDuringRegistration(bytes32 node)",
  // The REGISTRY's refusal, bubbled through `register` / `setContenthash`
  // unchanged. With ownership checked first, it means this registrar is not
  // enrolled: registry v2.2 drops EVERY registrar when the admin seat changes
  // hands, until the new admin re-enrols it (audit 950 Medium 3; the
  // `subEns.minting` health alarm watches for exactly this).
  "error Unauthorized(bytes32 node)",
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

/**
 * The NAMES sponsor key: every sub-ENS transaction this server sends — mints,
 * relayed pointer writes, relayed releases — and nothing else. Deliberately
 * NOT `WOCO_SPONSOR_PRIVATE_KEY`, which pays for tickets and events (Fable
 * sponsor-key consult §4): two keys, two balances, two nonce queues
 * (`sendSponsorTx` keys its queue on the address), and a names burst can no
 * longer sit in front of ticket fulfilment. No fallback to the events key — a
 * soft split is no split; unset means names are unavailable, loudly.
 */
function subEnsSponsorKey(): string {
  const pk = process.env.SUB_ENS_SPONSOR_PRIVATE_KEY?.trim();
  if (!pk) throw new Error("SUB_ENS_SPONSOR_PRIVATE_KEY is not set");
  return pk;
}

export function getSubEnsSponsorAddress(): string {
  return new Wallet(subEnsSponsorKey()).address;
}

/**
 * Boot check: the names key and the events key must be different keys. The
 * whole point of the split is that one can be lost, rotated or drained
 * without the other; the same key under two names defeats it silently.
 * Returns the reason to refuse, or null.
 */
export function sponsorKeysConflict(env: NodeJS.ProcessEnv = process.env): string | null {
  const names = env.SUB_ENS_SPONSOR_PRIVATE_KEY?.trim();
  const events = env.WOCO_SPONSOR_PRIVATE_KEY?.trim();
  if (!names || !events) return null;
  try {
    if (new Wallet(names).address === new Wallet(events).address) {
      return "SUB_ENS_SPONSOR_PRIVATE_KEY must not be the same key as WOCO_SPONSOR_PRIVATE_KEY";
    }
  } catch {
    return "SUB_ENS_SPONSOR_PRIVATE_KEY or WOCO_SPONSOR_PRIVATE_KEY is not a valid private key";
  }
  return null;
}

function writeContract(chainId: number): Contract {
  return new Contract(getRegistrarAddress(chainId), REGISTRAR_ABI, new Wallet(subEnsSponsorKey(), getProvider(chainId)));
}

export async function isLabelAvailable(label: string): Promise<boolean> {
  return readContract(getSubEnsChainId()).available(label) as Promise<boolean>;
}

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
 * checks `signer` is the holder before it looks at the signature at all — so
 * the sponsor here is only paying the gas. It cannot
 * forge a release, and refusing to relay one never traps a holder, who can
 * always submit `release` themselves.
 *
 * Uses a REGISTRY-bound writer: `writeContract` binds the REGISTRAR ABI, and
 * `releaseWithSignature` lives on the registry.
 */
/**
 * The registry chain's clock: the latest block's timestamp, in seconds.
 *
 * What `releaseWithSignature` compares an expiration with is `block.timestamp`,
 * and Arbitrum's may run up to a day behind real time or an hour ahead of it.
 * Measured against the wall clock, a ten-minute signature could arrive already
 * expired, or be refused here as too far ahead when the chain would take it
 * (audit 950 Low 13). The client takes its expiration from the same clock.
 */
export async function getSubEnsChainTime(): Promise<number> {
  const block = await getProvider(getSubEnsChainId()).getBlock("latest");
  if (!block) throw new Error("no latest block from the sub-ENS RPC");
  return block.timestamp;
}

/**
 * The gas limit a relayed release or pointer write is sent with: the estimate
 * made just before submission, plus a fifth, plus a fixed allowance.
 *
 * Why pad at all (audit 950 Low 15): on Arbitrum the L1 data fee is taken out
 * of the transaction's gas before execution, and it moves with the L1 base fee
 * and how well the calldata compresses. A limit cut exactly to an estimate can
 * leave the ERC-6492 validator — which a smart-account holder's signature runs
 * through, with a budget of up to 1M gas — short, and the contract then
 * refuses a VALID signature (`Unauthorized` / `NotHolderSignature`),
 * indistinguishable on chain from a forged one. A limit is not a charge:
 * Arbitrum bills the gas used.
 */
export const RELAY_GAS_FIXED_PAD = 150_000n;
export function paddedRelayGasLimit(estimate: bigint): bigint {
  return estimate + estimate / 5n + RELAY_GAS_FIXED_PAD;
}

export async function relayReleaseWithSignature(
  node: string,
  expiration: number,
  signer: string,
  signature: string,
): Promise<{ txHash: string }> {
  const chainId = getSubEnsChainId();
  const provider = getProvider(chainId);
  const registry = new Contract(
    getRegistryAddress(chainId),
    REGISTRY_ABI,
    new Wallet(subEnsSponsorKey(), provider),
  );

  // SIMULATE FIRST, and outside the sponsor nonce queue. A reverting tx still
  // occupies that queue for several RPC round trips while it is populated,
  // estimated and signed — and the queue is shared with ticket fulfilment. A
  // refused release must never get that far.
  await registry.releaseWithSignature.staticCall(node, expiration, signer, signature);

  // Estimated INSIDE the queue, immediately before the send, and padded — see
  // `paddedRelayGasLimit`. The estimate ethers would otherwise make is the
  // same call at the same moment, with no margin.
  const tx = await sendSponsorTx(
    { chainId, address: getSubEnsSponsorAddress(), provider, label: "sub-ens.release" },
    async (o) => {
      const estimate = await registry.releaseWithSignature.estimateGas(node, expiration, signer, signature);
      return registry.releaseWithSignature(node, expiration, signer, signature, {
        ...o,
        gasLimit: paddedRelayGasLimit(estimate),
      });
    },
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
 * Read BEFORE promising a mint: without it the mint reverts after we have
 * already paid for gas estimation, and the organiser is told nothing useful
 * about why (#471).
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
): { error: "mint_rate_cap"; data: { windowResetsAt: number } } | null {
  if (!allowance) return null;
  if (allowance.remaining > 0) return null;
  // Spread into `{ ok: false, ... }` at the route, so the detail rides in `data`
  // rather than as a third top-level key — this was the one response in the
  // sub-ENS surface outside the `{ ok, data?, error? }` envelope.
  return { error: "mint_rate_cap", data: { windowResetsAt: allowance.windowResetsAt } };
}

/** The registrar-wide mint window as the chain reports it (registrar v2.2). */
export interface GlobalMintHeadroom extends MintAllowance {
  /** The cap the Safe has set for the window. */
  max: number;
}

/**
 * The share of each registrar-wide window this server never spends itself.
 * Two reasons (Fable sign-off F11): the product refuses gracefully before the
 * chain does, and - because the platform alone can never take the window
 * below this - a cap that DOES reach zero was spent by someone else, which
 * makes /api/health's `globalMint` alarm mean a leaked names key, not a busy
 * hour. A fraction of the LIVE cap rather than a number, so the Safe's retune
 * (raised for launch day, lowered after) moves it too.
 */
export const GLOBAL_MINT_RESERVE_FRACTION = 0.2;

/**
 * Turn a registrar-wide headroom read into a refusal, or null to proceed.
 * Null headroom means the READ FAILED, and proceeds for the same reason as
 * `mintRateCapVerdict`: the contract's own cap still binds.
 */
export function globalMintSoftVerdict(
  headroom: GlobalMintHeadroom | null,
): { error: "mint_global_cap"; data: { windowResetsAt: number } } | null {
  if (!headroom) return null;
  const reserve = Math.floor(headroom.max * GLOBAL_MINT_RESERVE_FRACTION);
  if (headroom.remaining > reserve) return null;
  return { error: "mint_global_cap", data: { windowResetsAt: headroom.windowResetsAt } };
}

export async function getGlobalMintHeadroom(): Promise<GlobalMintHeadroom> {
  const registrar = readContract(getSubEnsChainId());
  const [[remaining, windowResetsAt], max] = await Promise.all([
    registrar.globalMintAllowance() as Promise<[bigint, bigint]>,
    registrar.maxGlobalMintsPerWindow() as Promise<bigint>,
  ]);
  return { remaining: Number(remaining), windowResetsAt: Number(windowResetsAt), max: Number(max) };
}

export async function getMintAllowance(recipient: string): Promise<MintAllowance> {
  const [remaining, windowResetsAt] = await readContract(getSubEnsChainId())
    .mintAllowance(recipient) as [bigint, bigint];
  return { remaining: Number(remaining), windowResetsAt: Number(windowResetsAt) };
}

/**
 * Is this failure the registry saying "no such token", and nothing else?
 *
 * True ONLY for a decoded ERC721NonexistentToken revert. A CALL_EXCEPTION whose
 * `revert` is null is deliberately FALSE: that is what a provider returns when
 * it stripped the revert data, or when there is no code at the address we are
 * calling — and an undecodable revert is not proof of absence. Treating it as
 * absence is exactly how an outage came to read as "you do not own this name".
 */
export function isNonexistentTokenRevert(err: unknown): boolean {
  const e = err as { code?: unknown; revert?: { name?: unknown } | null } | null | undefined;
  return e?.code === "CALL_EXCEPTION" && e?.revert?.name === "ERC721NonexistentToken";
}

/**
 * Runs an ownerOf-shaped read and converts ONLY the nonexistent-token revert
 * into null. Every other failure — timeout, 429, connection reset, an
 * undecodable revert — propagates, because the caller must be able to answer
 * "unverified" rather than "not yours".
 */
export async function ownerOrNull(read: () => Promise<string>): Promise<string | null> {
  try {
    return (await read()).toLowerCase();
  } catch (err) {
    if (isNonexistentTokenRevert(err)) return null;
    throw err;
  }
}

/**
 * The current on-chain owner of label.woco.eth (lowercased). Used to authorise
 * mutation calls — the caller's parentAddress must match before the sponsor
 * wallet fires any tx.
 *
 * `null` is DEFINITIVE: the chain answered, and the label is not registered.
 * Anything else THROWS, and the caller owes the user "we could not check",
 * never "not yours" — a swallowed RPC failure hands a real holder a 404/403 on
 * their own name, and hands a site deploy a "not_owner" that never happened.
 */
export async function getLabelOwner(label: string): Promise<string | null> {
  const chainId = getSubEnsChainId();
  const registry = new Contract(getRegistryAddress(chainId), REGISTRY_ABI, getProvider(chainId));
  return ownerOrNull(() => registry.ownerOf(computeLabelNode(label)) as Promise<string>);
}

/**
 * The raw contenthash record for a label, or null when UNSET. Throws when the
 * chain did not answer: "unreadable" is not "empty", and both callers decide
 * whether to ask the holder to sign a pointer on this answer — a read fault
 * read as "unset" would prompt them to overwrite a pointer they chose.
 */
export async function getLabelContenthash(label: string): Promise<string | null> {
  const chainId = getSubEnsChainId();
  const registry = new Contract(getRegistryAddress(chainId), REGISTRY_ABI, getProvider(chainId));
  const node = "0x" + computeLabelNode(label).toString(16).padStart(64, "0");
  const raw = await registry.contenthash(node) as string;
  return raw && raw !== "0x" ? raw : null;
}

export interface OwnedLabel {
  label: string;
  /** 64-hex Swarm hash the name currently points at, or null if unset / non-Swarm. */
  contentHash: string | null;
}

/**
 * Enumerates every label.woco.eth currently owned by `address`, authoritatively
 * from chain — including names minted before this server existed, or moved to
 * the address by a transfer.
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

  // Deduped and confirmed against `ownerOf`, so a self-transfer - which v2.1
  // permits and which changes nothing - is inert here. Never infer a records
  // reset from `Transfer`; only `VersionChanged` means that.
  const logs = await registry.queryFilter(registry.filters.Transfer!(null, address));
  const tokenIds = [...new Set(logs.map((l) => (l as unknown as { args: { tokenId: bigint } }).args.tokenId.toString()))];

  const out: OwnedLabel[] = [];
  for (const tid of tokenIds) {
    const node = "0x" + BigInt(tid).toString(16).padStart(64, "0");
    let owner: string;
    // A released/burned name IS nonexistent, so skipping it is right; anything
    // else would drop a name the caller does own out of their own list.
    try {
      owner = (await registry.ownerOf(tid) as string).toLowerCase();
    } catch (err) {
      if (isNonexistentTokenRevert(err)) continue;
      throw err;
    }
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

/**
 * Mint an EMPTY name to `ownerAddress`: the registrar writes the name, its
 * holder and the holder's own address records, nothing else. What the name
 * points at is the holder's to sign (`relaySignedContenthash`).
 */
export async function mintSubEnsName(label: string, ownerAddress: string): Promise<string> {
  const chainId = getSubEnsChainId();

  console.log(`[sub-ens] register label=${label} owner=${ownerAddress} chain=${chainId}`);
  const contract = writeContract(chainId);
  const tx = await sendSponsorTx(
    { chainId, address: getSubEnsSponsorAddress(), provider: getProvider(chainId), label: "sub-ens.register" },
    (o) => contract.register(label, ownerAddress, o),
  );
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error("No receipt from register tx");
  console.log(`[sub-ens] registered label=${label} txHash=${receipt.hash} gasUsed=${receipt.gasUsed}`);
  return receipt.hash as string;
}

/**
 * Relay a pointer write the HOLDER signed. The signature is the authority: the
 * registrar checks it against the name's current holder, and the sponsor only
 * pays — it can refuse to relay, never forge. A holder can always write its
 * own record at the registry instead.
 *
 * The same shape as `relayReleaseWithSignature`: simulate OUTSIDE the shared
 * sponsor queue, estimate inside it immediately before the send, and pad the
 * limit, because a smart-account holder's signature runs through the ERC-6492
 * validator and a limit cut to the estimate can starve it (audit 950 Low 15).
 */
export async function relaySignedContenthash(
  label: string,
  swarmHash: string,
  expiration: number,
  signature: string,
): Promise<string> {
  const chainId = getSubEnsChainId();
  const contenthash = encodeSwarmContenthash(swarmHash);
  const contract = writeContract(chainId);

  await contract.setContenthashWithSignature.staticCall(label, contenthash, expiration, signature);

  const tx = await sendSponsorTx(
    { chainId, address: getSubEnsSponsorAddress(), provider: getProvider(chainId), label: "sub-ens.setContenthash" },
    async (o) => {
      const estimate = await contract.setContenthashWithSignature.estimateGas(label, contenthash, expiration, signature);
      return contract.setContenthashWithSignature(label, contenthash, expiration, signature, {
        ...o,
        gasLimit: paddedRelayGasLimit(estimate),
      });
    },
  );
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error("No receipt from setContenthashWithSignature tx");
  // No signature in the log: it is a bearer authorisation until mined.
  console.log(`[sub-ens] pointer relayed label=${label} hash=${swarmHash.slice(0, 10)}… txHash=${receipt.hash}`);
  // Fire-and-forget: the receipt is the fact callers wait for; the warm-up is a
  // courtesy, and it waits until eth.limo can resolve the new pointer (#557).
  void warmSubEnsWebCertWhenResolvable(
    label,
    { contenthash: hexlify(contenthash), swarmHash },
    publicContenthashQueryUrl(subEnsName(label), chainId, getRegistryAddress(chainId)),
  );
  return receipt.hash as string;
}
