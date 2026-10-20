/**
 * One deploy at a time per site or event page, on this server (#943).
 *
 * A deploy resolves its pointer feed's next index BEFORE it uploads the
 * collection, so that a refusal there costs nothing. That index is then held for
 * the whole upload. Two deploys of the same feed overlapping in that window would
 * resolve the same index, and the second update would land on a taken one -
 * which keeps the first's bytes and still answers 201 (#186), while its response
 * reports its own build. This server resolves every one of those indices (it
 * writes the platform-signed updates and hands the client-owned ones their
 * index), so refusing the overlap here closes the window. No waiting: the second
 * request is told to try again once the first is done.
 */

const inFlight = new Set<string>();

export const DEPLOY_IN_PROGRESS_CODE = "DEPLOY_IN_PROGRESS";
export const DEPLOY_IN_PROGRESS_MESSAGE = "This is already being published - wait for it to finish, then try again.";

/**
 * How long a release keeps the key after a deploy that handed its pointer index to
 * the CLIENT: the client signs and posts that index a second or two after the
 * response, so a second deploy resolving in that gap would get the same index
 * (Fable sign-off on #946, F1).
 */
export const CLIENT_POINTER_HOLD_MS = 10_000;

/**
 * Claim `key` for one deploy: the release function, or null when one is running.
 * `release(holdMs)` keeps the key claimed for `holdMs` more (see CLIENT_POINTER_HOLD_MS).
 */
export function beginDeploy(key: string): ((holdMs?: number) => void) | null {
  if (inFlight.has(key)) return null;
  inFlight.add(key);
  let released = false;
  return (holdMs = 0) => {
    if (released) return;
    released = true;
    if (holdMs > 0) setTimeout(() => inFlight.delete(key), holdMs).unref();
    else inFlight.delete(key);
  };
}
