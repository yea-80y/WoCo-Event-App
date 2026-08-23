/**
 * Cross-device owner-collision scan (#234): every account a credential has ever
 * been registered as owner of, from the chain, and which of those it still owns.
 *
 * WHY. The web3auth recovery guard (`recovery-owner-collision.ts`) refuses to
 * hand an account to a credential that already has one — but its evidence is
 * LOCAL (this device's binding, seed, caches) plus ONE chain point-read (the
 * credential's own counterfactual Kernel). A recovered account lives at a
 * PRESERVED address that is not derivable from the credential, so a second
 * recovery onto the same email on a second device passes both: no local trace,
 * and the point-read cannot see a preserved address. One key then genuinely owns
 * two accounts, escrows and all.
 *
 * THE PRIMITIVE. Kernel v3.1's ECDSA validator emits
 *   OwnerRegistered(address indexed kernel, address indexed owner)
 * from `onInstall` — the SOLE writer of a nonzero owner (the deployed bytecode
 * has no setOwner / transferOwnership; verified against the 1819-byte validator,
 * #234) — and it fires on recoveries, not just deploys (confirmed on a harness
 * Kernel: deploy → one event, doRecovery → a second with the new owner). Both
 * fields are indexed, so `eth_getLogs(topics[2] = credential)` lists every
 * account the credential was ever registered to, on any device, with no new
 * write and no server.
 *
 * COMPLETENESS (the union argument, stated so nobody builds on a weaker one): a
 * recovered account is necessarily DEPLOYED (something had to be rotated), so
 * every non-derivable account a credential owns has emitted; the only eventless
 * account is the credential's own derivable counterfactual, which the existing
 * point-read covers. Together they are complete for every account that has ever
 * touched the chain — i.e. every account holding tickets or funds. This assumes
 * exactly ONE derivation index per credential (`index: 0n` everywhere); a second
 * index would break the union.
 *
 * THE LOG IS HISTORY, NOT STATE. A hit means "was registered here", not "still
 * owns it" — an account later moved to another credential still lists the old
 * one. So each hit is re-read live, and ONLY a kernel whose current owner is
 * still this credential is a collision. That re-read is TRI-STATE and the whole
 * check aborts as `unknown` if any single hit errs: a legitimately-zero owner
 * means the hit is stale (allow); a FAILED read means we cannot prove safety
 * (block). Conflating them would make a transient RPC fault on precisely the
 * colliding hit fail open — the #138 absent-vs-unknown class, with the wrong
 * polarity.
 *
 * PAGING IS MANDATORY, and it must never return a partial answer. `toBlock` is
 * snapshotted once at scan start; any page failure (after per-page retries and
 * an endpoint fallback) aborts the WHOLE scan as `unknown`, never "no
 * collisions". `eth_getLogs` fails loudly rather than truncating — the risk is
 * in the client loop, which is why the loop is here and tested.
 *
 * POLARITY, stated because it is the OPPOSITE of the guardian pre-flight next to
 * it: the (0b) route read proceeds on an unreadable chain (blocking a locked-out
 * user on an RPC blip is worse than letting the rotation fail closed on its own);
 * this check BLOCKS on an unreadable chain, because silent identity corruption is
 * worse than a delayed recovery and the escape hatch costs one click — recovery
 * onto a fresh passkey is structurally collision-free and needs no scan. Do not
 * "harmonise" the two.
 *
 * ACCIDENT PREVENTION, NOT ADVERSARIAL ENFORCEMENT. Nothing on-chain stops a
 * second rotation, and an old client skips this guard entirely. The "attacker"
 * in this threat model is the user harming themselves. A same-moment race
 * (both devices scan clean, both rotate) cannot be closed client-side without an
 * on-chain mutex; it is made LOUD instead — see `scanOwnedAccounts` with
 * `fromBlock`, the tail re-scan the ceremony runs after the rotation confirms
 * and before any local commit. The rotation itself emits the event that proves
 * the collision.
 */

import type { Address } from "viem";

/**
 * `keccak256("OwnerRegistered(address,address)")`. Pinned by test against viem's
 * `toEventSelector` so a typo here cannot silently scan for nothing.
 */
export const OWNER_REGISTERED_TOPIC =
  "0xa5e1f8b4009110f5525798d04ae2125421a12d0590aa52c13682ff1bd3c492ca" as const;

/**
 * Scan floor, Arbitrum Sepolia. Provenance (#234 review): first `OwnerRegistered`
 * from this validator observed at block 56,020,341; zero events in 40–50M. No
 * WoCo account predates it. PER-CHAIN — resets for Arbitrum One.
 */
export const OWNER_SCAN_FLOOR_BLOCK = 56_000_000n;

/**
 * Page width. Measured: the ZeroDev RPC answers a 10M-block page in ~1.4 s
 * (2026-08-23, 3387 logs); the public endpoint answers 10M fine and times out
 * server-side at ~46M+ (owner's measurement). ~25 pages today, +10–13 a year.
 */
export const OWNER_SCAN_PAGE_BLOCKS = 10_000_000n;

/** Reorg margin for the post-rotation tail re-scan (blocks below the pre-scan head). */
export const OWNER_SCAN_REORG_MARGIN = 1_000n;

export const OWNER_SCAN_PAGE_ATTEMPTS = 3;

export type OwnedAccountsScan =
  /** No account other than the excluded ones is live-owned by the credential. */
  | { status: "clean"; head: bigint; pages: number }
  /** These kernels' CURRENT owner is the credential. */
  | { status: "collision"; head: bigint; kernels: string[] }
  /** The scan could not complete. Never a partial "clean". */
  | { status: "unknown"; reason: string };

/** Everything the scan touches, injected so the loop is unit-tested. */
export interface OwnedAccountsScanIO {
  head(): Promise<bigint>;
  /**
   * Kernels (`topics[1]`) registered to the credential in [from, to], both
   * inclusive. THROWS on any failure — the loop decides retries and fallbacks.
   */
  getOwnerRegisteredKernels(from: bigint, to: bigint): Promise<string[]>;
  /** Live owner: lowercased address, `null` when unset, `"error"` when the read failed. */
  readOwner(kernel: string): Promise<string | null | "error">;
  sleep?: (ms: number) => Promise<void>;
}

const lower = (a: string) => a.toLowerCase();

export async function scanOwnedAccounts(args: {
  /** The credential (EOA) — lowercased inside. */
  eoa: string;
  /** Kernels NOT to count: the recovery target (repair path) and the credential's
   *  own counterfactual (judged by the point-read + rule 0b). */
  exclude: readonly (string | null | undefined)[];
  io: OwnedAccountsScanIO;
  /** Defaults: floor → head. A tail re-scan passes `fromBlock` (pre-scan head minus margin). */
  fromBlock?: bigint;
  toBlock?: bigint;
  pageBlocks?: bigint;
  onPage?: (done: number, total: number) => void;
}): Promise<OwnedAccountsScan> {
  const eoa = lower(args.eoa);
  const exclude = new Set(args.exclude.filter((x): x is string => !!x).map(lower));
  const pageBlocks = args.pageBlocks ?? OWNER_SCAN_PAGE_BLOCKS;
  const sleep = args.io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let head: bigint;
  try {
    head = args.toBlock ?? (await args.io.head());
  } catch (e) {
    return { status: "unknown", reason: `could not read the chain head: ${(e as Error)?.message ?? String(e)}` };
  }
  let from = args.fromBlock ?? OWNER_SCAN_FLOOR_BLOCK;
  if (from < 0n) from = 0n;
  if (from > head) return { status: "clean", head, pages: 0 };

  const total = Number((head - from) / pageBlocks + 1n);
  const kernels = new Set<string>();
  let done = 0;
  for (let cursor = from; cursor <= head; cursor += pageBlocks) {
    const to = cursor + pageBlocks - 1n < head ? cursor + pageBlocks - 1n : head;
    let ok = false;
    let lastErr: unknown;
    for (let attempt = 0; attempt < OWNER_SCAN_PAGE_ATTEMPTS; attempt++) {
      try {
        for (const k of await args.io.getOwnerRegisteredKernels(cursor, to)) kernels.add(lower(k));
        ok = true;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < OWNER_SCAN_PAGE_ATTEMPTS - 1) await sleep(2_000 * 2 ** attempt);
      }
    }
    if (!ok) {
      // NEVER partial: a page we could not read may hold the collision.
      return {
        status: "unknown",
        reason: `log page ${cursor}-${to} failed after ${OWNER_SCAN_PAGE_ATTEMPTS} attempts: ${(lastErr as Error)?.message ?? String(lastErr)}`,
      };
    }
    done++;
    args.onPage?.(done, total);
  }

  const candidates = [...kernels].filter((k) => !exclude.has(k));
  const collisions: string[] = [];
  for (const kernel of candidates) {
    const owner = await args.io.readOwner(kernel);
    // Tri-state, and the whole check aborts on a single failed read — see the
    // module note on polarity.
    if (owner === "error") return { status: "unknown", reason: `could not read the current owner of ${kernel}` };
    if (owner !== null && lower(owner) === eoa) collisions.push(kernel);
  }
  if (collisions.length > 0) return { status: "collision", head, kernels: collisions };
  return { status: "clean", head, pages: total };
}

// ---------------------------------------------------------------------------
// Live I/O
// ---------------------------------------------------------------------------

/**
 * RPC endpoints for the log scan, in order. The primary is the same RPC every
 * owner read already trusts (`VITE_ZERODEV_RPC`); the fallback list covers the
 * spec's "≥2 endpoints" and is overridable for an indexer-grade provider. A page
 * that fails on one endpoint is retried on the next before the scan gives up.
 */
export function ownerScanRpcUrls(): string[] {
  const env = import.meta.env as Record<string, string | undefined>;
  const primary = env.VITE_ZERODEV_RPC;
  const extra = (env.VITE_OWNER_SCAN_FALLBACK_RPCS ?? "https://sepolia-rollup.arbitrum.io/rpc")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const urls = [primary, ...extra].filter((u): u is string => !!u);
  if (urls.length === 0) throw new Error("no RPC configured for the owner scan (VITE_ZERODEV_RPC)");
  return [...new Set(urls)];
}

/** Wire the scan to viem + the validator the owner reads use, bound to ONE credential. */
export async function buildOwnedAccountsScanIO(eoa: string): Promise<OwnedAccountsScanIO> {
  const [{ createPublicClient, http, parseAbiItem }, { arbitrumSepolia }, { getEntryPoint, KERNEL_V3_1 }, { getValidatorAddress }, { readKernelEcdsaOwnerStrict }] =
    await Promise.all([
      import("viem"),
      import("viem/chains"),
      import("@zerodev/sdk/constants"),
      import("@zerodev/ecdsa-validator"),
      import("./kernel-account.js"),
    ]);
  // The SAME expression as the owner reads — never a hardcoded constant. A future
  // Kernel version bump splits accounts across two validator deployments and the
  // scan must then cover both; deriving it here is what makes that visible.
  const validator = getValidatorAddress(getEntryPoint("0.7"), KERNEL_V3_1) as Address;
  const event = parseAbiItem("event OwnerRegistered(address indexed kernel, address indexed owner)");
  const owner = eoa as Address;
  const clients = ownerScanRpcUrls().map((url) =>
    createPublicClient({ chain: arbitrumSepolia, transport: http(url, { timeout: 60_000 }) }),
  );
  return {
    head: () => clients[0]!.getBlockNumber(),
    async getOwnerRegisteredKernels(from, to) {
      let lastErr: unknown;
      for (const client of clients) {
        try {
          const logs = await client.getLogs({ address: validator, event, args: { owner }, fromBlock: from, toBlock: to });
          return logs.map((l) => String(l.args.kernel ?? "").toLowerCase()).filter(Boolean);
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    },
    readOwner: (kernel) => readKernelEcdsaOwnerStrict(kernel),
  };
}
