/**
 * `POST /api/zerodev/policy/:secret` (#758) - ZeroDev's custom gas policy asks
 * here before sponsoring any userOp of our project, and pays only on
 * `{ proceed: true }`. The decision is lib/zerodev/sponsor-policy.ts.
 *
 * ZeroDev documents no signature on these requests, so the URL carries a random
 * secret (`ZERODEV_POLICY_SECRET`, at least 32 characters) and the body must name
 * our project (`ZERODEV_PROJECT_ID`) and the Kernel chain. Either env var unset
 * refuses everything: with "Policy Pass on Error" OFF in the dashboard, a server
 * that cannot decide sponsors nothing. The path is a credential - nothing may log
 * request paths on this host. Rotating it = new env value + new dashboard URL.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";
import { KERNEL_CHAIN_ID } from "@woco/shared";
import {
  KERNEL_SELECTOR_CONFIG_ABI,
  LEGACY_HOOK_ALLOWED_ABI,
  LEGACY_ZERODEV_CALLER_HOOK,
  RECOVERY_ACTION_ADDRESS,
  RECOVERY_ROUTE_SELECTOR,
  WOCO_GUARDIAN_HOOK,
  WOCO_GUARDIAN_HOOK_ABI,
} from "@woco/shared/kernel/recovery-contracts";
import type { AppEnv } from "../types.js";
import { jsonBodyLimit } from "../lib/http/body-limit.js";
import { clientIp } from "../lib/http/client-ip.js";
import { SlidingWindowLimiter } from "../lib/http/rate-limit.js";
import { checkAttendeeGate } from "../lib/gate/check.js";
import { getChainRpcUrl } from "../lib/chain/event-contract.js";
import {
  DEFAULT_MAX_OP_COST_WEI,
  SponsorPolicy,
  callDataTag,
  readUserOp,
  type Decision,
  type PolicyDeps,
} from "../lib/zerodev/sponsor-policy.js";
import { upgradeIntents } from "../lib/zerodev/upgrade-intents.js";

const MAX_BODY_BYTES = 16 * 1024;
const MIN_SECRET_LENGTH = 32;

function secretDigest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/** The configured secret and project, or null when sponsorship is switched off. */
function config(): { secret: Buffer; projectId: string } | null {
  const secret = process.env.ZERODEV_POLICY_SECRET?.trim() ?? "";
  const projectId = process.env.ZERODEV_PROJECT_ID?.trim() ?? "";
  if (secret.length < MIN_SECRET_LENGTH || !projectId) return null;
  return { secret: secretDigest(secret), projectId };
}

let _client: PublicClient | null = null;
function chainClient(): PublicClient {
  _client ??= createPublicClient({
    chain: KERNEL_CHAIN_ID === 42161 ? arbitrum : arbitrumSepolia,
    transport: http(getChainRpcUrl(KERNEL_CHAIN_ID)),
  }) as PublicClient;
  return _client;
}

/** The account's live recovery route, then its hook's list. Any failed read = null. */
async function isGuardianLive(account: string, guardian: string): Promise<boolean | null> {
  try {
    const client = chainClient();
    const route = await client.readContract({
      address: account as Address,
      abi: KERNEL_SELECTOR_CONFIG_ABI,
      functionName: "selectorConfig",
      args: [RECOVERY_ROUTE_SELECTOR],
    });
    if (route.target.toLowerCase() !== RECOVERY_ACTION_ADDRESS.toLowerCase()) return false;
    const hook = route.hook.toLowerCase();
    if (hook === WOCO_GUARDIAN_HOOK.toLowerCase()) {
      return await client.readContract({
        address: WOCO_GUARDIAN_HOOK,
        abi: WOCO_GUARDIAN_HOOK_ABI,
        functionName: "isGuardian",
        args: [account as Address, guardian as Address],
      });
    }
    if (hook === LEGACY_ZERODEV_CALLER_HOOK.toLowerCase()) {
      return await client.readContract({
        address: LEGACY_ZERODEV_CALLER_HOOK,
        abi: LEGACY_HOOK_ALLOWED_ABI,
        functionName: "allowed",
        args: [guardian as Address, account as Address],
      });
    }
    return false;
  } catch {
    return null;
  }
}

const liveDeps: PolicyDeps = { gate: (a) => checkAttendeeGate(a), isGuardian: isGuardianLive, upgradeIntent: upgradeIntents };

/** `ZERODEV_POLICY_MAX_OP_COST_WEI`, else the default; a bad value is reported, never fatal. */
function maxOpCost(): { wei: bigint; configError?: string } {
  const raw = process.env.ZERODEV_POLICY_MAX_OP_COST_WEI?.trim();
  if (!raw) return { wei: DEFAULT_MAX_OP_COST_WEI };
  try {
    const wei = BigInt(raw);
    if (wei > 0n) return { wei };
  } catch {
    /* reported below */
  }
  return { wei: DEFAULT_MAX_OP_COST_WEI, configError: "ZERODEV_POLICY_MAX_OP_COST_WEI is not a positive integer" };
}

// Wrong secrets per IP: bounds guessing the path without ever counting ZeroDev's
// own calls, which share a few egress addresses with every other project's junk.
const newGuessLimiter = () => new SlidingWindowLimiter([{ limit: 100, windowMs: 60 * 60_000 }]);
// Everything that passes the secret, process-wide: anyone with the public RPC key
// can send ops through ZeroDev to here, and each new account costs gate reads
// (Swarm). Real traffic is a few ops a day; a flood is refused as "busy" instead.
const newCapacity = () => new SlidingWindowLimiter([{ limit: 120, windowMs: 60_000 }]);
let policy = new SponsorPolicy(liveDeps, maxOpCost().wei);
let guesses = newGuessLimiter();
let capacity = newCapacity();
/** The first bodies' field NAMES are logged once: ZeroDev documents a 0.6 shape, we run 0.7. */
let shapesLogged = 0;

const stats = {
  allowed: 0,
  refused: 0,
  lastAllowedAt: null as string | null,
  lastRefusal: null as { at: string; reason: string } | null,
};

/** `/api/health` section: red while sponsorship cannot be decided at all. */
export function zerodevPolicyHealth() {
  const cost = maxOpCost();
  return {
    ok: config() !== null,
    configured: config() !== null,
    maxOpCostWei: cost.wei.toString(),
    ...(cost.configError ? { configError: cost.configError } : {}),
    ...stats,
  };
}

export function _resetZerodevPolicyForTests(deps: PolicyDeps = liveDeps): void {
  policy = new SponsorPolicy(deps, maxOpCost().wei);
  guesses = newGuessLimiter();
  capacity = newCapacity();
  Object.assign(stats, { allowed: 0, refused: 0, lastAllowedAt: null, lastRefusal: null });
}

/**
 * ZeroDev pays when ANY policy entry passes, and this webhook's entry passes only
 * when our reply says "or" - with "and" it also needs ZeroDev's own checks, which
 * this entry has none of (measured live 2026-10-02: an unlocked account's op was
 * refused under "and" with no chain policy, and a locked one was paid under "and"
 * while a chain policy stood). So: "or" with a yes, so a yes stands on its own;
 * "and" with a no, so a no can never be turned into a yes. The dashboard keeps NO
 * chain/contract/wallet policy, or that entry would pay past every refusal here.
 */
export function policyReply(proceed: boolean): { proceed: boolean; logicalOperator: "or" | "and" } {
  return { proceed, logicalOperator: proceed ? "or" : "and" };
}

const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "-");

function answer(c: { json: (b: unknown, s?: number) => Response }, d: Decision, logLine: string): Response {
  const at = new Date().toISOString();
  if (d.proceed) {
    stats.allowed++;
    stats.lastAllowedAt = at;
    console.log(`[zerodev-policy] allow ${d.shape} ${logLine} account=${short(d.subject)} via=${d.via ?? "-"}`);
  } else {
    stats.refused++;
    stats.lastRefusal = { at, reason: d.reason };
    console.log(`[zerodev-policy] refuse ${d.reason} ${logLine} account=${short(d.subject)} shape=${d.shape ?? "-"}`);
  }
  return c.json(policyReply(d.proceed));
}

export const zerodevPolicy = new Hono<AppEnv>();

zerodevPolicy.post("/:secret", jsonBodyLimit(MAX_BODY_BYTES), async (c) => {
  const cfg = config();
  if (!cfg) return c.json({ proceed: false }, 503);
  const ip = clientIp(c);
  if (!guesses.peek(ip)) return c.notFound();
  const presented = secretDigest(c.req.param("secret") ?? "");
  if (!timingSafeEqual(presented, cfg.secret)) {
    guesses.record(ip);
    return c.notFound();
  }
  if (!capacity.allow("all")) return answer(c, { proceed: false, reason: "busy" }, "");

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return answer(c, { proceed: false, reason: "body" }, "");
  }
  if (body.projectId !== cfg.projectId) return answer(c, { proceed: false, reason: "project" }, "");
  if (Number(body.chainId) !== KERNEL_CHAIN_ID) return answer(c, { proceed: false, reason: "chain" }, "");
  if (shapesLogged < 3 && typeof body.userOp === "object" && body.userOp !== null) {
    shapesLogged++;
    console.log(`[zerodev-policy] userOp fields: ${Object.keys(body.userOp).sort().join(",")}`);
  }
  const op = readUserOp(body.userOp);
  if (!op) return answer(c, { proceed: false, reason: "userop" }, "");

  const decision = await policy.decide(op);
  return answer(c, decision, `sender=${short(op.sender)} nonce=0x${BigInt(op.nonce).toString(16)} cost=${op.maxCostWei} cd=${callDataTag(op.callData)}`);
});
