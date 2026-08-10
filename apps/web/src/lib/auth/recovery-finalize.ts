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
 * auth-store.svelte.ts is frozen: it delegates here with accessors to its private
 * state, and this module imports nothing from it.
 */

import type { AuthKind } from "@woco/shared";
import type { PortabilityBackfill } from "./recovery-portability.js";

export interface RecoveryFinalizeDeps {
  kind: () => AuthKind;
  ensureSession: () => Promise<boolean>;
  getPasskeyPrivKey: () => string | null;
  /** PRF-EOA address — the key the POD seed and recovery binding are stored under. */
  getPodAddress: () => string | null;
  /** The preserved Kernel address bound to this passkey at recovery time. */
  recoveryKernelFor: (podAddress: string) => Promise<`0x${string}` | undefined>;
  restorePodSeed: (podAddress: string) => Promise<string | null>;
  getContentFeedSigner: () => Promise<{ privKey: string } | null>;
  /** Test seam — defaults to the real backfillPortabilityEnvelope, which
   *  reaches the network (the repo's node --test runner has no module mocks). */
  backfill?: (args: {
    passkeyPrivKey: string;
    preservedKernelAddress: string;
    podSeed: string;
    feedSignerPrivKey?: string;
  }) => Promise<PortabilityBackfill>;
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

export async function finalizeRecovery(
  deps: RecoveryFinalizeDeps,
  opts: RecoveryFinalizeOptions = {},
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

  const passkeyPrivKey = deps.getPasskeyPrivKey();
  const podAddress = deps.getPodAddress();
  if (!passkeyPrivKey || !podAddress) {
    return {
      status: "failed",
      reason: "passkey key material not in memory",
      retryable: false,
      stage: "session",
    };
  }

  // A read that THREW is not evidence the record is absent (#226 class). Both
  // reasons say which happened, so a log never asserts a fact nobody observed.
  let preserved: `0x${string}` | undefined;
  try {
    preserved = await deps.recoveryKernelFor(podAddress);
  } catch (e) {
    return {
      status: "failed",
      reason: `recovery binding read failed: ${e instanceof Error ? e.message : String(e)}`,
      retryable: true,
      stage: "envelope",
    };
  }
  if (!preserved) {
    return {
      status: "failed",
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
      status: "failed",
      reason: `POD seed read failed: ${e instanceof Error ? e.message : String(e)}`,
      retryable: true,
      stage: "envelope",
    };
  }
  if (!podSeed) {
    return { status: "failed", reason: "POD seed absent", retryable: false, stage: "envelope" };
  }

  // A throw here must fail the step, not degrade it: `null` means "this account
  // has no feed signer" and writes an envelope without one, which would strand
  // the account's content feeds on its future devices if the signer actually
  // exists but the read faulted.
  //
  // One throw is DETERMINISTIC, and calling it retryable is the difference
  // between a warning and an infinite loop: for an account whose escrow bundle
  // carried no feed signer (protected before feed-signer escrow existed), the
  // accessor's anti-divergence guard fires on every call — a binding exists and
  // no signer is stored — so every "Try again" re-throws identically. Those
  // users need to be told the truth, not invited to keep clicking.
  let feedSigner: { privKey: string } | null;
  try {
    feedSigner = await deps.getContentFeedSigner();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      status: "failed",
      reason: `feed signer read failed: ${message}`,
      retryable: !isDeterministicSignerFailure(message),
      stage: "envelope",
    };
  }

  try {
    const backfill =
      deps.backfill ?? (await import("./recovery-portability.js")).backfillPortabilityEnvelope;
    const outcome = await backfill({
      passkeyPrivKey,
      preservedKernelAddress: preserved,
      podSeed,
      feedSignerPrivKey: feedSigner?.privKey,
    });
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
