import type { SealedBox } from "../crypto/types.js";

/**
 * Marketing audience types.
 *
 * Trust model: the full contact list only ever exists in plaintext inside the
 * organiser's browser. It is sealed (ECIES) to the organiser's own X25519 key
 * before upload; the server persists only HMAC email hashes + metadata.
 * Plaintext emails transit the server transiently at import/check/send time
 * and are hashed-and-discarded — never stored.
 */

export interface MarketingContact {
  email: string;
  firstName?: string;
  lastName?: string;
  postcode?: string;
  /** ISO date string, as imported */
  dob?: string;
  /** Provenance, e.g. "csv:contacts.csv" */
  source?: string;
  /** ISO timestamp when added to the list */
  addedAt: string;
}

/** The plaintext payload that gets sealed to the organiser's X25519 key. */
export interface MarketingListPayload {
  version: 1;
  contacts: MarketingContact[];
}

export interface MarketingListMeta {
  count: number;
  updatedAt: string;
  /** Swarm reference of the sealed blob (hex, no 0x) — self-sovereign read path */
  swarmRef: string;
}

export interface MarketingListResponse {
  meta: MarketingListMeta;
  sealedList: SealedBox;
}

/** Import-wizard validation result for a batch of candidate emails. */
export interface MarketingCheckResult {
  /** Normalized (lowercase) emails suppressed for this organiser — will never receive */
  suppressed: string[];
  /** Normalized emails already present in the stored list */
  alreadyInList: string[];
}

export interface MarketingBroadcastResult {
  sent: number;
  suppressed: number;
  failed: number;
  /** Remaining sends in the organiser's rolling 24h cap */
  capRemaining: number;
  errors?: string[];
}

// ---------------------------------------------------------------------------
// Organiser sending domains (send marketing from the organiser's own domain)
// ---------------------------------------------------------------------------

/** Mirrors Resend's DomainStatus */
export type SendingDomainStatus =
  | "pending"
  | "verified"
  | "failed"
  | "temporary_failure"
  | "not_started";

/** One DNS record the organiser must add (from Resend's domain records) */
export interface SendingDomainRecord {
  record: string;
  name: string;
  value: string;
  type: string;
  ttl?: string;
  status?: string;
  priority?: number;
}

export interface SendingDomainInfo {
  domain: string;
  fromLocalPart: string;
  status: SendingDomainStatus;
  records: SendingDomainRecord[];
  /** Resolved from-address preview (verified domain or platform fallback) */
  fromAddress: string;
  createdAt: string;
}
