/**
 * Attendee gate rune store — global trigger for the ticket-unlock modal
 * (mirrors login-request) plus a cached gate status for the current parent.
 *
 * Components call `gate.request()` and await true (unlocked) / false
 * (cancelled). The globally-mounted TicketGateModal watches `gate.pending`
 * and resolves it.
 */

import { auth } from "../../auth/auth-store.svelte.js";
import { getGateStatus, type GateStatusData } from "../../api/attendee-gate.js";

let _pending = $state(false);
let _prefillTicket = $state<string | undefined>(undefined);
let _resolve: ((success: boolean) => void) | null = null;

let _status = $state<GateStatusData | null>(null);
let _statusFor: string | null = null;
let _refreshInFlight: Promise<GateStatusData | null> | null = null;

export const gate = {
  get pending() { return _pending; },
  get prefillTicket() { return _prefillTicket; },

  /** Cached status for the CURRENT parent; null = unknown (not yet loaded,
   *  signed out, or account switched since the last refresh). */
  get status(): GateStatusData | null {
    const parent = auth.parent?.toLowerCase() ?? null;
    return parent && _statusFor === parent ? _status : null;
  },

  /**
   * Open the ticket-unlock flow. Resolves true once a ticket is bound (or the
   * account turns out to be already unlocked), false if the user cancels.
   * `ticket` pre-fills the /t link input (e.g. arriving from an email link).
   */
  request(opts?: { ticket?: string }): Promise<boolean> {
    if (_resolve) _resolve(false);
    _pending = true;
    _prefillTicket = opts?.ticket;
    return new Promise<boolean>((resolve) => { _resolve = resolve; });
  },

  /** Called by TicketGateModal when the flow completes or is dismissed. */
  resolve(success: boolean): void {
    if (_resolve) { _resolve(success); _resolve = null; }
    _pending = false;
    _prefillTicket = undefined;
  },

  /**
   * Refresh the cached status. Silent: requires an ALREADY-established session
   * (authGet would otherwise trigger the EIP-712 prompt) — returns null and
   * leaves the cache untouched when there is none.
   */
  async refresh(): Promise<GateStatusData | null> {
    if (!auth.isConnected || !auth.hasSession || !auth.parent) return null;
    if (_refreshInFlight) return _refreshInFlight;
    const parent = auth.parent.toLowerCase();
    _refreshInFlight = getGateStatus()
      .then((resp) => {
        if (resp.ok && resp.data) {
          _status = resp.data;
          _statusFor = parent;
          return resp.data;
        }
        return null;
      })
      .catch(() => null)
      .finally(() => { _refreshInFlight = null; });
    return _refreshInFlight;
  },
};
