import type { PasskeyWindowAction } from "@woco/shared";
import type { OpenedWindow, PasskeySheet } from "./passkey-window.js";

/**
 * The "Continue with your passkey" sheet: the tap a passkey window needs when the
 * ceremony was reached from code no click is on the stack of (a reload's first
 * action, an organiser confirm). Its button opens the window in that click.
 */
let _pending = $state<{ action: PasskeyWindowAction; blocked: boolean } | null>(null);
let _open: (() => OpenedWindow | null) | null = null;
let _resolve: ((opened: OpenedWindow | null) => void) | null = null;

function settle(opened: OpenedWindow | null): void {
  const resolve = _resolve;
  _resolve = null;
  _open = null;
  _pending = null;
  resolve?.(opened);
}

export const passkeyWindowSheet: PasskeySheet & {
  readonly pending: { action: PasskeyWindowAction; blocked: boolean } | null;
  proceed(): void;
  dismiss(): void;
} = {
  get pending() {
    return _pending;
  },

  request(action, open) {
    settle(null);
    _pending = { action, blocked: false };
    _open = open;
    return new Promise((resolve) => {
      _resolve = resolve;
    });
  },

  /** The sheet's Continue. Synchronous, inside its click: that is what lets it open. */
  proceed() {
    if (!_open || !_pending) return;
    const opened = _open();
    if (!opened) {
      _pending = { ..._pending, blocked: true };
      return;
    }
    settle(opened);
  },

  dismiss() {
    settle(null);
  },
};
