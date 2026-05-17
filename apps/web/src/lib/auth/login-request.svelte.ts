let _pending = $state(false);
let _context = $state<"attendee" | "creator" | undefined>(undefined);
let _resolve: ((success: boolean) => void) | null = null;

/**
 * Svelte 5 rune store for requesting login from anywhere in the app.
 * Components call loginRequest.request() and await the result.
 * The global LoginModal watches loginRequest.pending and resolves it.
 */
export const loginRequest = {
  get pending() { return _pending; },
  get context() { return _context; },

  /**
   * Request the user to log in.
   * Returns a promise that resolves to true (logged in) or false (cancelled).
   * Pass context: "attendee" to show the attendee-specific subtitle in the modal.
   */
  request(opts?: { context?: "attendee" | "creator" }): Promise<boolean> {
    if (_resolve) {
      _resolve(false);
    }
    _pending = true;
    _context = opts?.context;
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
    _context = undefined;
  },
};
