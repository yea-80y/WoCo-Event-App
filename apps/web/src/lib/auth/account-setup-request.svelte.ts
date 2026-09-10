import type { AccountSetupPlan, AccountSetupStep } from "./account-setup-plan.js";

export type AccountSetupStatus =
  /** The sheet is explaining; waiting for Continue / Not now. */
  | "explaining"
  /** Consent given — the wallet popups are happening and the rail is ticking. */
  | "running"
  /** A popup was rejected; waiting for Try again / Close. */
  | "cancelled"
  /** Every step ticked — the sheet closes itself after a beat. */
  | "done";

export interface AccountSetupPending {
  steps: AccountSetupStep[];
  done: AccountSetupStep[];
  status: AccountSetupStatus;
}

let _pending = $state<AccountSetupPending | null>(null);
let _resolve: ((proceed: boolean) => void) | null = null;

function _settle(proceed: boolean): void {
  if (_resolve) {
    const r = _resolve;
    _resolve = null;
    r(proceed);
  }
}

/**
 * Svelte 5 rune store behind `AccountSetupSheet` — same shape as
 * `signing-request.svelte.ts`, with one addition: the sheet OUTLIVES the answer
 * it asked for. It stays mounted while the wallet popups happen so the person
 * can watch the rail tick, which is the point of it existing at all.
 *
 * Both `request()` and `reportCancelled()` hand back a promise for the same
 * question — "keep going?" — so the caller can loop over a retry without a
 * second channel.
 */
export const accountSetupRequest = {
  get pending() { return _pending; },

  /** Explain the plan and wait for consent. True = Continue, false = Not now. */
  request(plan: AccountSetupPlan): Promise<boolean> {
    // An overlapping request means two actions raced for setup. Refuse the older
    // one rather than leaving its caller awaiting a promise nobody will settle.
    _settle(false);
    _pending = { steps: [...plan.steps], done: [], status: "explaining" };
    return new Promise<boolean>((resolve) => { _resolve = resolve; });
  },

  /** Tick a step. A no-op when no sheet is up (passkey/web3auth never show one). */
  markDone(step: AccountSetupStep): void {
    if (!_pending || _pending.done.includes(step)) return;
    _pending = { ..._pending, done: [..._pending.done, step], status: "running" };
  },

  /** Every step signed — the sheet shows the last tick, then closes itself. */
  finish(): void {
    if (!_pending) return;
    _pending = { ..._pending, status: "done" };
  },

  /**
   * A popup was rejected. Resolves true if the person wants to try again, false
   * if they are done. The ticks already earned STAY — a session that was minted
   * before the second popup was rejected really does exist, and blanking the rail
   * would claim otherwise.
   */
  reportCancelled(): Promise<boolean> {
    if (!_pending) return Promise.resolve(false);
    _pending = { ..._pending, status: "cancelled" };
    return new Promise<boolean>((resolve) => { _resolve = resolve; });
  },

  /** Called by the sheet's buttons. */
  respond(proceed: boolean): void {
    if (!proceed) _pending = null;
    else if (_pending) _pending = { ..._pending, status: "running" };
    _settle(proceed);
  },

  /** Dismiss without an answer (the self-close after the last tick). */
  close(): void {
    _pending = null;
    _settle(false);
  },
};
