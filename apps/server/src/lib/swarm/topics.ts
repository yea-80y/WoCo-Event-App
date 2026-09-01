import { issuerRegistryTopicName } from "@woco/shared";
import { Topic } from "@ethersphere/bee-js";

/**
 * Feed topic helpers.
 * IMPORTANT: These strings are stable - changing them changes the feed address.
 */

const EVENT_NS = "woco/event";
const POD_NS = "woco/pod";

/**
 * Topic strings are path-shaped and a paged one ends in `/p{N}`. So a component
 * that may contain "/" reaches across that separator: series `abc/p1` at page 0
 * builds the same string as series `abc` at page 1, and one series' page 0 IS
 * another's page 1 (#197). Restricting the charset makes the collision
 * unrepresentable rather than unlikely — a 2-segment path cannot equal a
 * 3-segment one while no component holds a "/".
 *
 * Lowercase only. Uppercase would give two byte forms of one logical id, so
 * `Series-1` and `series-1` would address two feeds a reader sees as one name.
 * Everything passed here is already lowercase: ids are `crypto.randomUUID()`,
 * addresses are lowercased by their callers.
 */
const TOPIC_COMPONENT_RE = /^[0-9a-z-]{1,64}$/;

function component(value: string, name: string): string {
  if (typeof value !== "string" || !TOPIC_COMPONENT_RE.test(value)) {
    throw new Error(`Invalid feed topic ${name}: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * The ONLY way to build a paged topic. The `/p{N}` encoding lives here because a
 * call site that assembled the suffix by hand could pick a different one, and a
 * different string is a different feed — silently, with no error to notice.
 */
function pagedTopic(base: string, page: number): Topic {
  if (!Number.isInteger(page) || page < 0) {
    throw new Error(`Invalid feed topic page: ${JSON.stringify(page)}`);
  }
  return Topic.fromString(page === 0 ? base : `${base}/p${page}`);
}

/**
 * Creation-time gate for an organiser-chosen series id (#197). Reject rather
 * than sanitise: the id is committed inside a client-SIGNED manifest, so
 * rewriting it here would invalidate the signature, and once it reaches a feed
 * it is already in the topic space.
 *
 * Stricter than the component rule above only in setting a length floor, which
 * is sanity rather than security — the "/" exclusion is what closes the
 * collision. Both client mint sites emit `crypto.randomUUID()` (36 lowercase
 * chars), so this costs a legitimate publish nothing.
 */
export const isValidSeriesId = (id: unknown): id is string =>
  typeof id === "string" && /^[0-9a-z-]{8,64}$/.test(id);

export const topicEventDirectory = (page = 0) =>
  pagedTopic(`${EVENT_NS}/directory`, page);

export const topicEvent = (eventId: string) =>
  Topic.fromString(`${EVENT_NS}/${eventId}`);

/**
 * Platform-signed pointer feed → the current immutable directory-snapshot blob
 * (#37). Single O(1) page; the ONLY centralised piece of the chain-log directory.
 */
export const topicEventsSnapshot = () =>
  Topic.fromString(`${EVENT_NS}/directory/snapshot`);

// The v1 per-series claim feeds (woco/pod/editions|claims|claimers|
// pending-claims/{seriesId}) were retired with the v1 claim rail — the
// WoCoEventV2 contract is the ticket ledger. Their topic builders are gone so
// nothing can quietly write that namespace again; see git history for the
// exact strings if a migration ever needs to READ an old feed.

/**
 * User collection feed topic. Page 0 is the base topic; overflow entries
 * spill onto pages 1+ as `/pN` suffixes. Page 0 records `pageCount` so
 * readers know how many pages to fetch without probing.
 */
export const topicUserCollection = (ethAddress: string, page = 0) =>
  pagedTopic(
    `${POD_NS}/collection/${component(ethAddress.toLowerCase(), "ethAddress")}`,
    page,
  );

export const topicCreator = (creatorPodKey: string) =>
  Topic.fromString(`${POD_NS}/creator/${creatorPodKey}`);

/**
 * Per-organiser event index keyed by Ethereum address.
 * Written whenever an event is added to the directory (create or list).
 * Never removed from — so organiser's view is unaffected by public listing status.
 */
export const topicCreatorDirectory = (ethAddress: string, page = 0) =>
  pagedTopic(
    `${EVENT_NS}/creator/${component(ethAddress.toLowerCase(), "ethAddress")}`,
    page,
  );

// ---------------------------------------------------------------------------
// Profile feeds
// ---------------------------------------------------------------------------

const PROFILE_NS = "woco/profile";

export const topicProfileData = (ethAddress: string) =>
  Topic.fromString(`${PROFILE_NS}/data/${ethAddress.toLowerCase()}`);

export const topicProfileAvatar = (ethAddress: string) =>
  Topic.fromString(`${PROFILE_NS}/avatar/${ethAddress.toLowerCase()}`);

// ---------------------------------------------------------------------------
// Recovery escrow (PASSKEY_RECOVERY_PLAN §11.6). One sealed RecoveryEnvelope
// per Kernel account. Ciphertext only — encrypted to the guardian's X25519 key
// (the server feed signer never sees plaintext), so the feed being public is
// fine and the locked-out user can read it during recovery without auth.
// ---------------------------------------------------------------------------
const RECOVERY_NS = "woco/recovery";

export const topicRecovery = (kernelAddress: string) =>
  Topic.fromString(`${RECOVERY_NS}/${kernelAddress.toLowerCase()}`);

// Platform-signed PRESENCE HINT (RecoveryStatus). §13 moved the sealed escrow to a
// GUARDIAN-owned SOC that the UI can't read without the backup-wallet signature, so
// this small kernel-keyed doc records only that a protect happened (+ display
// hints). Untrusted convenience — it holds no escrow and no key.
export const topicRecoveryStatus = (kernelAddress: string) =>
  Topic.fromString(`${RECOVERY_NS}/status/${kernelAddress.toLowerCase()}`);
// ---------------------------------------------------------------------------
// Marketing feeds — pointer to the organiser's SEALED contact-list blob.
// The feed page holds only {swarmRef, count, updatedAt}; the blob itself is
// ECIES-sealed to the organiser's X25519 key (server never sees plaintext).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Issuer registry (issuer-curve migration PR 5b)
// ---------------------------------------------------------------------------

/** A parent's issuer-registry log — the parent-signed statement chain. Topic
 *  name derivation lives in shared (`issuerRegistryTopicName`) so third-party
 *  readers derive it with no server code. */
export const topicIssuerRegistry = (parentAddress: string) =>
  Topic.fromString(issuerRegistryTopicName(parentAddress));

const MARKETING_NS = "woco/marketing";

export const topicMarketingList = (ethAddress: string) =>
  Topic.fromString(`${MARKETING_NS}/list/${ethAddress.toLowerCase()}`);
