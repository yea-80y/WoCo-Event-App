/**
 * An event page's name, pointed with no second tap. The publish tap confirmed it's the
 * holder and put the owner key in memory (`ensureOrganiserUnlock({ holderKey })`); this
 * signs silently in the background once the deploy and the mint are done. Every way it
 * cannot finish hands back to the "Point it here" button - except a manifest that is not
 * this account's feed, which is refused with no button at all.
 */

import { ApiError } from "../api/errors.js";
import { HolderKeyLockedError } from "../auth/holder-key-locked.js";
import { FeedManifestMismatchError } from "../swarm/feed-manifest-address.js";
import type { PointerTypedData } from "./pointer-digest.js";

export type AutoPointOutcome =
  | { kind: "done" }
  /** Show the button, with the reason when there is one to show. */
  | { kind: "ask"; error?: unknown }
  | { kind: "refused"; error: unknown };

/** A name minted seconds ago can be missing on the RPC this device reads, and the
 *  registrar's digest reverts until it is there: worth a few spaced tries. */
export const ATTEMPTS = 4;
export const SPACING_MS = 2500;

export interface AutoPointDeps {
  /** `pointNameAtFeed`: checks the manifest is this account's feed, then signs and relays. */
  point: (
    label: string,
    manifest: string,
    feed: { owner: string; topic: string },
    sign: (typed: PointerTypedData) => Promise<string>,
  ) => Promise<unknown>;
  wait: (ms: number) => Promise<void>;
}

const liveDeps: AutoPointDeps = {
  point: async (...args) => (await import("./pointer.js")).pointNameAtFeed(...args),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function autoPointName(
  label: string,
  manifest: string,
  feed: { owner: string; topic: string },
  signSilently: (typed: PointerTypedData) => Promise<string>,
  deps: AutoPointDeps = liveDeps,
): Promise<AutoPointOutcome> {
  let last: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) await deps.wait(SPACING_MS);
    try {
      await deps.point(label, manifest, feed, signSilently);
      return { kind: "done" };
    } catch (e) {
      if (e instanceof FeedManifestMismatchError) return { kind: "refused", error: e };
      if (e instanceof HolderKeyLockedError) return { kind: "ask" };
      // The relay answered: of its refusals only an expired signature is worth signing again.
      if (e instanceof ApiError && e.code !== "signature_expired") return { kind: "ask", error: e };
      last = e;
    }
  }
  return { kind: "ask", error: last };
}
