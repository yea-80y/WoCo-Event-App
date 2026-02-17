let _pending = $state(false);
let _resolve: ((success: boolean) => void) | null = null;

/**
 * Svelte 5 rune store for requesting login from anywhere in the app.
 * Components call loginRequest.request() and await the result.
 * The global LoginModal watches loginRequest.pending and resolves it.
 */
export const loginRequest = {
  get pending() { return _pending; },

  /**
   * Request the user to log in.
   * Returns a promise that resolves to true (logged in) or false (cancelled).
   */
  request(): Promise<boolean> {
    // If there's already a pending request, reject it
    if (_resolve) {
      _resolve(false);
    }

    _pending = true;
    return new Promise<boolean>((resolve) => {
      _resolve = resolve;
    });
  },

  /**
   * Called by LoginModal when login completes or is cancelled.
   */
  resolve(success: boolean): void {
    if (_resolve) {
      _resolve(success);
      _resolve = null;
    }
    _pending = false;
  },
};
