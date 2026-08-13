/**
 * Post-recovery finalisation (#245 fix 2) — the portability-envelope write as an
 * AWAITED, surfaced ceremony step instead of a fire-and-forget side effect.
 *
 * Why this exists: after `recoverAndRekey`, the PRF-sealed portability envelope
 * is the ONLY cross-device link from the fresh credential to the preserved Kernel
 * address. The old path wrote it as `void _maybeBackfillPortabilityEnvelope()`
 * inside the session mint — unobserved and unverified — and a surviving signed-in
 * session made `ensureSession` short-circuit so the mint (and with it the write)
 * never ran at all. Every other device then resolved the account to the new
 * credential's own counterfactual Kernel. "You're back in" must not render until
 * this step has actually completed.
 *
 * auth-store delegates here with accessors to its private state, and this module
 * imports nothing from it.
 */

import type { AuthKind } from "@woco/shared";
import type { PortabilityBackfill, PortabilityBackfillArgs } from "./recovery-portability.js";

/** The accessors the gather step needs — a subset of the finalize deps, shared
 *  with auth-store's mint-time backfill so both callers feed the SAME preamble. */
export interface BackfillGatherDeps {
  getPasskeyPrivKey: () => string | null;
  /** PRF-EOA address — the key the POD seed and recovery binding are stored under. */
  getPodAddress: () => string | null;
  /** The preserved Kernel address bound to this passkey at recovery time. */
  recoveryKernelFor: (podAddress: string) => Promise<`0x${string}` | undefined>;
  restorePodSeed: (podAddress: string) => Promise<string | null>;
  getContentFeedSigner: () => Promise<{ privKey: string } | null>;
}

export interface RecoveryFinalizeDeps extends BackfillGatherDeps {
  kind: () => AuthKind;
  ensureSession: () => Promise<boolean>;
  /** Test seam — defaults to the real backfillPortabilityEnvelope, which
   *  reaches the network (the repo's node --test runner has no module mocks). */
  backfill?: (args: PortabilityBackfillArgs) => Promise<PortabilityBackfill>;
}

export interface RecoveryFinalizeOptions {
  /**
   * The owner kind the CEREMONY minted, captured by the caller before the first
   * attempt. Without it, a retry reads live `kind()` — and anything that tore the
   * auth store down while the user sat on the warning screen (a Sign out in the
   * shell nav is rendered directly above it) would route a passkey recovery down
   * the web3auth branch and render unqualified success with no envelope written.
   */
  expectPasskey?: boolean;
  /**
   * Total attempts before a retryable failure is surfaced (default 3). The live
   * #273 observation: the envelope step fails transiently under a concurrent
   * session's activity and the user's SECOND manual click succeeds — so the
   * machine clicks for them. Non-retryable failures are never retried; the
   * deterministic feed-signer guard would loop identically forever.
   */
  attempts?: number;
  /** Base delay before the first retry, doubling each attempt (default 1500ms). */
  retryDelayMs?: number;
  /** Called before each silent retry — lets the UI say it is still working. */
  onRetry?: (attempt: number, reason: string) => void;
  /** Test seam — replaces the real backoff sleep. */
  _sleep?: (ms: number) => Promise<void>;
}

export type RecoveryFinalizeResult =
  /** Envelope verified current on Swarm — the account is portable to this passkey's other devices. */
  | { status: "portable"; action: "wrote" | "skipped" }
  /**
   * Web3auth owner: no PRF channel, no envelope by design — re-opening on a new
   * device re-runs the portal. `sessionMinted` is false when the best-effort mint
   * failed; the recovery still stands, but the caller must not promise a working
   * session it did not get. Telling this user "You're back in" unqualified is the
   * same misimpression the whole step exists to prevent.
   */
  | { status: "session-only"; sessionMinted: boolean }
  /**
   * The recovery itself is committed; only this step failed.
   *
   * `retryable` is the honest half. Some failures are transient (network, an
   * inconclusive probe) and a retry genuinely heals them; others re-throw
   * identically forever — notably the anti-divergence guard for an account whose
   * escrow carried no feed signer. Telling that second user "retrying is safe"
   * is an infinite loop with encouraging copy, so the two are kept apart.
   *
   * `stage` distinguishes "this device has no session either" from "only
   * cross-device portability is missing" — the warning copy differs.
   */
  | { status: "failed"; reason: string; retryable: boolean; stage: "session" | "envelope" };

/** The guard fires whenever a recovery binding exists and no feed signer is stored. */
function isDeterministicSignerFailure(message: string): boolean {
  return message.includes("Recovered account feed signer unavailable");
}

export type BackfillGather =
  | { status: "ready"; args: PortabilityBackfillArgs }
  | { status: "unavailable"; reason: string; retryable: boolean; stage: "session" | "envelope" };

/**
 * Collect everything a portability-envelope write needs, with the read-fault
 * classification the callers rely on. THE single owner of this preamble (#260):
 * it used to live twice — here and in auth-store's mint-time backfill — and two
 * owners disagree on failure posture and drift on fields (the #153 growth
 * class: a secret added to one writer ping-pongs envelope versions with the
 * field-poor one, which strips it). `finalizeRecovery` surfaces `unavailable`
 * as a failed ceremony step; the fire-and-forget mint-time caller treats every
 * `unavailable` as its silent no-op. Same facts, different posture — by
 * design, in one place.
 *
 * Classification rules, all incident-proven:
 *  - a read that THREW is not evidence the record is absent (#226 class) — the
 *    reason always says which happened, and only faults are retryable;
 *  - a feed-signer THROW must fail the gather, not degrade it: `null` means
 *    "this account has no feed signer" and writes an envelope without one,
 *    which would strand the account's content feeds on its future devices if
 *    the signer exists but the read faulted;
 *  - the anti-divergence signer guard is DETERMINISTIC (an account whose escrow
 *    carried no feed signer re-throws identically forever) — calling it
 *    retryable is an infinite loop with encouraging copy.
 */
export async function gatherBackfillArgs(deps: BackfillGatherDeps): Promise<BackfillGather> {
  const passkeyPrivKey = deps.getPasskeyPrivKey();
  const podAddress = deps.getPodAddress();
  if (!passkeyPrivKey || !podAddress) {
    return {
      status: "unavailable",
      reason: "passkey key material not in memory",
      retryable: false,
      stage: "session",
    };
  }

  let preserved: `0x${string}` | undefined;
  try {
    preserved = await deps.recoveryKernelFor(podAddress);
  } catch (e) {
    return {
      status: "unavailable",
      reason: `recovery binding read failed: ${e instanceof Error ? e.message : String(e)}`,
      retryable: true,
      stage: "envelope",
    };
  }
  if (!preserved) {
    return {
      status: "unavailable",
      reason: "no recovery binding for this passkey on this device",
      retryable: false,
      stage: "envelope",
    };
  }

  let podSeed: string | null;
  try {
    podSeed = await deps.restorePodSeed(podAddress);
  } catch (e) {
    return {
      status: "unavailable",
      reason: `POD seed read failed: ${e instanceof Error ? e.message : String(e)}`,
      retryable: true,
      stage: "envelope",
    };
  }
  if (!podSeed) {
    return { status: "unavailable", reason: "POD seed absent", retryable: false, stage: "envelope" };
  }

  let feedSigner: { privKey: string } | null;
  try {
    feedSigner = await deps.getContentFeedSigner();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      status: "unavailable",
      reason: `feed signer read failed: ${message}`,
      retryable: !isDeterministicSignerFailure(message),
      stage: "envelope",
    };
  }

  return {
    status: "ready",
    args: {
      passkeyPrivKey,
      preservedKernelAddress: preserved,
      podSeed,
      feedSignerPrivKey: feedSigner?.privKey,
    },
  };
}

export async function finalizeRecovery(
  deps: RecoveryFinalizeDeps,
  opts: RecoveryFinalizeOptions = {},
): Promise<RecoveryFinalizeResult> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const baseDelay = opts.retryDelayMs ?? 1500;
  const sleep = opts._sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let result = await finalizeOnce(deps, opts);
  for (let attempt = 2; attempt <= attempts; attempt++) {
    if (result.status !== "failed" || !result.retryable) return result;
    opts.onRetry?.(attempt, result.reason);
    await sleep(baseDelay * 2 ** (attempt - 2));
    // The WHOLE step re-runs, not just the failed sub-read: the session could
    // have died between attempts, and each accessor is where its own staleness
    // is detected.
    result = await finalizeOnce(deps, opts);
  }
  return result;
}

async function finalizeOnce(
  deps: RecoveryFinalizeDeps,
  opts: RecoveryFinalizeOptions,
): Promise<RecoveryFinalizeResult> {
  const kind = deps.kind();

  // The ceremony minted a passkey owner but the store no longer says so: the
  // auth state was torn down under us (sign-out, account switch). Falling
  // through to the web3auth branch would report success for an envelope that
  // was never written, so refuse instead — and say it is not retryable here,
  // because nothing this screen offers can rebuild the signed-in state.
  if (opts.expectPasskey && kind !== "passkey") {
    return {
      status: "failed",
      reason: `auth state changed mid-recovery (kind is now "${kind}") — sign in again to finish securing other devices`,
      retryable: false,
      stage: "session",
    };
  }

  if (kind !== "passkey") {
    // Best-effort mint only: with no envelope to write, a failed mint just means
    // the first authenticated action re-prompts — the pre-recovery norm.
    const ok = await deps.ensureSession();
    if (!ok) console.warn("[recovery-finalize] session mint failed (non-passkey) — first action will re-mint");
    return { status: "session-only", sessionMinted: ok };
  }

  // The envelope upload is an authenticated SOC stamp (authPost /api/swarm/soc),
  // so the session must exist first. Silent for passkey: the raw owner key is
  // still in memory from the ceremony, no biometric prompt.
  const ok = await deps.ensureSession();
  if (!ok) return { status: "failed", reason: "session mint failed", retryable: true, stage: "session" };

  const gathered = await gatherBackfillArgs(deps);
  if (gathered.status !== "ready") {
    return {
      status: "failed",
      reason: gathered.reason,
      retryable: gathered.retryable,
      stage: gathered.stage,
    };
  }

  try {
    const backfill =
      deps.backfill ?? (await import("./recovery-portability.js")).backfillPortabilityEnvelope;
    const outcome = await backfill(gathered.args);
    // "deferred" = the read was inconclusive and the backfill refused to write
    // blind. The envelope is not verifiably there, so for THIS caller it is a
    // failure — retrying re-reads and skips cleanly if a concurrent write (the
    // session mint's own fire-and-forget backfill) landed it meanwhile.
    if (outcome.action === "deferred") {
      return { status: "failed", reason: outcome.reason, retryable: true, stage: "envelope" };
    }
    return { status: "portable", action: outcome.action };
  } catch (e) {
    return {
      status: "failed",
      reason: e instanceof Error ? e.message : String(e),
      retryable: true,
      stage: "envelope",
    };
  }
}
