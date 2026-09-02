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
import type { CcipHandlerConfig } from "./ccip.js";

export type EnsGatewayConfig = CcipHandlerConfig;

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

  // OWNER RULE: the gateway signer is a NEW hot key, never the sponsor wallet.
  // The sponsor holds funds and mints names; this key sits behind a public
  // unauthenticated GET. Sharing them would mean one gateway compromise also
  // drains the sponsor and takes over minting.
  const sponsorPk = env.WOCO_SPONSOR_PRIVATE_KEY?.trim();
  if (sponsorPk && addressOf(sponsorPk) === signer) {
    return { disabled: "gateway signer must not be the sponsor wallet" };
  }

  // Pinning the L1Resolver addresses is what stops this gateway from signing a
  // resolution that some OTHER resolver — one whose `signer()` also points here,
  // or one an attacker deployed and pointed at this URL — would accept.
  const raw = env.ENS_GATEWAY_RESOLVER_ADDRESSES?.trim();
  if (!raw) return { disabled: "ENS_GATEWAY_RESOLVER_ADDRESSES is not set" };
  const allowedSenders = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.toLowerCase());
  if (allowedSenders.length === 0) return { disabled: "ENS_GATEWAY_RESOLVER_ADDRESSES is empty" };
  const bad = allowedSenders.find((s) => !ADDRESS_RE.test(s));
  if (bad) return { disabled: `ENS_GATEWAY_RESOLVER_ADDRESSES contains a non-address: ${bad}` };

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

  return {
    signerPrivateKey,
    allowedSenders,
    chainId,
    registryAddress,
    parentName,
    ttlSeconds,
  };
}

/** Public address of the configured gateway signer — this is what `L1Resolver.signer()` must be set to. */
export function ensGatewaySignerAddress(config: EnsGatewayConfig): string {
  return new Wallet(config.signerPrivateKey).address;
}
