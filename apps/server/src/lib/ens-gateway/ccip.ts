/**
 * EIP-3668 CCIP-Read gateway logic for `*.woco.eth` — pure, no Hono, no env.
 *
 * Durin's `L1Resolver` (contracts/src/durin/L1Resolver.sol) reverts
 * `OffchainLookup` pointing at this gateway, then accepts whatever comes back
 * as long as `SignatureVerifier.verify` recovers the address in `signer()`.
 * There is no second opinion: a signature from this key over ANY `result` is
 * authoritative resolution for ANY name under the parent. So every refusal
 * below is a security guard, not input hygiene — the invariant is that nothing
 * is signed until the request has been proved to be about a name this gateway
 * is actually allowed to answer for, and the answer has come from the pinned L2
 * registry rather than from the request.
 */
import {
  AbiCoder,
  FunctionFragment,
  Interface,
  SigningKey,
  concat,
  getAddress,
  getBytes,
  keccak256,
  namehash,
  toBeHex,
} from "ethers";

// ---------------------------------------------------------------------------
// ABI surface
// ---------------------------------------------------------------------------

/**
 * The outer call the L1 resolver stuffs into `OffchainLookup.callData`
 * (L1Resolver.sol:231-237). Only the argument types matter for the selector;
 * the real interface returns `(bytes,uint64,bytes)`.
 */
const STUFFED_ABI = [
  "function stuffedResolveCall(bytes name, bytes data, uint64 targetChainId, address targetRegistryAddress) view returns (bytes)",
];
const STUFFED_INTERFACE = new Interface(STUFFED_ABI);
export const STUFFED_SELECTOR = STUFFED_INTERFACE.getFunction("stuffedResolveCall")!.selector;

/**
 * The record reads this gateway is willing to answer. Anything else — including
 * `resolve(bytes,bytes)` itself, which would let a caller nest a second layer,
 * and `name(bytes32)`/`ownerOf(uint256)`, which are registry surface rather than
 * resolver records — is refused before the L2 is touched.
 *
 * Every fragment here takes `bytes32 node` as its FIRST argument. `decodeInnerNode`
 * depends on that: the node is the first head word, and it is what gets checked
 * against `namehash(name)`.
 */
const INNER_ABI = [
  "function addr(bytes32 node) view returns (address)",
  "function addr(bytes32 node, uint256 coinType) view returns (bytes)",
  "function text(bytes32 node, string key) view returns (string)",
  "function contenthash(bytes32 node) view returns (bytes)",
  "function ABI(bytes32 node, uint256 contentTypes) view returns (uint256, bytes)",
];

/** Selectors are DERIVED from the fragments, never hand-typed — a typo'd hex constant
 *  would either open the allowlist or silently close a supported record. */
export const INNER_SELECTOR_ALLOWLIST: ReadonlySet<string> = new Set(
  new Interface(INNER_ABI).fragments
    .filter((f): f is FunctionFragment => f.type === "function")
    .map((f) => f.selector.toLowerCase()),
);

// ---------------------------------------------------------------------------
// DNS wire-format names
// ---------------------------------------------------------------------------

const MAX_DNS_NAME_BYTES = 255;
const MAX_LABEL_BYTES = 63;

/**
 * Decode a DNS wire-format name (length-prefixed labels, 0x00 terminator).
 *
 * Strict on purpose. The decoded string is what the suffix check is run against,
 * so any leniency here is leniency about WHICH names this gateway will sign for.
 * A trailing-garbage tolerance in particular would let two different encodings
 * decode to the same name while hashing differently as `request`.
 */
export function dnsDecodeName(bytes: Uint8Array): string {
  if (bytes.length === 0) throw new Error("dns name: empty input");
  if (bytes.length > MAX_DNS_NAME_BYTES) {
    throw new Error(`dns name: ${bytes.length} bytes exceeds the ${MAX_DNS_NAME_BYTES}-byte limit`);
  }

  const labels: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let offset = 0;

  for (;;) {
    if (offset >= bytes.length) throw new Error("dns name: missing 0x00 terminator");
    const len = bytes[offset];
    if (len === 0) break;
    if (len > MAX_LABEL_BYTES) {
      throw new Error(`dns name: label of ${len} bytes exceeds the ${MAX_LABEL_BYTES}-byte limit`);
    }
    const end = offset + 1 + len;
    if (end > bytes.length) throw new Error("dns name: label length overruns the buffer");
    labels.push(decoder.decode(bytes.subarray(offset + 1, end)));
    offset = end;
  }

  if (offset !== bytes.length - 1) throw new Error("dns name: trailing bytes after terminator");
  if (labels.length === 0) throw new Error("dns name: empty label");

  return labels.join(".");
}

// ---------------------------------------------------------------------------
// Calldata decoding
// ---------------------------------------------------------------------------

export interface StuffedResolveCall {
  name: Uint8Array;
  data: string;
  targetChainId: bigint;
  targetRegistryAddress: string;
}

export function decodeStuffedResolveCall(calldata: string): StuffedResolveCall {
  if (calldata.slice(0, 10).toLowerCase() !== STUFFED_SELECTOR) {
    throw new Error(`unexpected selector ${calldata.slice(0, 10)} — expected stuffedResolveCall`);
  }
  const args = STUFFED_INTERFACE.decodeFunctionData("stuffedResolveCall", calldata);
  return {
    name: getBytes(args[0] as string),
    data: args[1] as string,
    targetChainId: args[2] as bigint,
    targetRegistryAddress: args[3] as string,
  };
}

/**
 * The `bytes32 node` the inner record read is about.
 *
 * The allowlist is the ONLY gate here, deliberately: the node is read as the
 * first head word rather than by re-decoding the fragment, so that removing the
 * allowlist check actually changes behaviour (a `name(bytes32)` carrying the
 * right node would sail through) instead of being silently caught a second time
 * by an ABI lookup. A malformed tail on an allowed selector is not a forgery
 * risk — it reverts at the L2 and comes back as a 502, unsigned.
 */
export function decodeInnerNode(data: string): string {
  const selector = data.slice(0, 10).toLowerCase();
  if (!INNER_SELECTOR_ALLOWLIST.has(selector)) {
    throw new Error(`inner selector ${selector} is not served by this gateway`);
  }
  if (data.length < 74) throw new Error("inner call truncated: no node word");
  return `0x${data.slice(10, 74).toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Byte-exact mirror of `SignatureVerifier.makeSignatureHash`
 * (contracts/src/durin/lib/SignatureVerifier.sol:13-29):
 *
 *   keccak256(abi.encodePacked(hex"1900", target, expires, keccak256(request), keccak256(result)))
 *
 * `target` is the L1 resolver (`address(this)` at verify time), NOT this gateway.
 */
export function makeSignatureHash(
  target: string,
  expires: bigint,
  request: Uint8Array | string,
  result: string,
): string {
  return keccak256(
    concat([
      "0x1900",
      getAddress(target), // 20 bytes
      toBeHex(expires, 8), // uint64, big-endian
      keccak256(request),
      keccak256(result),
    ]),
  );
}

/** `abi.encode(bytes result, uint64 expires, bytes sig)` — what `SignatureVerifier.verify` decodes. */
export function encodeGatewayResponse(result: string, expires: bigint, sig: string): string {
  return AbiCoder.defaultAbiCoder().encode(["bytes", "uint64", "bytes"], [result, expires, sig]);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface CcipHandlerConfig {
  signerPrivateKey: string;
  /** Lowercased L1Resolver addresses whose `OffchainLookup` this gateway answers. */
  allowedSenders: string[];
  chainId: number;
  registryAddress: string;
  /** Lowercased 2LD, e.g. "woco.eth". Only names strictly BELOW it are served. */
  parentName: string;
  ttlSeconds: number;
}

export type ReadL2 = (registry: string, name: Uint8Array, data: string) => Promise<string>;

export interface CcipHandlerDeps {
  readL2: ReadL2;
  /** UNIX seconds. Injectable so tests can pin the expiry window. */
  now?: () => number;
}

export interface CcipResult {
  status: number;
  body: { data: string } | { message: string };
  /** Only a signed 200 may be cached; every refusal is `no-store`. */
  cacheable: boolean;
}

export type CcipHandler = (senderParam: string, dataParam: string) => Promise<CcipResult>;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
/** Generous for a record read, small enough that nothing pathological reaches the ABI decoder. */
const MAX_CALLDATA_CHARS = 8192;

const refuse = (status: number, message: string): CcipResult => ({
  status,
  body: { message },
  cacheable: false,
});

export function createCcipHandler(config: CcipHandlerConfig, deps: CcipHandlerDeps): CcipHandler {
  const signingKey = new SigningKey(config.signerPrivateKey);
  const parent = config.parentName.toLowerCase();
  const allowedSenders = new Set(config.allowedSenders.map((s) => s.toLowerCase()));
  const registry = config.registryAddress.toLowerCase();
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  return async (senderParam, dataParam) => {
    // 1. Shape.
    if (!ADDRESS_RE.test(senderParam)) return refuse(400, "sender is not an address");
    if (!HEX_RE.test(dataParam)) return refuse(400, "data is not even-length hex");
    if (dataParam.length > MAX_CALLDATA_CHARS) return refuse(400, "data is too long");

    // 2. Which L1 resolver is asking. The signature is bound to `target == sender`,
    //    so an unpinned sender means signing a resolution usable by a resolver we
    //    do not control — i.e. handing someone else our signer.
    if (!allowedSenders.has(senderParam.toLowerCase())) {
      return refuse(403, "sender not served");
    }

    // 3. Outer calldata.
    let call: StuffedResolveCall;
    try {
      call = decodeStuffedResolveCall(dataParam);
    } catch (err) {
      return refuse(400, `could not decode stuffedResolveCall: ${(err as Error).message}`);
    }

    // 4. Where the answer must come from. Both come from the REQUEST, so both are
    //    attacker-chosen until pinned: without this an attacker names their own
    //    contract on their own chain and this gateway signs whatever it returns.
    if (call.targetChainId !== BigInt(config.chainId)) return refuse(403, "registry not served");
    if (call.targetRegistryAddress.toLowerCase() !== registry) {
      return refuse(403, "registry not served");
    }

    // 5. Which name.
    let name: string;
    try {
      name = dnsDecodeName(call.name);
    } catch (err) {
      return refuse(400, `could not decode name: ${(err as Error).message}`);
    }
    const lower = name.toLowerCase();
    // The apex belongs to the L1 registry's own records, not to the L2 registry
    // this gateway reads. Given its own message so the refusal is legible in logs.
    if (lower === parent) return refuse(403, "apex is not served by this gateway");
    // Leading dot is load-bearing: `xwoco.eth` and `woco.eth.evil.eth` must both fail.
    if (!lower.endsWith(`.${parent}`)) return refuse(403, `only names under ${parent} are served`);

    // 6. Which record, and that the node the L2 will read really is this name's.
    //    Without the equality check the name is decorative: the L2 answers about
    //    `node`, so an attacker passes a served name and any node they like.
    let node: string;
    try {
      node = decodeInnerNode(call.data);
    } catch (err) {
      return refuse(400, (err as Error).message);
    }
    let expectedNode: string;
    try {
      expectedNode = namehash(name).toLowerCase();
    } catch (err) {
      return refuse(400, `could not namehash ${name}: ${(err as Error).message}`);
    }
    if (node !== expectedNode) return refuse(400, "node does not match name");

    // 7. Read the pinned L2 registry. A failure is NOT an empty answer — signing
    //    "0x" over an RPC blip is a signed assertion that the record is unset.
    let result: string;
    try {
      result = await deps.readL2(call.targetRegistryAddress, call.name, call.data);
    } catch (err) {
      console.error(`[ens-gateway] L2 read failed for ${name}:`, err);
      return refuse(502, "could not read the L2 registry");
    }

    // 8. Sign. `request` is the RAW calldata bytes from the URL, because the L1
    //    resolver passes `callData` as `extraData` (L1Resolver.sol:242-248) and
    //    the verifier hashes `extraData` as `request` (L1Resolver.sol:186-189).
    const expires = BigInt(now() + config.ttlSeconds);
    const hash = makeSignatureHash(senderParam, expires, getBytes(dataParam), result);
    const sig = signingKey.sign(hash).serialized;

    return {
      status: 200,
      body: { data: encodeGatewayResponse(result, expires, sig) },
      cacheable: true,
    };
  };
}
