import type { SigningRequestInfo } from "@woco/shared";

let _pending = $state<SigningRequestInfo | null>(null);
let _resolve: ((approved: boolean) => void) | null = null;

/**
 * Svelte 5 rune store for managing signing confirmation dialogs.
 * Used by local account signing — shows EIP-712 details before signing.
 */
export const signingRequest = {
  get pending() { return _pending; },

  /**
   * Request user confirmation for a signing operation.
   * Returns a promise that resolves to true (approved) or false (cancelled).
   */
  request(info: SigningRequestInfo): Promise<boolean> {
    // If there's already a pending request, reject it
    if (_resolve) {
      _resolve(false);
    }

    _pending = info;
    return new Promise<boolean>((resolve) => {
      _resolve = resolve;
    });
  },

  /**
   * Called by the dialog component when the user clicks Sign or Cancel.
   */
  respond(approved: boolean): void {
    if (_resolve) {
      _resolve(approved);
      _resolve = null;
    }
    _pending = null;
  },
};
