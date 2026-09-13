/**
 * The campaign issuer (#476) — the only thing this server signs on the referral
 * rail, and the only state it keeps.
 *
 * WHAT IS NOT HERE is the point. There is no `.data` record of who referred
 * whom, no pending table and no badge index. A confirmation is written at
 * VERSION 0 of a topic keyed by the REFEREE, and a SOC is write-once: the first
 * write at a version wins and every later one is silently discarded with a 201.
 * "One referrer per referee, first confirmed wins" is therefore enforced by
 * Swarm, not by server state a restart can lose — and the read-back after every
 * write is what turns that silent discard into a visible refusal, because
 * paying a revenue share against the echo of a discarded write is the exact
 * failure this shape exists to prevent.
 *
 * The server holds three things Swarm cannot: the issuer key, the Stripe
 * onboarding flag (the one fact about a merchant that lives only in Stripe),
 * and an in-flight set so two simultaneous confirms for one referee do not both
 * spend postage racing for the same slot.
 *
 * ABSENT IS NEVER INFERRED FROM A FAULT. Every read here answers found /
 * absent / unavailable, and only `absent` licenses a write. `readSocPayload`
 * throws for everything except a bee not-found, so a throw is `unavailable` —
 * treating it as absence would write a confirmation over a slot that is already
 * spent, or re-issue a badge someone revoked.
 *
 * Everything touching Swarm is injected (`IssuerDeps`), for the reason the
 * evidence publisher injects its own: the properties worth pinning are the
 * FAILURE ones — a dead batch, a write that reports success and is not there, a
 * version probe that cannot answer — and a live bee cannot be asked to produce
 * any of them on demand. The live implementation is built lazily, so a
 * deployment without a campaign key never touches a signer.
 */

import {
  BADGE_FORMAT,
  CAMPAIGN_ISSUER_ADDRESS,
  LAST_VERSION_IN_BAND,
  REFERRAL_CONFIRMATION_FORMAT,
  REFERRER_INDEX_FORMAT,
  badgeTopic,
  campaignAccountSubject,
  contentFeedSocIdentifier,
  referralConfirmationTopic,
  referralStatementTopic,
  referrerIndexTopic,
  validateBadgeV1,
  validateReferralConfirmationV1,
  validateReferralStatementV1,
  validateReferrerIndexV1,
  versionedSocIdentifier,
  type BadgeV1,
  type Hex0x,
  type ReferralConfirmationV1,
  type ReferrerIndexV1,
  type VersionedFeedRead,
} from "@woco/shared";
import {
  campaignIssuerConfigured,
  getCampaignIssuerOwnerHex,
  getCampaignIssuerSigner,
  requirePostageBatch,
} from "../../config/swarm.js";
import { beeBatchState } from "../health/probes.js";
import {
  confirmContentFeedWrite,
  writeVersionedContentFeed,
  type ContentFeedWrite,
} from "../swarm/content-feed-write.js";
import {
  readBandedContentFeedJsonResult,
  readContentFeedJsonResult,
  readSocPayload,
} from "../swarm/soc-upload.js";

/**
 * Below this, nothing is written. A batch with no time left still ACCEPTS
 * uploads — a bee behind on the postage contract returns 201 for chunks nobody
 * has paid for — so the floor is what turns writing into a void into a refusal
 * the caller can retry.
 */
const MIN_BATCH_TTL_SECONDS = 3600;

/**
 * The early-adopter cohort. Defined here rather than imported because the
 * `@woco/shared` constant of that name belongs to the EAS rail this replaces.
 *
 * It is a platform-defined WINDOW, not clock math: epoch 0 is "the people who
 * were here first", and it moves when the platform says so, never on a date.
 */
const EARLY_ADOPTER_EPOCH = 0;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** A version-0 read: the three answers, never collapsed into two. */
export type SlotRead =
  | { status: "found"; bytes: Uint8Array }
  | { status: "absent" }
  | { status: "unavailable"; reason: string };

export type ConfirmResult =
  | { status: "confirmed"; record: ReferralConfirmationV1 }
  /** A confirmation already stands for this referee — the caller decides
   *  whether that is the idempotent repeat or a conflicting second referrer. */
  | { status: "already"; record: ReferralConfirmationV1 }
  | { status: "no-statement" }
  | { status: "retracted" }
  | { status: "unavailable"; reason: string };

export type RecordRead<T> =
  | { status: "found"; record: T }
  | { status: "absent" }
  | { status: "unavailable" };

// ---------------------------------------------------------------------------
// Injected world
// ---------------------------------------------------------------------------

export interface IssuerDeps {
  /** Latest version of a pinned-band feed — badges and the referee's statement. */
  readHead: (ownerHex: string, topic: string) => Promise<VersionedFeedRead>;
  /** Version 0 EXACTLY, by computed address. The first-confirmed-wins read. */
  readVersion0: (ownerHex: string, topic: string) => Promise<SlotRead>;
  readBanded: (
    ownerHex: string,
    topicForBand: (band: number) => string,
  ) => Promise<VersionedFeedRead & { band: number }>;
  writeFeed: (topic: string, bytes: Uint8Array) => Promise<ContentFeedWrite>;
  confirmWrite: (
    topic: string,
    bytes: Uint8Array,
    version: number,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  batchState: () => Promise<{ usable: boolean | null; ttl: number | null }>;
  now: () => number;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Read version 0 of a feed at its exact address.
 *
 * NOT a head read. Version 0 IS the truth for a confirmation, whatever versions
 * were written above it: a second writer who probed the head and appended would
 * land at version 1, and treating that as the answer would hand the referee to
 * whoever wrote last rather than whoever wrote first.
 */
async function liveReadVersion0(ownerHex: string, topic: string): Promise<SlotRead> {
  try {
    const bytes = await readSocPayload(ownerHex, hex(versionedSocIdentifier(contentFeedSocIdentifier(topic), 0)));
    return bytes ? { status: "found", bytes } : { status: "absent" };
  } catch (err) {
    // Everything except a bee not-found arrives here, and none of it is
    // evidence that the slot is free. The detail goes to the log, never to the
    // public health endpoint (an RPC or gateway URL rides in some messages).
    console.warn(`[campaign] version-0 read failed for ${topic}:`, err);
    return { status: "unavailable", reason: "slot read failed" };
  }
}

function liveDeps(): IssuerDeps {
  return {
    // `skipLegacy`: every campaign topic postdates versioning, so a legacy
    // chunk cannot exist and probing for one costs a guaranteed miss.
    readHead: (ownerHex, topic) => readContentFeedJsonResult(ownerHex, topic, 0, { skipLegacy: true }),
    readVersion0: liveReadVersion0,
    readBanded: readBandedContentFeedJsonResult,
    writeFeed: (topic, bytes) =>
      writeVersionedContentFeed({
        signer: getCampaignIssuerSigner(),
        topic,
        bytes,
        batchId: requirePostageBatch(),
      }),
    confirmWrite: (topic, bytes, version) =>
      confirmContentFeedWrite(getCampaignIssuerOwnerHex(), topic, bytes, version),
    batchState: async () => {
      const state = await beeBatchState();
      health.batchUsable = state.usable;
      health.batchTTL = state.ttl;
      return state;
    },
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

const health = {
  configured: false,
  confirmations: 0,
  alreadyConfirmed: 0,
  refused: 0,
  failed: 0,
  badges: 0,
  indexAppends: 0,
  indexFailed: 0,
  lastWriteAt: null as string | null,
  lastError: null as string | null,
  lastIndexError: null as string | null,
  lastSkipReason: null as string | null,
  batchUsable: null as boolean | null,
  batchTTL: null as number | null,
};

/**
 * Reasons are SHORT FIXED LABELS, never a caught error's message: `/api/health`
 * is public and ethers happily puts the keyed RPC URL in one. The detail is
 * logged instead, where an operator can read it and a stranger cannot.
 */
function unavailable(label: string, detail?: string): { status: "unavailable"; reason: string } {
  health.lastError = label;
  if (detail) console.warn(`[campaign] ${label}: ${detail}`);
  return { status: "unavailable", reason: label };
}

/** One confirm at a time per referee — see the header. */
const inFlight = new Set<string>();
/** One badge write at a time per address; `issueJoinedBadge` fires from several
 *  success paths at once and each would otherwise read the same absent slot. */
const badgesInFlight = new Set<string>();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export function startCampaignIssuer(): void {
  health.configured = campaignIssuerConfigured();
  if (!health.configured) {
    console.log("[campaign] CAMPAIGN_ISSUER_PRIVATE_KEY unset — referrals cannot be confirmed and no badge is issued");
    return;
  }

  // The key and the address clients read must be one identity. A mismatch does
  // not fail: it writes perfectly valid records into an address space nobody
  // looks at, spends postage doing it, and reports success — so every referral
  // reads as unconfirmed while /api/health counts confirmations. Refusing is
  // the only honest answer, and it is louder than the alternative.
  const owner = `0x${getCampaignIssuerOwnerHex()}`;
  if (owner !== CAMPAIGN_ISSUER_ADDRESS.toLowerCase()) {
    health.configured = false;
    health.lastSkipReason = `key derives ${owner}, clients read ${CAMPAIGN_ISSUER_ADDRESS}`;
    console.error(
      `\n[campaign] FATAL (feature off): CAMPAIGN_ISSUER_PRIVATE_KEY derives ${owner}, but clients read ` +
      `CAMPAIGN_ISSUER_ADDRESS ${CAMPAIGN_ISSUER_ADDRESS}.\nEither restore the matching key or update the shared ` +
      `constant. Confirmations answer 503 and badges are not issued.\n`,
    );
    return;
  }

  console.log(`[campaign] confirming referrals and issuing badges as ${owner}`);
}

// ---------------------------------------------------------------------------
// Confirming a referral
// ---------------------------------------------------------------------------

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Confirm that `referee` reached the state the campaign pays for, and write the
 * record that says so.
 *
 * The caller has already established that the referee is authenticated and that
 * their Stripe onboarding is complete — the two facts Swarm cannot carry.
 * Everything else is read from chunks, in an order that spends nothing until
 * every precondition holds.
 */
export async function confirmReferral(
  args: { referee: string; refereeFeed: string; referrer: string },
  deps: IssuerDeps = liveDeps(),
): Promise<ConfirmResult> {
  // `health.configured`, not `campaignIssuerConfigured()`: a key that is SET
  // but derives the wrong address is exactly the deployment boot refused, and
  // every entry point here has to honour that refusal or the boot check only
  // protects the route that happens to consult it.
  if (!health.configured) return unavailable("issuer not configured");

  const referee = args.referee.toLowerCase() as Hex0x;
  const refereeFeed = args.refereeFeed.toLowerCase() as Hex0x;
  const referrer = args.referrer.toLowerCase() as Hex0x;

  // A second confirm while the first is mid-flight would read the same empty
  // slot and both would pay postage for a race only one can win.
  if (inFlight.has(referee)) return unavailable("confirmation in flight");
  inFlight.add(referee);
  try {
    const state = await deps.batchState();
    if (state.usable === false || (state.ttl !== null && state.ttl < MIN_BATCH_TTL_SECONDS)) {
      health.lastSkipReason = `postage batch unusable or expiring (usable=${state.usable}, ttl=${state.ttl})`;
      return unavailable("postage batch unusable or expiring");
    }
    health.lastSkipReason = null;

    const issuerOwner = getCampaignIssuerOwnerHex();
    const topic = referralConfirmationTopic(campaignAccountSubject(referee));

    const slot = await deps.readVersion0(issuerOwner, topic);
    if (slot.status === "unavailable") return unavailable("confirmation read unavailable", slot.reason);
    if (slot.status === "found") {
      const existing = parseJson(slot.bytes);
      if (validateReferralConfirmationV1(existing)) {
        health.alreadyConfirmed++;
        return { status: "already", record: existing };
      }
      // Version 0 is spent and holds something this issuer would never have
      // written. No later version can fix it — the slot is the record — so this
      // is permanent for this referee and has to be loud rather than retried.
      console.error(`[campaign] foreign bytes at the confirmation slot for ${referee} — this referee can never confirm`);
      return unavailable("foreign bytes at the confirmation slot");
    }

    const subject = campaignAccountSubject(referrer);
    let statementRead: VersionedFeedRead;
    try {
      statementRead = await deps.readHead(refereeFeed, referralStatementTopic(subject));
    } catch (err) {
      // Same as the badge read: a throw is a fault, and a fault is never
      // absence — but it is also not a 500 the referee can act on.
      return unavailable("statement read threw", err instanceof Error ? err.message : String(err));
    }
    if (statementRead.status === "unavailable") {
      return unavailable("statement read unavailable", statementRead.reason);
    }
    if (statementRead.status === "absent") return { status: "no-statement" };
    // A dirty scan's "found" is a LOWER BOUND on the version, and a retraction
    // is a later version — so `value: true` from an inconclusive scan cannot
    // tell a live referral from one retracted since. On a rail that decides a
    // revenue share that has to read as "ask again", not as consent.
    if (!statementRead.scanClean) return unavailable("statement read inconclusive");

    const statement = parseJson(statementRead.bytes);
    if (!validateReferralStatementV1(statement) || statement.subject !== subject) {
      return { status: "no-statement" };
    }
    if (!statement.value) return { status: "retracted" };

    const record: ReferralConfirmationV1 = {
      format: REFERRAL_CONFIRMATION_FORMAT,
      referee,
      refereeFeed,
      referrer,
      confirmedAt: new Date(deps.now()).toISOString(),
    };
    // A record this issuer cannot validate is a bug in this function, not a
    // condition to report: writing it would put bytes at a write-once address
    // that every reader refuses and no later write can replace.
    if (!validateReferralConfirmationV1(record)) {
      throw new Error(`[campaign] built an invalid confirmation for ${referee}`);
    }
    const bytes = new TextEncoder().encode(JSON.stringify(record));

    const write = await deps.writeFeed(topic, bytes);
    if (!write.ok) return unavailable("confirmation write failed", write.reason);
    if (write.unchanged || write.version !== 0) {
      // The slot read absent and the writer still found a head: something
      // landed at version 0 between the two reads. Whatever this write became,
      // it is not the confirmation of record and must never be counted as one.
      console.error(`[campaign] confirmation for ${referee} wrote version ${write.version} — slot was not empty`);
      return unavailable("confirmation slot was not empty");
    }

    const confirmed = await deps.confirmWrite(topic, bytes, 0);
    if (!confirmed.ok) {
      // Upload reported success and the chunk is not there: the shape a dead
      // batch takes. Nothing is confirmed, and the referee may retry.
      health.failed++;
      console.error(`[campaign] read-back failed for ${referee}: ${confirmed.reason}`);
      return unavailable("confirmation read-back failed");
    }

    health.confirmations++;
    health.lastWriteAt = new Date(deps.now()).toISOString();

    // The index is a CONVENIENCE for the referrer's dashboard — every entry is
    // re-derivable from the confirmations themselves — so its failure is
    // recorded and does not unmake a confirmation that is already on Swarm.
    await appendReferrerIndex(referrer, referee, deps);

    // A confirmed referral is a first meaningful action for both parties.
    void issueBadge(referee, deps);
    void issueBadge(referrer, deps);

    return { status: "confirmed", record };
  } finally {
    inFlight.delete(referee);
  }
}

// ---------------------------------------------------------------------------
// The referrer's index
// ---------------------------------------------------------------------------

/**
 * Add `referee` to the referrer's list of confirmed referees.
 *
 * BANDED, unlike everything else here: it gains a version per confirmation and
 * nothing is ever removed, so it has a real growth axis and must respect the
 * full-band invariant — the last slot of a band is the opener's signal that the
 * next band exists.
 *
 * A read-modify-write, which is why an inconclusive scan refuses: writing the
 * subjects this reader could see over a head it could not confirm is how a list
 * silently loses everything added since.
 */
export async function appendReferrerIndex(
  referrer: string,
  referee: string,
  deps: IssuerDeps = liveDeps(),
): Promise<void> {
  const referrerSubject = campaignAccountSubject(referrer);
  const refereeSubject = campaignAccountSubject(referee);
  const topicForBand = (band: number): string => referrerIndexTopic(referrerSubject, band);

  const noteFailure = (label: string, detail?: string): void => {
    health.indexFailed++;
    health.lastIndexError = label;
    if (detail) console.warn(`[campaign] referrer index ${label}: ${detail}`);
  };

  const issuerOwner = getCampaignIssuerOwnerHex();
  let current: VersionedFeedRead & { band: number };
  try {
    current = await deps.readBanded(issuerOwner, topicForBand);
  } catch (err) {
    // The banded read walks openers through a probe that THROWS on any fault
    // but not-found. This runs after the confirmation is already on Swarm, so
    // a throw here must be a recorded index failure, never an error response
    // for a referral that did in fact confirm.
    noteFailure("read threw", err instanceof Error ? err.message : String(err));
    return;
  }
  if (current.status === "unavailable") {
    noteFailure("read unavailable", current.reason);
    return;
  }

  let subjects: Hex0x[];
  let targetBand: number;
  if (current.status === "found") {
    if (!current.scanClean) {
      noteFailure("read inconclusive");
      return;
    }
    const existing = parseJson(current.bytes);
    if (!validateReferrerIndexV1(existing)) {
      // Foreign bytes at an address we own: appending would mean inventing the
      // predecessor list, so the append stops and says so.
      noteFailure("foreign bytes at the index head");
      return;
    }
    if (existing.subjects.includes(refereeSubject)) return;
    subjects = [...existing.subjects, refereeSubject];
    targetBand = current.version >= LAST_VERSION_IN_BAND ? current.band + 1 : current.band;
  } else {
    subjects = [refereeSubject];
    targetBand = 0;
  }

  const next: ReferrerIndexV1 = { format: REFERRER_INDEX_FORMAT, subjects };
  const bytes = new TextEncoder().encode(JSON.stringify(next));
  const topic = topicForBand(targetBand);

  const write = await deps.writeFeed(topic, bytes);
  if (!write.ok) {
    noteFailure("write failed", write.reason);
    return;
  }
  if (write.unchanged) return;

  const confirmed = await deps.confirmWrite(topic, bytes, write.version);
  if (!confirmed.ok) {
    noteFailure("read-back failed", confirmed.reason);
    return;
  }
  health.indexAppends++;
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

/** The campaign window a badge is minted into — see {@link EARLY_ADOPTER_EPOCH}. */
export function currentEpoch(): number {
  const raw = process.env.CAMPAIGN_EPOCH;
  const n = raw === undefined ? EARLY_ADOPTER_EPOCH : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : EARLY_ADOPTER_EPOCH;
}

/**
 * Issue the Joined badge for `address`, once ever. Never throws — every caller
 * fires it from a success path that must not fail because a badge did.
 *
 * A badge feed is LATEST-WINS, so this reads the head rather than version 0: a
 * revocation is a later version, and re-issuing over one would undo the abuse
 * escape hatch the format exists to provide. Any valid badge already there —
 * granted or revoked — ends the attempt.
 */
export async function issueBadge(address: string, deps: IssuerDeps = liveDeps()): Promise<void> {
  const addr = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return;
  // Boot-accepted, not merely set — `events.ts` fires this on every publish,
  // so this is the entry point a mismatched key would most quietly leak
  // through, writing badges into an address space no client reads.
  if (!health.configured) return;
  if (badgesInFlight.has(addr)) return;
  badgesInFlight.add(addr);
  try {
    const subject = campaignAccountSubject(addr);
    const topic = badgeTopic(subject, "joined");
    const issuerOwner = getCampaignIssuerOwnerHex();

    const head = await deps.readHead(issuerOwner, topic);
    if (head.status === "unavailable") {
      // Not an error worth counting: the next qualifying action retries, which
      // is how this rail has always recovered from a read it could not make.
      console.warn(`[campaign] badge read unavailable for ${addr}: ${head.reason ?? "unavailable"}`);
      return;
    }
    if (head.status === "found") {
      if (!validateBadgeV1(parseJson(head.bytes))) {
        console.error(`[campaign] foreign bytes at the badge feed for ${addr} — not overwriting`);
      }
      return;
    }

    const state = await deps.batchState();
    if (state.usable === false || (state.ttl !== null && state.ttl < MIN_BATCH_TTL_SECONDS)) {
      health.lastSkipReason = `postage batch unusable or expiring (usable=${state.usable}, ttl=${state.ttl})`;
      return;
    }

    const badge: BadgeV1 = {
      format: BADGE_FORMAT,
      subject,
      badge: "joined",
      epoch: currentEpoch(),
      value: true,
    };
    if (!validateBadgeV1(badge)) {
      console.error(`[campaign] built an invalid badge for ${addr}`);
      return;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(badge));

    const write = await deps.writeFeed(topic, bytes);
    if (!write.ok) {
      console.warn(`[campaign] badge write failed for ${addr}: ${write.reason}`);
      return;
    }
    if (write.unchanged || write.version !== 0) return;

    const confirmed = await deps.confirmWrite(topic, bytes, 0);
    if (!confirmed.ok) {
      console.error(`[campaign] badge read-back failed for ${addr}: ${confirmed.reason}`);
      return;
    }
    health.badges++;
    health.lastWriteAt = new Date(deps.now()).toISOString();
  } catch (err) {
    console.error(`[campaign] badge issue threw for ${addr}:`, err);
  } finally {
    badgesInFlight.delete(addr);
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The confirmation of record for a referee, if one stands. */
export async function readConfirmation(
  referee: string,
  deps: IssuerDeps = liveDeps(),
): Promise<RecordRead<ReferralConfirmationV1>> {
  if (!health.configured) return { status: "unavailable" };
  const topic = referralConfirmationTopic(campaignAccountSubject(referee.toLowerCase()));
  const slot = await deps.readVersion0(getCampaignIssuerOwnerHex(), topic);
  if (slot.status === "unavailable") return { status: "unavailable" };
  if (slot.status === "absent") return { status: "absent" };
  const record = parseJson(slot.bytes);
  // Foreign bytes read as unavailable, not absent: something IS at the slot,
  // and telling the caller "not confirmed" would invite a retry that cannot
  // ever succeed.
  if (!validateReferralConfirmationV1(record)) return { status: "unavailable" };
  return { status: "found", record };
}

/** An address's Joined badge — head read, because a revocation is a later version. */
export async function readBadge(
  address: string,
  deps: IssuerDeps = liveDeps(),
): Promise<RecordRead<BadgeV1>> {
  if (!health.configured) return { status: "unavailable" };
  const topic = badgeTopic(campaignAccountSubject(address.toLowerCase()), "joined");
  let head: VersionedFeedRead;
  try {
    head = await deps.readHead(getCampaignIssuerOwnerHex(), topic);
  } catch (err) {
    // A head read can throw past the probe (`readSocPayload` throws every
    // fault but not-found). There is no global error handler, so an uncaught
    // throw here is a bare 500 for a public read that should say "try again".
    console.warn(`[campaign] badge read threw for ${address}:`, err);
    return { status: "unavailable" };
  }
  if (head.status === "unavailable") return { status: "unavailable" };
  if (head.status === "absent") return { status: "absent" };
  const record = parseJson(head.bytes);
  if (!validateBadgeV1(record)) return { status: "unavailable" };
  return { status: "found", record };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/** A request the gates turned away before any read — see `routes/campaign.ts`. */
export function noteRefusal(): void {
  health.refused++;
}

/**
 * Whether boot accepted this deployment's key. Distinct from
 * `campaignIssuerConfigured()`, which only says a key is SET: a key that
 * derives an address clients do not read is configured and still must not
 * write.
 */
export function campaignIssuerReady(): boolean {
  return health.configured;
}

/**
 * Issuer liveness for `/api/health`. Addresses and counts only: the endpoint is
 * public, and every address here is already public on Swarm.
 */
export function campaignIssuerHealth(): Record<string, unknown> {
  return { ...health, issuer: CAMPAIGN_ISSUER_ADDRESS, inFlight: inFlight.size };
}

/**
 * Test seam — drops counters and both in-flight sets without touching Swarm.
 * `configured` is the boot decision, and a test that exercises a write path
 * has to say so: the default is the refused state, so a test cannot pass by
 * forgetting that boot exists.
 */
export function __resetIssuer(opts: { configured?: boolean } = {}): void {
  inFlight.clear();
  badgesInFlight.clear();
  Object.assign(health, {
    configured: opts.configured ?? false,
    confirmations: 0,
    alreadyConfirmed: 0,
    refused: 0,
    failed: 0,
    badges: 0,
    indexAppends: 0,
    indexFailed: 0,
    lastWriteAt: null,
    lastError: null,
    lastIndexError: null,
    lastSkipReason: null,
    batchUsable: null,
    batchTTL: null,
  });
}
