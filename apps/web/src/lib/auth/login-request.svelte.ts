let _pending = $state(false);
let _context = $state<"attendee" | "creator" | undefined>(undefined);
let _resolve: ((success: boolean) => void) | null = null;

// How many login modals are mounted. `request()` hands back a promise that only
// a modal can settle, so with none mounted the caller waits forever behind a
// spinner with no error, no timeout and no cancel — a hang that is invisible in
// review because it depends on the import graph rather than on any one file.
// That is not hypothetical: three such callers once shipped inside the
// deployed-builder-site bundle, which mounts no modal (#194). They were removed
// with the v1 claim rail, so nothing reaches this today; the counter is what
// stops the next one being a hang instead of a refusal.
let _modals = $state(0);

/**
 * Svelte 5 rune store for requesting login from anywhere in the app.
 * Components call loginRequest.request() and await the result.
 * The global LoginModal watches loginRequest.pending and resolves it.
 */
export const loginRequest = {
  get pending() { return _pending; },
  get context() { return _context; },

  /** True when some mounted modal can actually carry a login to a conclusion.
   *  Read it to decide whether to OFFER signing in — a surface without one
   *  should not tell people to. */
  get available() { return _modals > 0; },

  /** Called by a login modal on mount; the returned function unregisters it.
   *  Counted rather than a boolean so a screen that briefly mounts a second
   *  modal cannot unregister the first one on its way out. */
  register(): () => void {
    _modals += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      _modals -= 1;
    };
  },

  /**
   * Request the user to log in.
   * Returns a promise that resolves to true (logged in) or false (cancelled).
   * Pass context: "attendee" to show the attendee-specific subtitle in the modal.
   */
  request(opts?: { context?: "attendee" | "creator" }): Promise<boolean> {
    if (_resolve) {
      _resolve(false);
    }
    // No modal can settle this, so refuse instead of returning a promise that
    // never resolves. `false` is the value every caller already handles — it is
    // what a dismissed modal returns — so this needs nothing new of them.
    if (_modals === 0) {
      _resolve = null;
      _pending = false;
      _context = undefined;
      return Promise.resolve(false);
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
