/**
 * Boot configuration for the ENS CCIP-Read gateway.
 *
 * Every failure here resolves to `{ disabled }` rather than a throw: a
 * misconfigured gateway must answer 503 to every query, not boot half-armed and
 * sign with whatever it could scrape together. The signing key can forge
 * resolution for every organiser name under the parent, so "not configured" is
 * the only safe default.
 */
import { SigningKey, Wallet, computeAddress } from "ethers";
import { getSubEnsChainId, getRegistryAddress } from "../chain/sub-ens-contract.js";
import { getChainRpcUrl } from "../chain/event-contract.js";
import type { CcipHandlerConfig } from "./ccip.js";

export type EnsGatewayConfig = CcipHandlerConfig & {
  /**
   * One or two endpoints for `chainId`. Two enables the #465 cross-check.
   * SECRET-BEARING — provider URLs routinely carry the API key in the path or
   * query, so these must never reach a log line or /api/health unredacted.
   */
  rpcUrls: string[];
};

export type EnsGatewayLoad = EnsGatewayConfig | { disabled: string };

export const DEFAULT_PARENT_NAME = "woco.eth";
export const DEFAULT_TTL_SECONDS = 600;
export const MIN_TTL_SECONDS = 60;
export const MAX_TTL_SECONDS = 3600;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

type Env = Record<string, string | undefined>;

function addressOf(privateKey: string): string | null {
  try {
    return computeAddress(new SigningKey(privateKey)).toLowerCase();
  } catch {
    return null;
  }
}

export function loadEnsGatewayConfig(env: Env = process.env): EnsGatewayLoad {
  const signerPrivateKey = env.ENS_GATEWAY_SIGNER_PRIVATE_KEY?.trim();
  if (!signerPrivateKey) return { disabled: "ENS_GATEWAY_SIGNER_PRIVATE_KEY is not set" };

  const signer = addressOf(signerPrivateKey);
  if (!signer) return { disabled: "ENS_GATEWAY_SIGNER_PRIVATE_KEY is not a valid private key" };

  // OWNER RULE: the gateway signer is a NEW hot key, never a sponsor wallet —
  // neither the events key nor the names key. Sponsors hold funds and send
  // transactions; this key sits behind a public unauthenticated GET. Sharing
  // one would mean a gateway compromise also drains it and takes over what it
  // sends.
  for (const sponsorPk of [env.WOCO_SPONSOR_PRIVATE_KEY, env.SUB_ENS_SPONSOR_PRIVATE_KEY]) {
    const pk = sponsorPk?.trim();
    if (pk && addressOf(pk) === signer) {
      return { disabled: "gateway signer must not be a sponsor wallet" };
    }
  }

  // Pinning the L1Resolver addresses is what stops this gateway from signing a
  // resolution that some OTHER resolver — one whose `signer()` also points here,
  // or one an attacker deployed and pointed at this URL — would accept.
  //
  // Each entry is `0xADDRESS` (the v1 resolver: legacy signed format) or
  // `0xADDRESS:CHAINID` (L1Resolver v2, whose signed hash binds the chain it
  // lives on - `:1` on mainnet). During the v1 -> v2 swap both are listed.
  const raw = env.ENS_GATEWAY_RESOLVER_ADDRESSES?.trim();
  if (!raw) return { disabled: "ENS_GATEWAY_RESOLVER_ADDRESSES is not set" };
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.toLowerCase());
  if (entries.length === 0) return { disabled: "ENS_GATEWAY_RESOLVER_ADDRESSES is empty" };
  const allowedSenders: string[] = [];
  const senderChainIds: Record<string, number> = {};
  for (const entry of entries) {
    const [address, chain, ...rest] = entry.split(":");
    if (!ADDRESS_RE.test(address!) || rest.length > 0) {
      return { disabled: `ENS_GATEWAY_RESOLVER_ADDRESSES contains a non-address: ${entry}` };
    }
    // A sender listed twice could be listed in both formats; which one it
    // verifies is a property of its bytecode, so that is a misconfiguration.
    if (allowedSenders.includes(address!)) {
      return { disabled: `ENS_GATEWAY_RESOLVER_ADDRESSES lists ${address} more than once` };
    }
    if (chain !== undefined) {
      if (!/^[1-9][0-9]{0,15}$/.test(chain)) {
        return { disabled: `ENS_GATEWAY_RESOLVER_ADDRESSES has a bad chain id for ${address}: ${chain}` };
      }
      senderChainIds[address!] = Number(chain);
    }
    allowedSenders.push(address!);
  }

  const parentName = (env.ENS_GATEWAY_PARENT_NAME?.trim() || DEFAULT_PARENT_NAME).toLowerCase();
  if (!parentName.includes(".")) {
    return { disabled: `ENS_GATEWAY_PARENT_NAME is not a dotted name: ${parentName}` };
  }

  const ttlRaw = env.ENS_GATEWAY_TTL_SECONDS?.trim();
  const ttlSeconds = ttlRaw === undefined || ttlRaw === "" ? DEFAULT_TTL_SECONDS : Number(ttlRaw);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > MAX_TTL_SECONDS) {
    return {
      disabled: `ENS_GATEWAY_TTL_SECONDS must be an integer ${MIN_TTL_SECONDS}..${MAX_TTL_SECONDS} (got ${ttlRaw})`,
    };
  }

  // Chain + registry come from the sub-ENS module so the gateway can only ever
  // read the registry the platform actually mints into.
  let chainId: number;
  let registryAddress: string;
  try {
    chainId = getSubEnsChainId();
    registryAddress = getRegistryAddress(chainId);
  } catch (err) {
    return { disabled: `no L2 registry configured: ${(err as Error).message}` };
  }
  if (!Number.isInteger(chainId)) return { disabled: "SUB_ENS_CHAIN_ID is not an integer" };
  if (!ADDRESS_RE.test(registryAddress)) {
    return { disabled: `SUB_ENS_REGISTRY_ADDRESS is not an address: ${registryAddress}` };
  }

  // REGISTRY CUTOVER (WoCo-Contracts #21). Every lookup names ONE registry —
  // whatever the L1 resolver's `l2Registry[node]` holds at that moment — and
  // moving it is a single Safe transaction this process cannot observe. With a
  // single registry pinned, whichever of the L1 flip and the server redeploy
  // lands first blacks out every subname until the other does. So for that
  // window only, a second registry may be served: set this to the outgoing and
  // incoming pair, flip L1, then unset it.
  //
  // The minting registry must be in the set, so the variable can only ADD a
  // registry, never swap the platform's own out; and it names at most two,
  // because a cutover has exactly two sides. Set-but-empty is refused like the
  // SUB_ENS_* overrides: an empty value reaches the process from a bare
  // `KEY=` line and is a misconfiguration, not "unset".
  const registryAddresses = [registryAddress.toLowerCase()];
  const cutoverRaw = env.ENS_GATEWAY_REGISTRY_ADDRESSES;
  if (cutoverRaw !== undefined) {
    const listed = [
      ...new Set(
        cutoverRaw
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s.length > 0),
      ),
    ];
    if (listed.length === 0) {
      return { disabled: "ENS_GATEWAY_REGISTRY_ADDRESSES is set but empty — unset it outside a registry cutover" };
    }
    const badRegistry = listed.find((s) => !ADDRESS_RE.test(s));
    if (badRegistry) {
      return { disabled: `ENS_GATEWAY_REGISTRY_ADDRESSES contains a non-address: ${badRegistry}` };
    }
    if (!listed.includes(registryAddresses[0]!)) {
      return { disabled: "ENS_GATEWAY_REGISTRY_ADDRESSES must include SUB_ENS_REGISTRY_ADDRESS" };
    }
    if (listed.length > 2) {
      return { disabled: "ENS_GATEWAY_REGISTRY_ADDRESSES names more than two registries — a cutover has two sides" };
    }
    registryAddresses.push(...listed.filter((s) => s !== registryAddresses[0]));
  }

  // The second endpoint is OPTIONAL: without it the gateway keeps its pre-#465
  // single-provider posture rather than refusing to boot, because a hard
  // requirement here would block the Sepolia rehearsal for a hardening step
  // that explicitly does not gate it. What is NOT optional is that the operator
  // can see which posture is in force — hence `crossCheck` on /api/health.
  // `env` first so the loader stays injectable end-to-end; in production `env`
  // IS process.env and getChainRpcUrl consults the same name, so this is the
  // identical value by either route.
  const primaryRpc = (env[`RPC_URL_${chainId}`] ?? getChainRpcUrl(chainId))?.trim();
  if (!primaryRpc) return { disabled: `no RPC URL for chain ${chainId}` };
  if (!isHttpUrl(primaryRpc)) return { disabled: `RPC_URL_${chainId} is not an http(s) URL` };

  const rpcUrls = [primaryRpc];
  const secondRpc = env.ENS_GATEWAY_RPC_URL_2?.trim();
  if (secondRpc) {
    if (!isHttpUrl(secondRpc)) {
      return { disabled: "ENS_GATEWAY_RPC_URL_2 is not an http(s) URL" };
    }
    // INDEPENDENCE, tested on the ORIGIN rather than the whole URL. The claim
    // the cross-check buys is "two unrelated providers do not collude on the
    // same lie"; two API keys at one provider are one provider, and would agree
    // with themselves about anything that provider chose to say. Same origin is
    // therefore the honest test, and it also catches the realistic operator
    // slip of pasting one URL into both variables. A refusal to boot, not a
    // downgrade: green-and-worthless is worse than absent, because an operator
    // acts on green.
    if (originOf(secondRpc) === originOf(primaryRpc)) {
      return {
        disabled:
          `ENS_GATEWAY_RPC_URL_2 shares an origin with RPC_URL_${chainId} — a cross-check against the ` +
          "same provider proves nothing. Use a second, unrelated provider (a distinct host).",
      };
    }
    rpcUrls.push(secondRpc);
  }

  return {
    signerPrivateKey,
    allowedSenders,
    senderChainIds,
    chainId,
    registryAddresses,
    parentName,
    ttlSeconds,
    rpcUrls,
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Scheme + host + port, with credentials and path dropped. Callers have already checked `isHttpUrl`. */
function originOf(value: string): string {
  return new URL(value).origin.toLowerCase();
}

/** Public address of the configured gateway signer — this is what `L1Resolver.signer()` must be set to. */
export function ensGatewaySignerAddress(config: EnsGatewayConfig): string {
  return new Wallet(config.signerPrivateKey).address;
}
