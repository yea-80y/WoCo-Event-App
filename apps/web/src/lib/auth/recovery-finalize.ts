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
}

export type RecoveryFinalizeResult =
  /** Envelope verified current on Swarm — the account is portable to this passkey's other devices. */
  | { status: "portable"; action: "wrote" | "skipped" }
  /** Web3auth owner: no PRF channel, no envelope by design — re-opening on a new device re-runs the portal. */
  | { status: "session-only" }
  /** Nothing irreversible happened — safe to retry any number of times. */
  | { status: "failed"; reason: string };

export async function finalizeRecovery(deps: RecoveryFinalizeDeps): Promise<RecoveryFinalizeResult> {
  if (deps.kind() !== "passkey") {
    // Best-effort mint only: with no envelope to write, a failed mint just means
    // the first authenticated action re-prompts — the pre-recovery norm.
    const ok = await deps.ensureSession();
    if (!ok) console.warn("[recovery-finalize] session mint failed (non-passkey) — first action will re-mint");
    return { status: "session-only" };
  }

  // The envelope upload is an authenticated SOC stamp (authPost /api/swarm/soc),
  // so the session must exist first. Silent for passkey: the raw owner key is
  // still in memory from the ceremony, no biometric prompt.
  const ok = await deps.ensureSession();
  if (!ok) return { status: "failed", reason: "session mint failed" };

  const passkeyPrivKey = deps.getPasskeyPrivKey();
  const podAddress = deps.getPodAddress();
  if (!passkeyPrivKey || !podAddress) {
    return { status: "failed", reason: "passkey key material not in memory" };
  }

  const preserved = await deps.recoveryKernelFor(podAddress).catch(() => undefined);
  if (!preserved) {
    return { status: "failed", reason: "no recovery binding for this passkey on this device" };
  }

  const podSeed = await deps.restorePodSeed(podAddress).catch(() => null);
  if (!podSeed) {
    return { status: "failed", reason: "POD seed unreadable" };
  }

  // A throw here must fail the step, not degrade it: `null` means "this account
  // has no feed signer" and writes an envelope without one, which would strand
  // the account's content feeds on its future devices if the signer actually
  // exists but the read faulted.
  let feedSigner: { privKey: string } | null;
  try {
    feedSigner = await deps.getContentFeedSigner();
  } catch (e) {
    return { status: "failed", reason: `feed signer read failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  try {
    const { backfillPortabilityEnvelope } = await import("./recovery-portability.js");
    const outcome = await backfillPortabilityEnvelope({
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
      return { status: "failed", reason: outcome.reason };
    }
    return { status: "portable", action: outcome.action };
  } catch (e) {
    return { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
}
