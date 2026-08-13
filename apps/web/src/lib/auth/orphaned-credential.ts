/**
 * Honest failure for a credential orphaned by recovery (#255).
 *
 * When recovery rotates an account's on-chain owner, every OTHER credential
 * that used to open it is retired by design. The login paths used to treat a
 * retired credential as a brand-new user: clear its stale binding and fall
 * through to the credential's own counterfactual Kernel — silently minting a
 * fresh, empty account under an encouraging login.
 *
 * The discriminator costs nothing: at the moment the stale-binding guard
 * trips, it has just READ a different on-chain owner for the bound Kernel.
 * `recoverAndRekey` writes a binding only AFTER the rotation is confirmed
 * on-chain (its post-condition fails closed), so a bound Kernel that answers
 * with someone else's EOA is proof a later recovery moved the account away —
 * proof of orphaning, never of a new user.
 *
 * So the refusal here fails the login and says why through the one-shot
 * notice channel. Callers must leave the binding and the POD seed in place:
 * the binding is what keeps the counterfactual path unreachable — that path
 * is reserved for credentials that carry no binding at all.
 */

import { AUTH_NOTICE_KEY } from "./auth-notice.js";

/** The two kinds that carry recovery bindings; web3/coinbase never do. */
export type OrphanedCredentialKind = "passkey" | "web3auth";

/**
 * The discriminator, pure: the owner that displaced this credential, or null
 * when nothing was proven. Only an ANSWERED owner that is not this
 * credential's EOA proves orphaning — a `null` read (unreadable chain or
 * undeployed Kernel) is silence, and silence never condemns a signer (#277's
 * rule, applied client-side).
 */
export function provenOrphanOwner(onChainOwner: string | null, eoa: string): string | null {
  return onChainOwner !== null && onChainOwner.toLowerCase() !== eoa.toLowerCase()
    ? onChainOwner
    : null;
}

/**
 * Per-kind because the next step differs: a recovered account's new owner is
 * whatever sign-in the user chose during the recovery ceremony, and for the
 * common passkey→passkey flow naming it beats describing it.
 */
export function orphanedCredentialMessage(kind: OrphanedCredentialKind): string {
  return kind === "passkey"
    ? "This account was recovered on another device. Sign in with your new passkey."
    : "This account was recovered on another device. Sign in with the passkey or email you chose during recovery.";
}

/** Distinguished by `name`, not instanceof, so checks survive chunk boundaries. */
export class OrphanedCredentialError extends Error {
  override readonly name = "OrphanedCredentialError";
  readonly kind: OrphanedCredentialKind;
  /** Evidence for the console, never for the UI. */
  readonly onChainOwner: string;

  constructor(kind: OrphanedCredentialKind, onChainOwner: string) {
    super(orphanedCredentialMessage(kind));
    this.kind = kind;
    this.onChainOwner = onChainOwner;
  }
}

export function isOrphanedCredentialError(e: unknown): e is OrphanedCredentialError {
  return e instanceof Error && e.name === "OrphanedCredentialError";
}

/** The notice write, isolated so a missing/full sessionStorage can never turn
 *  an explanation into a failure. */
export interface OrphanNoticeSink {
  setItem(key: string, value: string): void;
}

/**
 * Post the one-shot explanation the login modal surfaces — the same channel
 * the envelope-reprobe heal posts through. Best-effort: the notice is an
 * explanation, never a step.
 */
export function postOrphanedCredentialNotice(
  kind: OrphanedCredentialKind,
  sink: OrphanNoticeSink | undefined = globalThis.sessionStorage,
): void {
  try {
    sink?.setItem(AUTH_NOTICE_KEY, orphanedCredentialMessage(kind));
  } catch {
    /* explanation only */
  }
}

/**
 * The refusal: record the evidence, post the explanation, hand back the error
 * the login fails with. Callers throw it; they must NOT clear the binding or
 * the POD seed — durable state is exactly what makes the refusal repeatable.
 */
export function refuseOrphanedCredential(
  kind: OrphanedCredentialKind,
  details: { boundKernel: string; onChainOwner: string },
  sink?: OrphanNoticeSink,
): OrphanedCredentialError {
  console.warn(
    `[auth] ${kind} credential is orphaned — bound Kernel`,
    details.boundKernel,
    "is owned on-chain by",
    details.onChainOwner,
    "— refusing the login instead of minting a counterfactual account (#255)",
  );
  postOrphanedCredentialNotice(kind, sink ?? globalThis.sessionStorage);
  return new OrphanedCredentialError(kind, details.onChainOwner);
}
