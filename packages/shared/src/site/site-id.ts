// ---------------------------------------------------------------------------
// Site ids that prove their owner
// ---------------------------------------------------------------------------
//
// A site id used to be a random string, and who owned it was whatever a pointer
// the SERVER wrote on Swarm said. A pointer that read as absent (a lapsed batch,
// a lost chunk) let the next account to publish under that id be stamped owner.
//
// A v2 id is derived from its owner's account address, so ownership is checked
// by arithmetic: no record to lose, no read to fail, nothing the server could
// rewrite. Anyone holding an id and an address can check it.
//
// FROZEN: the label, the preimage layout and the tag length are the identity of
// every site made with them. A change orphans those sites from their owners
// (`packages/shared/test/site-id.test.ts` pins a vector).

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

const LABEL = "woco/site-id/v2";
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const NONCE_RE = /^[0-9a-f]{12}$/;
const OWNED_SITE_ID_RE = /^s2-([0-9a-f]{12})-([0-9a-f]{40})$/;

/** 20 bytes. Addresses can be ground, so a taker has to match the whole tag. */
const TAG_BYTES = 20;

function tagFor(owner: string, nonce: string): string {
  return bytesToHex(keccak_256(utf8ToBytes(`${LABEL}:${owner}:${nonce}`)).subarray(0, TAG_BYTES));
}

/** Has this id the v2 shape? Says nothing about whose it is. */
export function isOwnedSiteIdShape(siteId: string): boolean {
  return typeof siteId === "string" && OWNED_SITE_ID_RE.test(siteId);
}

/** The v2 site id of `owner` for `nonce` (12 lowercase hex characters). */
export function ownedSiteId(owner: string, nonce: string): string {
  const address = typeof owner === "string" ? owner.toLowerCase() : "";
  if (!ADDRESS_RE.test(address)) throw new Error("site id needs the owner's account address");
  if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) throw new Error("site id nonce must be 12 lowercase hex characters");
  return `s2-${nonce}-${tagFor(address, nonce)}`;
}

/** A fresh v2 site id for `owner`. */
export function newOwnedSiteId(owner: string): string {
  return ownedSiteId(owner, bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(6))));
}

/** Is `siteId` a v2 id made for `owner`? False for anything malformed; never throws. */
export function siteIdOwnedBy(siteId: string, owner: string): boolean {
  const match = typeof siteId === "string" ? OWNED_SITE_ID_RE.exec(siteId) : null;
  if (!match || typeof owner !== "string") return false;
  // No shape check on `owner`: an id is only ever made for a well-formed address,
  // so anything else has no tag that matches.
  return tagFor(owner.toLowerCase(), match[1]) === match[2];
}
