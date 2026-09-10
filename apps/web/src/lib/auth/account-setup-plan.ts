/**
 * What an account still has to sign on THIS device, and whether to explain it
 * first.
 *
 * Since #529 an account has exactly two signatures: `AuthorizeSession` (a 30-day
 * device key) and `DeriveAccountKeys` (the one-off seed). Who SEES them differs
 * by login kind, and that is the whole reason this decision is a function rather
 * than an `if` at each call site:
 *
 *   passkey / web3auth — the session signature is silent (a raw key already in
 *     memory), and the seed signature comes through our own confirm dialog. One
 *     readable prompt; a pre-flight sheet would be a second screen explaining a
 *     screen.
 *   web3 / coinbase — both are WALLET popups. Our dialog never renders, so
 *     without a pre-flight sheet the person meets two unannounced popups with no
 *     idea how many are coming or why.
 *
 * Kept pure and free of runes so it can be unit-tested; the store that drives the
 * sheet and the auth store that runs the steps both read their decision here.
 */

import type { AuthKind } from "@woco/shared";

export type AccountSetupStep = "session" | "identity";

export interface AccountSetupPlan {
  /** Signatures still outstanding, in the order they will be asked for. */
  steps: AccountSetupStep[];
  /** Show the pre-flight sheet before the first popup. */
  showSheet: boolean;
}

export interface AccountSetupState {
  kind: AuthKind;
  hasSession: boolean;
  /** The identity seed is already on this device (no `DeriveAccountKeys` needed). */
  hasSeed: boolean;
  /** This action needs the seed, not just a session. */
  identity: boolean;
  /** The sheet has already been shown for this account on this device. */
  explainedBefore: boolean;
}

/**
 * Kinds whose signatures are wallet popups we cannot decorate. `coinbase` is
 * here even though its login is flag-off (`coinbaseLoginAllowed`) — it is an
 * external wallet, and the flag flipping on must not silently take the
 * explanation away.
 */
const EXTERNAL_WALLET_KINDS: ReadonlySet<AuthKind> = new Set<AuthKind>(["web3", "coinbase"]);

export function planAccountSetup(state: AccountSetupState): AccountSetupPlan {
  const steps: AccountSetupStep[] = [];
  if (!state.hasSession) steps.push("session");
  if (state.identity && !state.hasSeed) steps.push("identity");

  return {
    steps,
    showSheet:
      EXTERNAL_WALLET_KINDS.has(state.kind) && steps.length > 0 && !state.explainedBefore,
  };
}

// ---------------------------------------------------------------------------
// "We already explained this" memory — per device, per account
// ---------------------------------------------------------------------------

const EXPLAINED_PREFIX = "woco:account-setup-explained:";

/**
 * Deliberately keyed by parent address, not global: a second account on the same
 * browser is a different person's mental model as often as not, and the sheet is
 * cheap. Absent (or unreadable — private windows, blocked site data) reads as
 * "not explained", so the failure mode is one extra explanation, never a
 * surprise popup.
 */
export function hasExplainedAccountSetup(parent: string): boolean {
  try {
    return localStorage.getItem(EXPLAINED_PREFIX + parent.toLowerCase()) !== null;
  } catch {
    return false;
  }
}

export function markAccountSetupExplained(parent: string): void {
  try {
    localStorage.setItem(EXPLAINED_PREFIX + parent.toLowerCase(), "1");
  } catch {
    // Nothing to recover: the only cost is showing the sheet again next time.
  }
}
