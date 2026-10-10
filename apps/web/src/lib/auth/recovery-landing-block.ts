/**
 * "No read older than what this device has already seen" (#510 — the residual of #505).
 *
 * THE HOLE THIS CLOSES. "Add a backup" chooses between two on-chain writes with
 * OPPOSITE semantics: a route install SETS the guardian hook's set to exactly the
 * new guardian, `addGuardian` APPENDS to it (`decideAddPath`). The choice comes
 * from a chain read at "latest" through a load-balanced RPC, so a replica that has
 * not yet seen backup A's install answers `absent` — honestly, from where it is
 * standing — and `absent` maps to `install`, which drops A while reporting success.
 *
 * #505 closed the case where the PANEL had already seen the truth
 * (`checkAddAgainstPriorProtection` refuses a pre-write read that retracts what the
 * user was shown). It could not close the case where the panel's OWN mount-time
 * read came from the lagging replica: there is nothing to contradict.
 *
 * THE INVARIANT HERE. On a device that has ever seen this account's recovery route
 * CHANGE, no route read may be answered by a replica older than that change. A read
 * that cannot be so answered is `unknown` — "couldn't load" — never `absent`.
 *
 * The mechanism is the one the write paths already use: every recovery write knows
 * the block its userOp landed in and pins its read-back to it (a node that lacks the
 * block ERRORS, which surfaces as "couldn't confirm" instead of as stale state).
 * This module makes that block DURABLE, so every LATER read can be pinned too.
 *
 * WHAT IT IS NOT. It is a per-device memory, so it protects a device that has seen
 * a change and nothing else: a fresh device (or one whose storage was cleared) has
 * no lower bound to demand and falls back to exactly today's behaviour, where the
 * #505 guard is the only protection. It holds no secret — a block number against a
 * Kernel address that is already in this browser's storage as the parent address —
 * which is why sign-out deliberately does NOT sweep it: the next sign-in on this
 * device would otherwise reopen the window it exists to close.
 */

import type { RecoveryRouteStatus } from "./kernel-account.js";
import type { GuardianSetRead } from "./guardian-hook.js";

/**
 * One slot per account. A PREFIX, not a fixed key, which is why it does not live in
 * `StorageKeys` (a registry of exact slots): the account address is part of the name
 * so two accounts on one device cannot lend each other a lower bound.
 */
const LANDING_BLOCK_PREFIX = "woco:recovery:landing-block:";

/**
 * Session mirror of the same values. A browser that refuses storage (private mode,
 * blocked site data) must not silently lose the bound for the tab that JUST wrote
 * the backup — that tab is the likeliest one to add a second.
 */
const memo = new Map<string, bigint>();

function keyFor(kernelAddress: string): string {
  return LANDING_BLOCK_PREFIX + kernelAddress.toLowerCase();
}

function readStored(key: string): bigint | null {
  try {
    const raw = localStorage.getItem(key);
    // Anything but digits is a foreign or corrupted write: no bound, not a throw.
    if (raw === null || !/^\d+$/.test(raw)) return null;
    return BigInt(raw);
  } catch {
    return null;
  }
}

/**
 * Record the block a recovery write landed in. MONOTONIC: it never lowers an
 * existing bound, because a bound is a claim about what this device has SEEN and
 * seeing something newer cannot unsee the older change. (A lower value arriving is
 * not hypothetical — two tabs, or a revoke read back from a cached receipt.)
 *
 * Best-effort by construction: storage can throw, and a write that cannot be
 * persisted is still held in memory for this session.
 */
export function rememberLandingBlock(kernelAddress: string, block: bigint): void {
  const key = keyFor(kernelAddress);
  const current = rememberedLandingBlock(kernelAddress);
  if (current !== null && current >= block) return;
  memo.set(key, block);
  try {
    localStorage.setItem(key, block.toString());
  } catch {
    /* private mode / blocked site data — the memo above still holds it for this session */
  }
}

/** The newest recovery-write block this device knows about for the account, or `null`. */
export function rememberedLandingBlock(kernelAddress: string): bigint | null {
  const key = keyFor(kernelAddress);
  const inMemory = memo.get(key) ?? null;
  const stored = readStored(key);
  if (inMemory === null) return stored;
  if (stored === null) return inMemory;
  // MAX, not "stored wins": another tab may have moved the bound forward since this
  // one last wrote, and the higher of the two is the one this device has seen.
  return stored > inMemory ? stored : inMemory;
}

/** Which block to pin every read of this batch to — or that the RPC is behind us. */
export type PinDecision = { pin: bigint } | { lagging: true };

/**
 * PURE. Given the head this RPC reports and the lower bound this device demands:
 *
 *  - no bound → pin the head. Nothing is known to be missing, and pinning still
 *    buys atomicity across the reads below (see next point).
 *  - head BELOW the bound → the answering replica predates a change we have already
 *    seen. It cannot tell us anything we may act on: `lagging`.
 *  - otherwise → pin the HEAD, which is a specific block at or after the bound.
 *
 * WHY THE HEAD AND NEVER `minBlock` ITSELF. Pinning at the bound would read state AS
 * OF that old block and hide every later change — a removal made on another device
 * would read back as still-installed. The head is the newest block this replica can
 * answer for, so it is both fresh and specific; pinning the follow-up reads to it
 * makes them ATOMIC against load balancing, since a second replica that lacks the
 * block errors (→ `unknown`) instead of answering from a different, older state.
 */
export function decidePinnedBlock(args: { head: bigint; minBlock: bigint | null }): PinDecision {
  if (args.minBlock === null) return { pin: args.head };
  if (args.head < args.minBlock) return { lagging: true };
  return { pin: args.head };
}

/** The chain reads "add a backup" and the protection panel both decide on. */
export interface PinnedRouteRead {
  route: RecoveryRouteStatus;
  /** The WoCo hook's set, read at the SAME block — `null` when there is no WoCo set to read. */
  set: GuardianSetRead | null;
  /** The block every read above was answered at; `null` when nothing could be pinned. */
  pinnedAt: bigint | null;
}

/** The I/O `readRouteNoOlderThan` needs, injected so the decision stays testable. */
export interface PinnedRouteReadDeps {
  headBlock: () => Promise<bigint>;
  readRoute: (kernelAddress: string, atBlock?: bigint) => Promise<RecoveryRouteStatus>;
  readSet: (kernelAddress: string, atBlock?: bigint) => Promise<GuardianSetRead>;
}

/** Every honest failure lands here: "couldn't tell", never "there is nothing there". */
const UNREADABLE: PinnedRouteRead = { route: { state: "unknown" }, set: null, pinnedAt: null };

/**
 * Read the recovery route (and, behind the WoCo hook, its guardian set) at a block
 * no older than the last change this device saw.
 *
 * A lagging replica NEVER reaches the route read: there is no answer it could give
 * that we may act on, and asking anyway invites exactly the stale `absent` that
 * silently drops a backup. Anything unreadable — the head, the route, the set —
 * resolves to `unknown`.
 */
export async function readRouteNoOlderThan(
  kernelAddress: string,
  deps: PinnedRouteReadDeps,
): Promise<PinnedRouteRead> {
  const minBlock = rememberedLandingBlock(kernelAddress);
  try {
    const decision = decidePinnedBlock({ head: await deps.headBlock(), minBlock });
    if ("lagging" in decision) {
      console.warn(
        `[recovery] RPC is behind this device's last recovery write for ${kernelAddress} — ` +
          "reporting the route as unreadable rather than acting on a stale answer",
      );
      return UNREADABLE;
    }
    const route = await deps.readRoute(kernelAddress, decision.pin);
    if (route.state !== "installed" || route.hookKind !== "woco") {
      return { route, set: null, pinnedAt: decision.pin };
    }
    return { route, set: await deps.readSet(kernelAddress, decision.pin), pinnedAt: decision.pin };
  } catch (e) {
    console.warn("[recovery] pinned route read failed:", e);
    return UNREADABLE;
  }
}
