/**
 * A holder signature asked for silently, with no owner key in memory to make it: the
 * confirm that came before has lapsed (a reload, the window closing). Starting a passkey
 * sheet instead would be one nobody tapped for, so the caller asks with a button. Its own
 * module so the background pointer can tell it apart without loading the auth store.
 */
export class HolderKeyLockedError extends Error {
  constructor() {
    super("Confirm it's you to finish this - nothing was signed.");
    this.name = "HolderKeyLockedError";
  }
}
