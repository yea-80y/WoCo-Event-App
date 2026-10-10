/**
 * The device marker of an email -> passkey upgrade (#746, upgrade-to-passkey.ts):
 * what a resume needs and nothing secret - addresses, a credential id, subjects.
 * Its own small file so the store can look for one without loading the flow.
 */

import type { Hex0x } from "@woco/shared";
import type { PasskeyCredentialHandle } from "./passkey-account.js";

export interface UpgradeMarker {
  v: 1;
  parent: string;
  /** The email login's key - the account's owner until the switch. */
  emailKey: string;
  /** The feed signer of the old seed: where the likes and follows were. */
  oldFeedSigner: string;
  /** The new passkey's key, the only one on the list after the switch. */
  passkey: string;
  credential: PasskeyCredentialHandle;
  stage: "prepared" | "committed";
  /** Live under the old feed when prepared; moved once re-posted under the new one. */
  likes: Hex0x[];
  follows: Hex0x[];
  /** Every one of them reads `false` under the old feed now. */
  retracted: boolean;
}

const MARKER_PREFIX = "woco:passkey-upgrade:";
const ADDR = /^0x[0-9a-f]{40}$/;
const SUBJECT = /^0x[0-9a-f]{1,128}$/i;

export function upgradeMarkerKey(parent: string): string {
  return `${MARKER_PREFIX}${parent.toLowerCase()}`;
}

/** The marker, or null for none or for anything malformed - a resume rests on a well-formed record only. */
export function parseUpgradeMarker(raw: string | null | undefined): UpgradeMarker | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as Partial<UpgradeMarker>;
    const subjects = (xs: unknown): xs is Hex0x[] => Array.isArray(xs) && xs.every((x) => typeof x === "string" && SUBJECT.test(x));
    if (m.v !== 1 || (m.stage !== "prepared" && m.stage !== "committed")) return null;
    for (const a of [m.parent, m.emailKey, m.oldFeedSigner, m.passkey]) if (typeof a !== "string" || !ADDR.test(a)) return null;
    const c = m.credential;
    if (!c || typeof c.credentialId !== "string" || !c.credentialId || typeof c.rpId !== "string") return null;
    if (!subjects(m.likes) || !subjects(m.follows) || typeof m.retracted !== "boolean") return null;
    return m as UpgradeMarker;
  } catch {
    return null;
  }
}

export interface MarkerStore {
  read(parent: string): UpgradeMarker | null;
  write(marker: UpgradeMarker): void;
  clear(parent: string): void;
}

/** The marker in localStorage: it must outlive sign-out, which is when a resume happens. */
export const localMarkerStore: MarkerStore = {
  read: (parent) => {
    try {
      return parseUpgradeMarker(globalThis.localStorage?.getItem(upgradeMarkerKey(parent)));
    } catch {
      return null;
    }
  },
  write: (marker) => {
    globalThis.localStorage?.setItem(upgradeMarkerKey(marker.parent), JSON.stringify(marker));
  },
  clear: (parent) => {
    try {
      globalThis.localStorage?.removeItem(upgradeMarkerKey(parent));
    } catch {
      /* a stale marker is checked against the chain before it is acted on */
    }
  },
};
