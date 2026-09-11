/**
 * On-chain event-id resolver. The CHAIN is the source of truth; this is a
 * rebuildable CACHE (not authoritative state) with three speed tiers:
 *
 *   1. in-memory map  — hot path, filled at registration → zero I/O on create→buy.
 *   2. .data store    — write-through JSON, loaded on startup so a RESTART/DEPLOY
 *                       does NOT pay a chain rebuild.
 *
 *                       ⚠️ NOT a pure cache, despite starting life as one. Since
 *                       #424 the checkout refuses to charge for a series this
 *                       server has no registration record for, and
 *                       `byEventSeries` CANNOT be rebuilt from chain — the walk
 *                       populates `byManifestRef` only (the chain carries no
 *                       feed keys), and a registered series never re-enters the
 *                       tier-3 fill because its feed already carries an id.
 *                       Losing onchain-events.json therefore stops ALL sales
 *                       until it is restored. See CLAUDE.md's must-survive list.
 *   3. chain reconcile — slower fallback for a truly-cold miss (entry in neither
 *                       tier), then persisted so it's paid at most once.
 *
 * Why this exists: the money path detects an on-chain series via
 * `swarmManifestRef && onChainEventId`. Registration derives the id from the
 * REGISTRANT's nonce — the sponsor wallet's — so it is not recomputable from the
 * manifest. The exact shape differs per contract version (V2 hashed
 * `(sender, nonce)`; the ledger domain-separates by chain and contract) — see
 * `deriveEventId` below, which carries both. Reading
 * `onChainEventId` only from the organiser's client-signed event SOC is fragile (the
 * browser re-sign silently fails), which made every paid purchase fall to the dead v1
 * path → "Series not found" → refund. So the server resolves it from the chain and
 * caches it. The server owns no truth here and never signs the user's feed — same
 * "cache, not truth" philosophy as the likes projection.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AbiCoder, keccak256 } from "ethers";
import type { EventFeed } from "@woco/shared";
import { writeJsonAtomic } from "../marketing/persist.js";
import { getActiveChainId, getDeployedContract, getOnChainEvent, unhandledVersion } from "../chain/event-contract.js";
import type { EventContractVersion } from "../chain/event-contract.js";
import { getSponsorAddress } from "../chain/sponsor-wallet.js";

const DATA_DIR = join(process.cwd(), ".data");
const CACHE_FILE = join(DATA_DIR, "onchain-events.json");

/** `${eventId}|${seriesId}` → onChainEventId — the persisted hot-path cache. */
const byEventSeries = new Map<string, string>();
/**
 * lowercased onChainEventId → `${eventId}|${seriesId}` — the INVERSE of
 * `byEventSeries`, and nothing more.
 *
 * DERIVED STATE, NOT A SECOND STORE. It is rebuilt from `byEventSeries` in
 * `ensureLoaded` and maintained by `recordOnChainEventId`, which is the only
 * writer of either map. `onchain-events.json` keeps its exact persisted shape —
 * adding a second file to keep in sync with a must-survive store would be a new
 * way to lose the money path, and this index needs no durability: it is
 * reconstructible from the map beside it in O(n) at boot.
 *
 * WHY IT EXISTS: #435 puts `findKeyBoundTo` on every event cache hit, and the
 * linear scan it used to be was affordable only because it ran on the tier-3
 * cold path.
 */
const keyByOnChainEventId = new Map<string, string>();
/** lowercased on-chain manifestRef → onChainEventId — transient chain projection. */
const byManifestRef = new Map<string, string>();

let loaded = false;
let dirty = false;
let lastReconcileAt = 0;
let reconcileInFlight: Promise<void> | null = null;
const RECONCILE_THROTTLE_MS = 15_000;

function key(eventId: string, seriesId: string): string {
  return `${eventId}|${seriesId}`;
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const obj = JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as Record<string, string>;
    for (const [k, v] of Object.entries(obj)) {
      byEventSeries.set(k, v);
      // FIRST-WINS, matching the scan this index replaces: that scan returned the
      // first key in insertion order, and a file written before #433 can hold two
      // keys for one id. A silent change of WHICH key an old duplicate reports
      // would change which series the strip below spares.
      const lc = v.toLowerCase();
      if (!keyByOnChainEventId.has(lc)) keyByOnChainEventId.set(lc, k);
    }
    console.log(`[onchain-cache] Loaded ${byEventSeries.size} on-chain event ids from cache`);
  } catch {
    // No cache yet — it rebuilds from chain on demand.
  }
}

function persist(): void {
  if (!dirty) return;
  // Stays dirty on failure so the next record retries the whole map.
  if (writeJsonAtomic(CACHE_FILE, Object.fromEntries(byEventSeries), "onchain-cache")) {
    dirty = false;
  }
}

/**
 * Thrown when a write would move an existing binding. Named so a caller can
 * tell it apart from a transport failure: this one never succeeds on retry.
 */
export class RegistrationRebindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrationRebindError";
  }
}

/**
 * Record the id the contract assigned to a series (called right after the tx).
 *
 * REFUSES TO REBIND, in both directions: one on-chain event belongs to exactly
 * one `(eventId, seriesId)`, and one `(eventId, seriesId)` to exactly one
 * on-chain event. Re-recording the SAME id stays idempotent — `register-once`
 * replays a landed registration to heal a feed write that failed, and that path
 * depends on it.
 *
 * WHY THIS IS IN THE STORE AND NOT IN THE ROUTES (#433). This map is the anchor
 * the money path rests on: `routes/stripe.ts` refuses to charge for a series
 * whose claimed on-chain event contradicts the record, and `applyOnChainEventIds`
 * rewrites a feed to agree with it. An anchor is only an anchor if the attacker
 * cannot write it — and `confirm-chain` could, because it authorised the caller
 * against the ON-CHAIN event they named rather than the WoCo event they were
 * writing to. That route is gone, but the property belongs here, where it holds
 * for every caller that ever exists rather than for the two that exist today.
 *
 * It is the same invariant the tier-3 fill already enforced for itself via
 * `findKeyBoundTo` (see `applyOnChainEventIds`); this lifts it out of that one
 * call site.
 *
 * CHAIN CUTOVER: the key carries no chainId, so records from a previous chain
 * are stale rather than wrong. In practice this refusal does NOT fire on a flip —
 * `register-once` short-circuits on the stale record (and the route short-circuits
 * earlier still on the feed's own id) and hands back the dead id as "already
 * registered", so nothing reaches here to be refused. Wipe `onchain-events.json`
 * as part of any chain flip; that is required for the same underlying reason and
 * is on the cutover checklist (#423).
 *
 * @throws {RegistrationRebindError} when the key or the id is already bound
 *   elsewhere. Callers must NOT swallow it: it means two events disagree about
 *   who owns one on-chain registration, and continuing picks a winner silently.
 */
export function recordOnChainEventId(eventId: string, seriesId: string, onChainEventId: string): void {
  ensureLoaded();
  const k = key(eventId, seriesId);

  const existing = byEventSeries.get(k);
  if (existing) {
    // Idempotent replay — the landed-tx heal path in `register-once` relies on
    // this returning quietly.
    if (existing.toLowerCase() === onChainEventId.toLowerCase()) return;
    throw new RegistrationRebindError(
      `refusing to rebind ${eventId.slice(0, 8)}/${seriesId.slice(0, 8)}: already registered as ` +
      `${existing.slice(0, 10)}…, asked to record ${onChainEventId.slice(0, 10)}…`,
    );
  }

  const boundElsewhere = findKeyBoundTo(onChainEventId);
  if (boundElsewhere) {
    throw new RegistrationRebindError(
      `refusing to bind on-chain event ${onChainEventId.slice(0, 10)}… to ` +
      `${eventId.slice(0, 8)}/${seriesId.slice(0, 8)}: it is already bound to ${boundElsewhere}`,
    );
  }

  byEventSeries.set(k, onChainEventId);
  // The two maps move together or the reverse index lies — and a lying index
  // answers `findKeyBoundTo` with null, which is the exact answer that lets a
  // binding be stolen. Same statement, no await between them.
  keyByOnChainEventId.set(onChainEventId.toLowerCase(), k);
  dirty = true;
  persist();
}

/**
 * Zero-I/O lookup of an already-recorded registration (tiers 1+2 ONLY — never
 * walks the chain). This is the exactly-once guard for `register-on-chain`:
 * `recordOnChainEventId` runs before the feed write in `confirmSeriesOnChain`, so
 * a registration whose tx landed but whose feed update then failed is still found
 * here — including after a restart, since the map is `.data`-backed. Reading the
 * feed alone is NOT sufficient: two of the route's three resolution tiers
 * (`peekEventCache`, `readEventFeedSoc`) hand back a feed with no on-chain id
 * merged in, and the contract does not dedupe (`registerEvent` keys the id off a
 * sponsor-nonce counter, not the manifest), so a missed guard mints a SECOND
 * on-chain event. `applyOnChainEventIds` cannot serve as the guard: on a
 * genuinely-first registration its tier-3 miss triggers a full chain walk, which
 * would land on the publish hot path.
 */
/**
 * The `eventId|seriesId` key already bound to this on-chain event, if any.
 *
 * HOT-PATH SAFE, and it has to be: #435 calls this once per series on EVERY
 * event cache hit, not just on the tier-3 cold miss it was written for. It used
 * to be a linear scan of `byEventSeries`, which was affordable exactly because
 * of that cold-path-only claim — putting a scan on the read path would have made
 * the strip cost grow with the number of registrations the platform has ever
 * made. It is now an O(1) read of `keyByOnChainEventId`, which is derived from
 * the same map and maintained by the same single writer, so the answer is
 * identical to the scan's in every case (first-wins on a pre-#433 duplicate
 * included).
 */
export function findKeyBoundTo(onChainEventId: string): string | null {
  ensureLoaded();
  return keyByOnChainEventId.get(onChainEventId.toLowerCase()) ?? null;
}

export function lookupOnChainEventId(eventId: string, seriesId: string): string | null {
  ensureLoaded();
  return byEventSeries.get(key(eventId, seriesId)) ?? null;
}

/**
 * Every known registration as a chain→content resolution entry (inverts the
 * persisted `${eventId}|${seriesId}` → onChainEventId map). The directory-snapshot
 * full-rebuild uses this: the platform sponsor registers ALL events, so this map is
 * a complete enumerator of onChainEventId → {wocoEventId, seriesId}. `creatorFeedSigner`
 * is filled by the builder from the resolved feed (this cache doesn't carry it).
 */
export function getAllResolutionEntries(): Array<{ onChainEventId: string; wocoEventId: string; seriesId: string }> {
  ensureLoaded();
  const out: Array<{ onChainEventId: string; wocoEventId: string; seriesId: string }> = [];
  for (const [k, onChainEventId] of byEventSeries) {
    const sep = k.indexOf("|");
    if (sep === -1) continue;
    out.push({ onChainEventId, wocoEventId: k.slice(0, sep), seriesId: k.slice(sep + 1) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pending-registration markers
// ---------------------------------------------------------------------------

/**
 * A registerEvent tx in its broadcast window, journalled in TWO phases (#318):
 *
 *  1. INTENT — written with the reserved nonce BEFORE the tx is handed to the
 *     node (`txHash` absent). This write is load-bearing: if it cannot reach
 *     disk the broadcast is REFUSED, because a disk that fails writes is
 *     exactly the disk that loses the marker when the process dies with it —
 *     and an unjournalled broadcast is what lets a restart mint a second
 *     on-chain event for the same series.
 *  2. UPGRADE — the same entry gains `txHash` the moment the tx is broadcast
 *     (before `tx.wait`), so a crash, timeout or organiser retry in the
 *     confirmation window can RESOLVE that tx instead of sending another.
 *
 * `nonce` is what makes both shapes decidable after a crash: a hash-carrying
 * marker resolves by receipt; a hash-less one resolves by whether the nonce
 * slot was consumed and whether the manifest ever registered
 * (lib/event/registration-intent.ts).
 */
export interface PendingRegistration {
  /** Absent while only the INTENT is journalled — nonce reserved, broadcast unproven. */
  txHash?: string;
  nonce: number;
  chainId: number;
  /**
   * The manifest digest this registration is FOR, lowercased (#434). Load-bearing
   * despite being optional: it is what lets the tier-3 fill see that an on-chain
   * event resolved by manifestRef may belong to a registration in flight for
   * somebody else's series.
   *
   * ADDITIVE — a marker written before this field existed simply carries none and
   * matches nothing, which is the pre-#434 behaviour. That is acceptable here and
   * would not be for a durable record: markers live for the seconds or minutes of
   * a broadcast window, so the only markers that can lack it are the ones already
   * in flight across the deploy that adds it.
   */
  manifestRef?: string;
  /** ISO timestamp of the journal write — diagnostics only. */
  at: string;
}

const PENDING_FILE = join(DATA_DIR, "pending-registrations.json");

/** `${eventId}|${seriesId}` → the in-flight tx. */
const pending = new Map<string, PendingRegistration>();
let pendingLoaded = false;

function ensurePendingLoaded(): void {
  if (pendingLoaded) return;
  pendingLoaded = true;
  try {
    const obj = JSON.parse(readFileSync(PENDING_FILE, "utf-8")) as Record<string, PendingRegistration>;
    for (const [k, v] of Object.entries(obj)) pending.set(k, v);
    if (pending.size > 0) {
      console.log(`[onchain-cache] Loaded ${pending.size} pending registration(s)`);
    }
  } catch {
    // No pending markers — the normal case.
  }
}

function persistPending(): boolean {
  return writeJsonAtomic(PENDING_FILE, Object.fromEntries(pending), "onchain-pending");
}

/** Lowercased, and ABSENT rather than undefined — the marker is JSON on disk and
 *  `{"manifestRef": undefined}` is not a thing the file can carry. */
function refField(manifestRef?: string): { manifestRef?: string } {
  return manifestRef ? { manifestRef: manifestRef.toLowerCase() } : {};
}

/**
 * The `eventId|seriesId` key of a pending registration for this manifest digest,
 * if any — the guard the tier-3 fill needs (#434).
 *
 * SCANS, and that is right here where `findKeyBoundTo` needed an index: `pending`
 * holds only registrations inside their broadcast window, which is a handful at
 * the very worst and normally zero. An index over a map that is almost always
 * empty would be state to keep correct for no gain.
 *
 * A marker carrying no `manifestRef` (written before the field existed) matches
 * nothing — see `PendingRegistration`.
 */
export function findPendingKeyByManifestRef(manifestRef: string): string | null {
  ensurePendingLoaded();
  const needle = manifestRef.toLowerCase();
  for (const [k, v] of pending) {
    if (v.manifestRef && v.manifestRef.toLowerCase() === needle) return k;
  }
  return null;
}

/**
 * Journal the INTENT to broadcast at `nonce` — phase 1 of the #318 contract.
 * THROWS when the journal cannot be written, and the caller MUST treat that as
 * "do not broadcast": the write is the only thing standing between a crash and
 * an untraceable in-flight registerEvent. `writeJsonAtomic` is atomic, so a
 * failed write leaves the file without the entry — the in-memory copy is
 * removed to match before throwing.
 */
export function recordRegistrationIntent(
  eventId: string,
  seriesId: string,
  intent: { nonce: number; chainId: number },
  manifestRef?: string,
): void {
  ensurePendingLoaded();
  const k = key(eventId, seriesId);
  pending.set(k, { ...intent, ...refField(manifestRef), at: new Date().toISOString() });
  if (!persistPending()) {
    pending.delete(k);
    throw new Error("registration journal unwritable — refusing to broadcast registerEvent");
  }
}

/**
 * Upgrade the marker with the broadcast tx's hash — phase 2. MUST be called
 * before the tx can mine. A persist failure here is loud but NOT fatal: the tx
 * is already out, the in-memory marker serves this process, and the durable
 * intent from phase 1 still covers a crash (the hash-less marker resolves via
 * registration-intent.ts).
 */
export function recordPendingRegistration(
  eventId: string,
  seriesId: string,
  tx: { txHash: string; nonce: number; chainId: number },
  manifestRef?: string,
): void {
  ensurePendingLoaded();
  pending.set(key(eventId, seriesId), { ...tx, ...refField(manifestRef), at: new Date().toISOString() });
  if (!persistPending()) {
    console.error(
      `[onchain-cache] pending-registration upgrade for ${eventId}/${seriesId} not journalled — ` +
        "in-memory only; a crash now leaves the intent marker, which the intent resolver handles",
    );
  }
}

export function lookupPendingRegistration(eventId: string, seriesId: string): PendingRegistration | null {
  ensurePendingLoaded();
  return pending.get(key(eventId, seriesId)) ?? null;
}

/** Drop the marker once the tx is resolved (confirmed, reverted, or replaced). */
export function clearPendingRegistration(eventId: string, seriesId: string): void {
  ensurePendingLoaded();
  if (!pending.delete(key(eventId, seriesId))) return;
  if (!persistPending()) {
    // Non-fatal: a stale marker on disk resolves harmlessly on the next boot
    // (step 2 of register-once finds the recorded id first).
    console.warn(`[onchain-cache] could not persist marker clear for ${eventId}/${seriesId}`);
  }
}

// ---------------------------------------------------------------------------
// Rebind-conflict alarm (#434)
// ---------------------------------------------------------------------------

/**
 * Distinct `${eventId}|${seriesId}` keys whose confirm hit a
 * `RegistrationRebindError` since boot. In-memory and deliberately NOT persisted:
 * it is an alarm about the state of THIS process, and a restart is one of the
 * things an operator does about it.
 *
 * WHAT IT MEANS. Since #433 a registration whose on-chain event was already bound
 * to another series cannot complete: the confirm throws on every retry, the
 * pending marker is never cleared, and the only recovery is an operator restoring
 * `onchain-events.json` by hand. That is strictly better than the silent theft it
 * replaced, but it is invisible — the organiser sees a failing button and the
 * server logs an exception among thousands. A count on `/api/health` is the
 * difference between "somebody noticed" and "somebody noticed six weeks later".
 */
const rebindConflicts = new Set<string>();

/**
 * Record a wedged registration. Idempotent per key, so an organiser retrying the
 * same series ten times is one alarm, not ten — the number has to mean "how many
 * series are stuck", or nobody can act on it.
 */
export function noteRebindConflict(eventId: string, seriesId: string): void {
  const k = key(eventId, seriesId);
  if (rebindConflicts.has(k)) return;
  const first = rebindConflicts.size === 0;
  rebindConflicts.add(k);
  // Transition-only, the same rule as lib/health/probes.ts `noteVerdict`: one line
  // when the verdict crosses, nothing on the ticks in between. A line per retry is
  // a line nobody reads by the second day. Per-conflict detail is already in the
  // route's own error log; this one says an operator has work to do.
  if (first) {
    console.error(
      "[onchain-registry] ALARM: a series' registration is wedged behind a rebind conflict — " +
      "its confirm can never complete and its pending marker will not clear. " +
      "See /api/health onchainRegistry, and the register-on-chain errors for which one (#434)",
    );
  }
}

/**
 * `/api/health` section. Counts and a boolean ONLY — the endpoint is public, so
 * no event ids, no series ids, no error text.
 */
export function onchainRegistryHealth(): { ok: boolean; rebindConflicts: number } {
  return { ok: rebindConflicts.size === 0, rebindConflicts: rebindConflicts.size };
}

/**
 * Deterministic eventId for the sponsor's nth registration — MIRRORS THE
 * CONTRACT, and the two derivations differ by version:
 *
 *   v2     keccak256(abi.encode(msg.sender, nonce))
 *   ledger keccak256(abi.encode(block.chainid, address(this), msg.sender, nonce))
 *
 * The ledger domain-separates by chain and contract so ids cannot collide
 * across deployments. V2 did not, which is why a successor registering from
 * the same sponsor wallet reproduced its ids exactly (#423) — the very reason
 * the ledger changed shape.
 *
 * If this drifts from the contract the walk finds NOTHING, which the #318
 * resolver reads as "never registered" and answers with a duplicate
 * registration. It is pinned by test against both shapes.
 */
export function deriveEventId(
  version: EventContractVersion,
  sponsor: string,
  nonce: number,
  chainId: number,
  contractAddress: string,
): string {
  const abi = AbiCoder.defaultAbiCoder();
  switch (version) {
    case "ledger":
      return keccak256(
        abi.encode(
          ["uint256", "address", "address", "uint256"],
          [chainId, contractAddress, sponsor, nonce],
        ),
      );
    case "v2":
      return keccak256(abi.encode(["address", "uint256"], [sponsor, nonce]));
    case "v1":
      // V1 is never walked — guarded by the caller — but the case is spelled
      // out so a new version is a compile error rather than a silent v2 shape.
      throw new Error("deriveEventId: v1 registrations are not walked");
    default:
      return unhandledVersion(version, "deriveEventId");
  }
}

/**
 * Fold walked registrations into the manifestRef projection, FIRST-WRITER-WINS.
 *
 * The contract does not enforce that a `manifestRef` is unique — `registerEvent`
 * is permissionless and takes whatever digest it is handed — so two on-chain
 * events can carry the same one. This used to be a plain `set`, i.e.
 * last-writer-wins, which let anyone who registered a copy of an existing
 * manifest digest SHADOW the original in this projection.
 *
 * That matters because `findOnChainEventIdByManifestRef` is the positive arm of
 * the #318 intent resolver, whose NEGATIVE answer causes a re-broadcast, and
 * because the tier-3 fill resolves ids through this same map.
 *
 * First-wins is the right rule in both directions. The walk runs in ascending
 * nonce order, so the first entry seen is the EARLIEST registration — the one
 * that actually landed for that manifest, which is what the resolver is asking
 * about. It is also the only direction an attacker cannot choose: registering a
 * copied digest AFTER the victim is free, whereas getting in before them means
 * winning a race inside a crash window. And it is stable across re-walks, where
 * last-wins depended on iteration order.
 *
 * A repeat of the SAME id is just a re-walk (this map is process-lifetime state
 * and the walk restarts from nonce 0), so only a genuine collision warns.
 *
 * Exported so the rule is testable without a chain.
 */
export function indexWalkedRegistrations(
  into: Map<string, string>,
  walked: Array<{ id: string; manifestRef?: string | null }>,
): void {
  for (const { id, manifestRef } of walked) {
    if (!manifestRef) continue;
    const ref = manifestRef.toLowerCase();
    const existing = into.get(ref);
    if (existing === undefined) {
      into.set(ref, id);
      continue;
    }
    if (existing !== id) {
      console.warn(
        `[onchain-cache] duplicate on-chain manifestRef ${ref.slice(0, 10)}… — keeping the ` +
        `earlier registration ${existing.slice(0, 10)}… and ignoring ${id.slice(0, 10)}…. ` +
        `The chain does not enforce uniqueness; a later duplicate must not shadow the original`,
      );
    }
  }
}

/**
 * Walk EVERY sponsor registration on chain into `byManifestRef`. Bounded by
 * `organiserNonce` (exact count), batched. THROWS on any failure — a caller
 * that needs a definitive answer (the #318 intent resolver) must be able to
 * tell "walked and absent" from "could not walk"; only the lenient reconcile
 * wrapper below is allowed to swallow.
 */
async function walkChainRegistrations(): Promise<void> {
  const chainId = getActiveChainId();
  const deployed = getDeployedContract(chainId);
  if (!deployed) return;
  // V1 has no per-sponsor registration walk (no `eventEndTs`, different id
  // derivation), so it is genuinely out of scope. Every OTHER version must be
  // handled: this function's contract is that it THROWS rather than returns, so
  // callers can distinguish "walked and absent" from "could not walk". A silent
  // return for an unrecognised version reads as "absent" to the #318 intent
  // resolver, which then re-broadcasts and DUPLICATES a landed registration.
  if (deployed.version === "v1") return;
  if (deployed.version !== "v2" && deployed.version !== "ledger") {
    throw new Error(
      `walkChainRegistrations: unhandled contract version ${JSON.stringify(deployed.version)} — ` +
      `refusing to report registrations as absent`,
    );
  }
  const sponsor = getSponsorAddress();
  const { getOrganiserNonce } = await import("../chain/event-contract.js");
  const count = Number(await getOrganiserNonce(sponsor, chainId));
  const BATCH = 25;
  for (let start = 0; start < count; start += BATCH) {
    const ids = Array.from(
      { length: Math.min(BATCH, count - start) },
      (_, i) => deriveEventId(deployed.version, sponsor, start + i, chainId, deployed.address),
    );
    // No per-id catch: a dropped read here must fail the WALK, not read as an
    // absent registration (the intent resolver re-broadcasts on "absent").
    const events = await Promise.all(ids.map((id) => getOnChainEvent(id, chainId)));
    indexWalkedRegistrations(
      byManifestRef,
      ids.map((id, i) => ({ id, manifestRef: events[i]?.manifestRef })),
    );
  }
  console.log(`[onchain-cache] reconciled ${byManifestRef.size} on-chain events from chain`);
}

/**
 * Rebuild `byManifestRef` from the chain — throttled and best-effort. The
 * fallback tier for feed healing: the hot path + .data cache mean this rarely
 * runs (cold/uncached series only).
 */
async function reconcileFromChain(): Promise<void> {
  if (reconcileInFlight) return reconcileInFlight;
  if (Date.now() - lastReconcileAt < RECONCILE_THROTTLE_MS) return;
  reconcileInFlight = (async () => {
    try {
      await walkChainRegistrations();
    } catch (err) {
      console.error("[onchain-cache] reconcile failed:", err);
    } finally {
      lastReconcileAt = Date.now();
      reconcileInFlight = null;
    }
  })();
  return reconcileInFlight;
}

/**
 * Definitive "did a registration for this manifest ever land?" — the positive
 * arm of the #318 intent resolver. A cache hit answers immediately; otherwise
 * the FULL chain walk runs (no throttle, no swallowing) so that `null` means
 * "walked the sponsor's every registration and it is not there", never "the
 * walk didn't happen". Throws when the chain cannot be walked.
 */
export async function findOnChainEventIdByManifestRef(manifestRef: string): Promise<string | null> {
  const lc = manifestRef.toLowerCase();
  const hit = byManifestRef.get(lc);
  if (hit) return hit;
  await walkChainRegistrations();
  return byManifestRef.get(lc) ?? null;
}

/**
 * Fill each series' `onChainEventId` from cache/chain when the signed feed lacks it,
 * and STRIP one the server knows to be wrong. Hot path (cache hit) does NO chain
 * work; a cold miss triggers ONE throttled reconcile whose result is persisted.
 * Mutates and returns `feed`.
 *
 * On the strip: for Phase B events the feed is the CREATOR's client-signed SOC —
 * the server has no key for it and the client merges `onChainEventId` itself
 * (lib/event/service.ts). So that field is creator-controlled input, not server
 * state, and it used to be passed through untouched whenever it was present.
 * A creator could therefore point their series at ANOTHER organiser's on-chain
 * event; because an authorised sponsor may append slots to any event, each sale
 * then minted out of the victim's supply while payment landed with the attacker
 * (#424).
 *
 * `byEventSeries` is the server's OWN record, written by `recordOnChainEventId`
 * at registration and backed by `.data`. When it disagrees with the feed, the
 * feed is wrong, so the id is dropped rather than trusted.
 *
 * WHAT ACTUALLY HAPPENS TO A DROPPED SERIES — stated precisely, because it is
 * not what "drop" suggests: the fill below immediately re-fills it from that
 * same record, so an honest-but-stale feed is CORRECTED to the server's id and
 * a forged one is corrected away from the attacker's. It only ends up with no
 * id at all when the fill cannot resolve one, and that state is what
 * routes/stripe.ts already refuses to charge for. So the usual outcome is heal,
 * and refuse is the floor — both safe, but do not rely on "it lands unset".
 *
 * TWO STRIPS, NOT ONE (#435). The record lookup above is keyed on
 * `${feed.eventId}|${s.seriesId}`, and BOTH halves of that key come out of the
 * creator-signed SOC. `feed.eventId` is pinned to the id the feed was read under
 * (#426), but `s.seriesId` is not pinned to anything — the creator picks it. So a
 * creator who renames a series inside their own feed makes the lookup MISS, and a
 * miss is indistinguishable from "the server has no record", which passes an id
 * the server knows to be wrong straight through. The second strip therefore asks
 * the question the other way round — WHO is this id bound to? — and that question
 * does not care what the creator called the series.
 *
 * LIMITS, both real:
 *   · A series the server has no record for, whose id is bound to nothing at all,
 *     cannot be checked here. The money path carries a second, chain-backed check
 *     for that case (routes/stripe.ts), and delete-safety takes its count at the
 *     id the SERVER recorded rather than at the feed's (#435).
 *   · `byEventSeries` is NOT beyond a creator's reach. Tier 3 below resolves an
 *     id from the CREATOR-SUPPLIED `manifestRef` and persists it as a record —
 *     so a creator naming another series' manifestRef could otherwise have the
 *     server write the forged binding itself, after which this comparison would
 *     agree with it forever. That is why tier 3 refuses to bind an on-chain
 *     event already bound to a different series; without that guard, this tier
 *     is anchored on something the attacker can move.
 */
export async function applyOnChainEventIds(feed: EventFeed): Promise<EventFeed> {
  ensureLoaded();

  // Strip an id the server's own record contradicts (#424). Runs before the
  // fill below so a stripped series can be re-filled with the correct id.
  for (const s of feed.series) {
    if (!s.onChainEventId) continue;
    const k = key(feed.eventId, s.seriesId);
    const recorded = byEventSeries.get(k);
    if (recorded && recorded.toLowerCase() !== s.onChainEventId.toLowerCase()) {
      console.error(
        `[onchain-registry] REJECTED feed-supplied onChainEventId for ` +
        `${feed.eventId.slice(0, 8)}/${s.seriesId.slice(0, 8)}: feed says ` +
        `${s.onChainEventId.slice(0, 10)}… but this server registered ` +
        `${recorded.slice(0, 10)}… — dropping (see #424)`,
      );
      s.onChainEventId = undefined as unknown as typeof s.onChainEventId;
      continue;
    }

    // The same rejection asked from the other end (#435). The check above can
    // only fire when the lookup HITS, and `s.seriesId` is creator-chosen inside
    // the signed SOC — so renaming the series makes the lookup miss and carries
    // the wrong id through untouched. Asking who the ID is bound to does not care
    // what the creator called the series. An id bound to nobody is left alone:
    // see the LIMITS note above, and the consumers that read the server's own
    // record instead of the feed's field.
    const boundElsewhere = findKeyBoundTo(s.onChainEventId);
    if (boundElsewhere && boundElsewhere !== k) {
      console.error(
        `[onchain-registry] REJECTED feed-supplied onChainEventId for ` +
        `${feed.eventId.slice(0, 8)}/${s.seriesId.slice(0, 8)}: ` +
        `${s.onChainEventId.slice(0, 10)}… is bound to ${boundElsewhere} — ` +
        `dropping (a renamed seriesId dodging the record lookup, see #435)`,
      );
      s.onChainEventId = undefined as unknown as typeof s.onChainEventId;
    }
  }

  const missing = feed.series.filter((s) => !s.onChainEventId && s.manifestRef);
  if (missing.length === 0) return feed;

  // Tier 1/2: per-(event,series) cache (in-memory, backed by .data).
  for (const s of missing) {
    const cached = byEventSeries.get(key(feed.eventId, s.seriesId));
    if (cached) s.onChainEventId = cached as typeof s.onChainEventId;
  }
  const stillMissing = missing.filter((s) => !s.onChainEventId);
  if (stillMissing.length === 0) return feed;

  // Tier 3: rebuild from chain, then match by manifestRef + promote to the cache.
  const allKnown = stillMissing.every((s) => byManifestRef.has(s.manifestRef!.toLowerCase()));
  if (!allKnown) await reconcileFromChain();

  for (const s of stillMissing) {
    const id = byManifestRef.get(s.manifestRef!.toLowerCase());
    if (!id) continue;

    // One on-chain event belongs to exactly one series. This lookup is keyed by
    // the CREATOR-SUPPLIED `s.manifestRef`, so without this check a creator can
    // name another organiser's manifestRef, omit `onChainEventId`, and have the
    // server resolve the victim's id and PERSIST it as its own record — after
    // which the tier-1 comparison above agrees with the forgery forever,
    // because the record it trusts is the forged one (#424).
    // The same question asked of registrations that have NOT landed in the record
    // yet (#434). `findKeyBoundTo` can only see a binding that exists, and the
    // record is written by `confirmSeriesOnChain` AFTER the tx mines — so between
    // the mining and the confirm the victim's on-chain event is bound to nobody,
    // and this tier would happily hand it to whoever names the manifestRef first.
    // A pending marker is the server's own evidence that a registration for this
    // digest is in flight for somebody else's series, and it is evidence a
    // creator cannot write. Refusing costs the honest case nothing: the marker is
    // cleared the moment the confirm completes, after which tier 1/2 answers.
    const pendingElsewhere = findPendingKeyByManifestRef(s.manifestRef!);
    if (pendingElsewhere && pendingElsewhere !== key(feed.eventId, s.seriesId)) {
      console.error(
        `[onchain-registry] REFUSED to bind on-chain event ${id.slice(0, 10)}… to ` +
        `${feed.eventId.slice(0, 8)}/${s.seriesId.slice(0, 8)} — a registration for the same ` +
        `manifestRef is in flight for ${pendingElsewhere} (see #434)`,
      );
      continue;
    }

    const boundElsewhere = findKeyBoundTo(id);
    if (boundElsewhere && boundElsewhere !== key(feed.eventId, s.seriesId)) {
      console.error(
        `[onchain-registry] REFUSED to bind on-chain event ${id.slice(0, 10)}… to ` +
        `${feed.eventId.slice(0, 8)}/${s.seriesId.slice(0, 8)} — it is already bound to ` +
        `${boundElsewhere}. A manifestRef naming another series' event (see #424)`,
      );
      continue;
    }

    // Written through the guarded writer, NOT a raw `set`, so that "a binding is
    // only ever created by the guarded writer" is true of every path rather than
    // of most of them.
    //
    // WHAT THE CATCH IS ACTUALLY FOR — narrower than it looks, and worth stating
    // so nobody widens it later. The two refusal shapes cannot reach here by the
    // ordinary route: the key-already-bound case is filled by tier 1/2 above and
    // never enters `stillMissing`, and the id-bound-elsewhere case is caught by
    // `findKeyBoundTo` a few lines up. What remains is the await window — this
    // tier awaits a chain reconcile, so a registration can land between the map
    // read above and the write here. A raw `set` would silently overwrite it;
    // the writer refuses, and we log and move on.
    //
    // NOT COVERED BY A TEST, deliberately rather than by omission: reaching this
    // tier at all needs `byManifestRef`, which only a chain walk populates, and
    // reproducing the window needs concurrency injection on top. A refusal here
    // must therefore never be fatal to a feed READ, which has to return the rest
    // of the feed regardless.
    try {
      recordOnChainEventId(feed.eventId, s.seriesId, id);
      s.onChainEventId = id as typeof s.onChainEventId;
    } catch (err) {
      console.error(
        `[onchain-registry] could not bind ${feed.eventId.slice(0, 8)}/${s.seriesId.slice(0, 8)} ` +
        `to ${id.slice(0, 10)}…:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return feed;
}
