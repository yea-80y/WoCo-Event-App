/**
 * Scanner state machine (Svelte 5 runes). Owns provisioning, the offline
 * pack, the nullifier set, and sync.
 *
 * Admission depends on the pass's door mode (#641):
 * - "single": this is the only device that can use the pass (the server binds it
 *   at provisioning), so it admits from its own set and works fully offline.
 * - "several": every admission is claimed at the server first - first scan
 *   anywhere wins - and a scan that cannot be confirmed does not admit.
 * A ticket is never admitted twice; "couldn't confirm" is the price of that.
 */

import {
  base64UrlDecode,
  decodeDoorPassToken,
  doorPassFragment,
  SCANNER_DEVICE_HEADER,
  SCANNER_OUTDATED_REASON,
  type DoorMode,
  type CheckinConflict,
  type CheckinPack,
  type CheckinRecord,
  type CheckinSyncResponse,
  type RosterEntry,
} from "@woco/shared";
import * as db from "./db.js";
import { decryptRoster } from "./roster-crypto.js";
import { verifyTicket } from "./verify.js";
import { claimAdmission, newClaimId, type ClaimAnswer } from "./claim.js";
import { admit, doorModeOf, EVENT_CHANGED_MESSAGE, withConfirmed, type Admission } from "./admission.js";
import {
  MISS_RECHECK_MS,
  onPackMiss,
  resolveMiss,
  PACK_REFRESH_MS,
  RETURN_REFRESH_MS,
  shouldAutoRefresh,
  ticketNewerThanPack,
  type RecheckResult,
} from "./pack-refresh.js";
import {
  bootFromFragment,
  setUpArrivedPass,
  takePassFromUrl,
  describePackFailure,
  onPassLink,
  isExpiredRefusal,
  NO_CONNECTION_MESSAGE,
  PASS_EXPIRED_MESSAGE,
  type DoorPass,
  type PackFailure,
} from "./pass-gate.js";
import { canApplyUpdate, UPDATE_RETRY_MS } from "./update-policy.js";
import { unsyncedElsewhere } from "./scope.js";
import { chooseEvent, eventMarker, hasExpired, isLive, liveEvents, parseEventMarker } from "./events.js";
import { takeoverIfNewer } from "./sw-update.js";
import {
  applyDoorEntriesPage,
  doorKeyMatches,
  emptyDoorEntries,
  fetchDoorEntriesPage,
  mergeDoorRoster,
  restoreDoorEntries,
  toStoredDoorEntries,
  type DoorEntriesState,
} from "./door-entries.js";

const API_BASE = import.meta.env.VITE_API_URL || "";
const SYNC_INTERVAL_MS = 30_000;
/** How often the background refresh considers running; PACK_REFRESH_MS decides whether it does. */
const REFRESH_TICK_MS = 15_000;
/** Pages of door entries one poll follows; the rest wait for the next tick. */
const MAX_ENTRY_PAGES = 40;

export type ScanOutcome =
  | { kind: "checked-in"; strength: "onchain"; seriesName: string; edition: number; attendee?: RosterEntry }
  | { kind: "duplicate"; record: CheckinRecord; seriesName?: string; edition: number; attendee?: RosterEntry }
  /** Genuine ticket whose sale was refunded (#645). Not admitted; no check-in recorded. */
  | { kind: "refunded"; seriesName: string; edition: number; attendee?: RosterEntry }
  | { kind: "rejected"; reason: string }
  /** Genuine ticket, but the server could not be asked or did not answer in
   *  time (#641). NOT admitted - with several scanners, another may hold it. */
  | { kind: "cant-confirm"; message: string; seriesName?: string; edition?: number; attendee?: RosterEntry }
  | { kind: "wrong-event" }
  | { kind: "unreadable" };

/** A pack request the server refused, or that never reached it. */
class PackError extends Error {
  constructor(readonly failure: PackFailure) {
    super(failure.message);
  }
}

export type ManualCheckinResult =
  | { kind: "checked-in" }
  | { kind: "duplicate"; record: CheckinRecord }
  | { kind: "refunded" }
  | { kind: "cant-confirm"; message: string };

class ScannerStore {
  phase = $state<"loading" | "unprovisioned" | "provisioning" | "ready" | "failed">("loading");
  provisionError = $state<string | null>(null);
  /** A pass from a link or QR that could not be set up yet: "Try again" retries it, no reload. */
  pendingPass = $state<{ token: string; keyB64url: string } | null>(null);

  pass = $state<db.StoredPass | null>(null);
  pack = $state<CheckinPack | null>(null);
  roster = $state<RosterEntry[]>([]);
  /**
   * This tab's event's door entries: buyers since the pass was made, their email and
   * card name (door-entries.ts). Display only - no door decision reads them.
   */
  doorEntries = $state.raw<DoorEntriesState>(emptyDoorEntries());
  /** The server seals new buyers to a key this pass link does not give: their names cannot show here. */
  doorKeyMismatch = $state(false);
  /** ticketKey → record; mirrors the IndexedDB nullifier set for the UI. */
  checkins = $state<Map<string, CheckinRecord>>(new Map());
  conflicts = $state<CheckinConflict[]>([]);

  online = $state(typeof navigator !== "undefined" ? navigator.onLine : true);
  syncing = $state(false);
  lastSyncAt = $state<string | null>(null);
  pendingCount = $state(0);
  /** Unsynced check-ins this phone holds for OTHER events; they sync only with their own pass. */
  otherUnsynced = $state(0);
  /** Events this phone can show (live passes), most recently used first: the switcher. */
  events = $state<{ eventId: string; title: string }[]>([]);
  /** Set when the server said the pass was revoked/expired — device must re-provision. */
  passDead = $state<string | null>(null);
  /** A server claim is in flight - the scan screen shows "checking" and pauses the camera. */
  claiming = $state(false);
  /** A scanned ticket is waiting for a newer pack - the scan screen shows "checking". */
  lookingUp = $state(false);

  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<boolean> | null = null;
  private lastRefreshAt = 0;
  /** When the pack now held was requested: how fresh its "no owner" answers are. 0 = unknown. */
  private packAsOf = 0;
  /** ticketKey → when this ticket was first found with no owner (resolveMiss). */
  private notFoundSince = new Map<string, number>();
  /** ticketKey → when a pack was fetched because that ticket was missing from it. */
  private rechecked = new Map<string, number>();
  private scanning = false;
  private syncingOthers = false;
  private listening = false;
  private lastScanAt = 0;
  /** A newer scanner has taken over this page and a reload into it is due. */
  private updateDue = false;
  private reloading = false;
  private deviceId = "";
  private entriesPolling: Promise<void> | null = null;
  /** `token|doorKeyRef` the key check last ran for: once per pass and key. */
  private doorKeyChecked: string | null = null;
  private cleaning: Promise<void> | null = null;
  private cleanAgain: Promise<void> | null = null;

  totalCapacity = $derived(this.pack?.series.reduce((n, s) => n + s.totalSupply, 0) ?? 0);
  /** The door's list: the organiser's roster, then later sales; an erased ticket shows nothing. */
  attendees = $derived(mergeDoorRoster(this.roster, this.doorEntries));
  doorMode = $derived<DoorMode>(doorModeOf(this.pack));
  checkedInCount = $derived(this.checkins.size);

  /**
   * Boot, and the boot screen's "Try again". A failure here - storage that will
   * not open - shows that screen with a retry, never an endless "Loading…", and
   * never offers to wipe anything: unsynced check-ins may be in that storage.
   */
  async init(): Promise<void> {
    this.listen();
    this.phase = "loading";
    // The pass leaves the URL before anything else can fail, and is held for the
    // boot below and its retries (f63e4641).
    const arrived = takePassFromUrl(location, history);
    if (arrived) this.pendingPass = arrived;
    try {
      await this.boot();
    } catch (err) {
      console.error("[scanner] could not start", err);
      this.phase = "failed";
    }
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener("online", () => {
      this.online = true;
      void this.sync();
      this.maybeAutoRefresh(RETURN_REFRESH_MS);
    });
    window.addEventListener("offline", () => (this.online = false));
    // A phone at the door spends most of its time with the screen off: the
    // interval does not run then, so coming back is when the pack is behind.
    document.addEventListener("visibilitychange", () => this.onReturn());
    window.addEventListener("focus", () => this.onReturn());
    // A pass link opened in this already-open tab.
    onPassLink(window, () => void this.passFromUrl());
  }

  private async boot(): Promise<void> {
    this.deviceId = await db.getDeviceId();

    // A pass from the URL always wins. If it fails, the phone stays on the
    // provision screen with it ready to retry: falling back to the stored pass
    // would open whatever event it held before.
    const held = this.pendingPass;
    if (held) {
      this.reprovision();
      this.pendingPass = held;
      await setUpArrivedPass(held, {
        newerVersion: () => takeoverIfNewer(),
        reload: () => this.reloadIntoNewVersion(),
        provision: (t, k) => this.provision(t, k),
      });
      return;
    }

    // This tab's own event (its URL marker), or on a fresh open the most recently
    // used live one. A tab never quietly becomes another event's door.
    const choice = chooseEvent(parseEventMarker(location.hash), await db.getAllPasses(), Date.now());
    await this.cleanUpEndedEvents();
    if (choice.kind === "open" && (await this.openEvent(choice.eventId))) return;
    if (choice.kind === "ended") {
      this.provisionError = choice.reason === "dead"
        ? `${choice.message}. Scan a new door pass from the organiser's dashboard.`
        : PASS_EXPIRED_MESSAGE;
    }
    await this.listEvents();
    await this.countOtherUnsynced();
    this.phase = "unprovisioned";
    void this.syncOtherEvents();
  }

  /**
   * Show one stored event in this tab: the switcher, and boot. False when it can
   * no longer be opened (removed, expired or refused); nothing changes then.
   */
  async openEvent(eventId: string): Promise<boolean> {
    const pass = await db.getPass(eventId);
    const pack = await db.getPack(eventId);
    const now = Date.now();
    if (!pass || !pack || !isLive(pass, now)) {
      await this.listEvents();
      return false;
    }
    this.stopLoops();
    await db.touchPass(eventId, now);
    this.pass = { ...pass, lastUsedAt: now };
    this.pack = pack;
    this.roster = (await db.getRoster(eventId)) ?? [];
    this.doorEntries = restoreDoorEntries(await db.getDoorEntries(eventId), passJti(pass));
    this.doorKeyMismatch = false;
    this.doorKeyChecked = null;
    this.conflicts = (await db.getConflicts(eventId)) ?? [];
    this.checkins = new Map();
    this.passDead = null;
    this.provisionError = null;
    // A failed link held for "Try again" would ride the next update's reload back
    // into the URL, where boot sets it up over this event.
    this.pendingPass = null;
    this.lastRefreshAt = 0;
    this.packAsOf = 0;
    this.rechecked.clear();
    this.notFoundSince.clear();
    this.showEventInUrl(eventId);
    await this.reloadCheckins();
    this.phase = "ready";
    this.startSyncLoop();
    void this.sync();
    this.maybeAutoRefresh(0);
    await this.listEvents();
    return true;
  }

  /** The switcher. Changes this tab only. */
  async switchTo(eventId: string): Promise<void> {
    if (eventId === this.pass?.eventId) return;
    await this.openEvent(eventId);
  }

  /** Accept a door pass (from URL fragment, scanned QR, or pasted link). */
  async provision(token: string, keyB64url: string): Promise<boolean> {
    this.phase = "provisioning";
    this.provisionError = null;

    const decoded = decodeDoorPassToken(token);
    if (!decoded) {
      this.provisionError = "That doesn't look like a WoCo door pass.";
      this.pendingPass = null;
      this.phase = this.pack ? "ready" : "unprovisioned";
      return false;
    }

    try {
      const requestedAt = Date.now();
      const pack = await this.fetchPack(decoded.payload.eventId, token);
      const pass: db.StoredPass = {
        token,
        keyB64url,
        eventId: decoded.payload.eventId,
        exp: decoded.payload.exp,
        lastUsedAt: Date.now(),
      };
      // Replaces only this event's pass (and clears a dead mark, and a new pass's
      // door entries): every other event on the phone, and the tabs showing them,
      // are untouched.
      await db.putPass(pass);
      // A pass for another event starts from an empty in-memory set;
      // `reloadCheckins` only ever adds to it.
      if (this.pass?.eventId !== pass.eventId) this.checkins = new Map();
      if (this.pass?.token !== pass.token) {
        this.doorEntries = emptyDoorEntries();
        this.doorKeyMismatch = false;
        this.doorKeyChecked = null;
      }
      this.pass = pass;
      this.passDead = null;
      this.pendingPass = null;
      await this.absorbPack(pack);
      this.lastRefreshAt = Date.now();
      this.packAsOf = requestedAt;
      this.rechecked.clear();
      this.notFoundSince.clear();
      this.showEventInUrl(pass.eventId);
      this.phase = "ready";
      this.startSyncLoop();
      void this.sync();
      void this.refreshDoorEntries();
      await this.listEvents();
      return true;
    } catch (err) {
      this.pendingPass = { token, keyB64url };
      if (err instanceof PackError && err.failure.kind === "outdated" && (await takeoverIfNewer())) {
        this.reloadIntoNewVersion();
        return false;
      }
      this.provisionError = err instanceof Error ? err.message : NO_CONNECTION_MESSAGE;
      this.phase = this.pack ? "ready" : "unprovisioned";
      return false;
    }
  }

  private passFromUrl(): Promise<"none" | "reloading" | "provisioned" | "failed"> {
    return bootFromFragment({
      location,
      history,
      arriving: (pass) => {
        this.reprovision();
        // Held before anything can reload the page, so whichever path reloads carries it.
        this.pendingPass = pass;
      },
      newerVersion: () => takeoverIfNewer(),
      reload: () => this.reloadIntoNewVersion(),
      provision: (t, k) => this.provision(t, k),
    });
  }

  /** A newer scanner has taken over this page: reload into it once the door is quiet. */
  newVersionReady(): void {
    if (this.updateDue) return;
    this.updateDue = true;
    this.reloadWhenIdle();
  }

  private reloadWhenIdle(): void {
    const quiet = canApplyUpdate({
      phase: this.phase,
      claimInFlight: this.claiming,
      busy: this.scanning || this.lookingUp,
      sinceLastScanMs: Date.now() - this.lastScanAt,
    });
    if (quiet) this.reloadIntoNewVersion();
    else setTimeout(() => this.reloadWhenIdle(), UPDATE_RETRY_MS);
  }

  /**
   * The only place a door pass is put back in the URL: a pass held but not yet
   * stored would otherwise be lost to the reload. The next boot scrubs it again.
   */
  private reloadIntoNewVersion(pass: DoorPass | null = this.pendingPass): void {
    if (this.reloading) return;
    this.reloading = true;
    if (pass) history.replaceState(null, "", new URL(doorPassFragment(pass.token, pass.keyB64url), location.href).href);
    location.reload();
  }

  /** Retry the pass that last failed to set up. */
  async retryProvision(): Promise<boolean> {
    if (!this.pendingPass) return false;
    return this.provision(this.pendingPass.token, this.pendingPass.keyB64url);
  }

  /**
   * Leave a dead pass for the provision screen, keeping everything stored: a new
   * pass replaces it, and nothing unsynced is thrown away the way a reset would.
   */
  reprovision(): void {
    this.stopLoops();
    this.forgetEventInUrl();
    this.pass = null;
    this.pack = null;
    this.roster = [];
    this.doorEntries = emptyDoorEntries();
    this.doorKeyMismatch = false;
    this.doorKeyChecked = null;
    this.checkins = new Map();
    this.conflicts = [];
    this.passDead = null;
    this.provisionError = null;
    this.phase = "unprovisioned";
    void this.countOtherUnsynced();
  }

  /** Verify a scanned QR payload, then atomically consume the nullifier. */
  async scan(raw: string): Promise<ScanOutcome> {
    if (!this.pack) return { kind: "rejected", reason: "Scanner not provisioned" };
    this.scanning = true;
    try {
      return await this.scanTicket(raw, this.pack);
    } finally {
      this.scanning = false;
      this.lastScanAt = Date.now();
    }
  }

  private async scanTicket(raw: string, pack: CheckinPack): Promise<ScanOutcome> {
    // The pass this scan began under, with `pack`. Admission reads the tab's
    // pass, mode and set when it runs, so a switch to another event while this
    // verified would admit the ticket there.
    const pass = this.pass;
    let verdict = await verifyTicket(raw, pack);
    const missing = ticketNewerThanPack(verdict);
    if (missing) {
      const outcome = await resolveMiss(verdict, {
        key: db.ticketKey(missing.seriesId, missing.edition),
        firstSeen: this.notFoundSince,
        now: Date.now,
        recheck: () => this.recheckMissing(missing.seriesId, missing.edition),
        reverify: () => verifyTicket(raw, this.pack ?? pack),
        packAsOf: () => this.packAsOf,
      });
      if (outcome.kind === "cant-confirm") return { kind: "cant-confirm", message: outcome.message, edition: missing.edition };
      verdict = outcome.verdict;
    }
    if (verdict.status === "unreadable") return { kind: "unreadable" };
    if (verdict.status === "wrong-event") return { kind: "wrong-event" };
    if (verdict.status === "invalid") return { kind: "rejected", reason: verdict.reason };
    if (verdict.status === "refunded") {
      // Before `mark`: a refunded ticket consumes no nullifier, so if the refund
      // was a mistake and is reversed, the ticket still works at the door.
      const { ticket } = verdict;
      return {
        kind: "refunded",
        seriesName: verdict.seriesName,
        edition: ticket.edition,
        attendee: this.findAttendee(ticket.seriesId, ticket.edition),
      };
    }

    const { ticket } = verdict;
    // Checked with no await before `admitTicket` reads the pass, so nothing can switch in between.
    if (this.pass?.token !== pass?.token) {
      return { kind: "cant-confirm", message: EVENT_CHANGED_MESSAGE, seriesName: verdict.seriesName, edition: ticket.edition };
    }
    const attendee = this.findAttendee(ticket.seriesId, ticket.edition);
    const base = { seriesName: verdict.seriesName, edition: ticket.edition, attendee };

    const answer = await this.admitTicket(ticket.seriesId, ticket.edition, "scan");
    if (answer.kind === "admitted") return { kind: "checked-in", strength: verdict.strength, ...base };
    if (answer.kind === "already-in") return { kind: "duplicate", record: answer.record, ...base };
    return { kind: "cant-confirm", message: answer.message, ...base };
  }

  /**
   * Roster-list check-in — no QR involved, so no signature to verify. A
   * refunded ticket is refused here as at the camera (the roster can predate
   * the refund); the roster offers no button for one, this is the backstop.
   */
  async manualCheckin(seriesId: string, edition: number): Promise<ManualCheckinResult> {
    if (this.isRefunded(seriesId, edition)) return { kind: "refunded" };
    this.lastScanAt = Date.now();
    const answer = await this.admitTicket(seriesId, edition, "manual");
    if (answer.kind === "admitted") return { kind: "checked-in" };
    if (answer.kind === "already-in") return { kind: "duplicate", record: answer.record };
    return answer;
  }

  /** Whether the pack lists this ticket's sale as refunded (#645). */
  isRefunded(seriesId: string, edition: number): boolean {
    const series = this.pack?.series.find((s) => s.seriesId === seriesId);
    return series?.voidSlots?.includes(edition - 1) ?? false;
  }

  isCheckedIn(seriesId: string, edition: number): CheckinRecord | undefined {
    return this.checkins.get(db.ticketKey(seriesId, edition));
  }

  findAttendee(seriesId: string, edition: number): RosterEntry | undefined {
    return this.attendees.find((r) => r.seriesId === seriesId && r.edition === edition);
  }

  async sync(): Promise<void> {
    if (!this.online) return;
    await this.syncCurrentEvent();
    await this.syncOtherEvents();
  }

  private async syncCurrentEvent(): Promise<void> {
    const pass = this.pass;
    if (!pass || this.syncing || this.passDead) return;
    this.syncing = true;
    try {
      const pending = await db.getPending(pass.eventId);
      const answer = await this.postSync(pass, pending);
      if (answer.kind === "dead") {
        await this.passRefused(pass, answer.message, answer.expired);
        return;
      }
      if (answer.kind !== "ok") return;

      await db.absorbServerCheckins(
        pass.eventId,
        answer.data.checkins,
        pending.map((r) => db.ticketKey(r.seriesId, r.edition)),
      );
      if (this.pass?.token !== pass.token) return;
      this.conflicts = answer.data.conflicts;
      await db.putConflicts(pass.eventId, answer.data.conflicts);
      await this.reloadCheckins();
      this.lastSyncAt = new Date().toISOString();
    } catch {
      // Offline or flaky network — pending queue holds everything for next time.
    } finally {
      this.syncing = false;
      if (this.pass) this.pendingCount = (await db.getPending(this.pass.eventId)).length;
    }
  }

  /** Re-download the pack (new sales, refunds, refreshed roster). One download at a time. */
  async refreshPack(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    const job = this.downloadPack();
    this.refreshing = job;
    try {
      return await job;
    } finally {
      if (this.refreshing === job) this.refreshing = null;
    }
  }

  /**
   * "Reset" in the header: remove THIS event from this phone, its unsynced
   * check-ins included (the button asks first). Other events, and the tabs
   * showing them, are untouched.
   */
  async reset(): Promise<void> {
    const eventId = this.pass?.eventId;
    this.reprovision();
    this.pendingPass = null;
    if (eventId) await db.clearEvent(eventId);
    await this.listEvents();
    await this.countOtherUnsynced();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** One /sync for one event, with that event's own pass. */
  private async postSync(
    pass: db.StoredPass,
    pending: CheckinRecord[],
  ): Promise<{ kind: "ok"; data: CheckinSyncResponse } | { kind: "dead"; message: string; expired: boolean } | { kind: "later" }> {
    const resp = await fetch(`${API_BASE}/api/checkin/${encodeURIComponent(pass.eventId)}/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Door-Pass": pass.token,
        [SCANNER_DEVICE_HEADER]: this.deviceId,
      },
      body: JSON.stringify({ deviceId: this.deviceId, checkins: pending }),
    });
    if (resp.status === 400) {
      const body = (await resp.json().catch(() => null)) as { reason?: string } | null;
      if (body?.reason === SCANNER_OUTDATED_REASON) void takeoverIfNewer().catch(() => false);
      return { kind: "later" };
    }
    // 409: a single-scanner pass that is bound to another phone - same remedy.
    if (resp.status === 401 || resp.status === 403 || resp.status === 409) {
      const body = (await resp.json().catch(() => null)) as { error?: string; reason?: string } | null;
      return { kind: "dead", message: body?.error ?? "Door pass no longer valid", expired: isExpiredRefusal(resp.status, body) };
    }
    if (!resp.ok) return { kind: "later" };
    const body = (await resp.json()) as { ok: boolean; data?: CheckinSyncResponse };
    return body.ok && body.data ? { kind: "ok", data: body.data } : { kind: "later" };
  }

  /**
   * Sync the other events' unsynced check-ins, each with its own pass, never
   * this tab's. A pass that has expired or been refused syncs nothing; its
   * records stay on the phone.
   */
  private async syncOtherEvents(): Promise<void> {
    if (this.syncingOthers || !this.online) return;
    this.syncingOthers = true;
    try {
      for (const pass of await db.getAllPasses()) {
        if (pass.eventId === this.pass?.eventId || !isLive(pass, Date.now())) continue;
        const pending = await db.getPending(pass.eventId);
        if (pending.length === 0) continue;
        try {
          const answer = await this.postSync(pass, pending);
          if (answer.kind === "dead") await this.passRefused(pass, answer.message, answer.expired);
          else if (answer.kind === "ok") {
            await db.absorbServerCheckins(pass.eventId, answer.data.checkins, pending.map((r) => db.ticketKey(r.seriesId, r.edition)));
          }
        } catch {
          // Offline: next time.
        }
      }
    } finally {
      this.syncingOthers = false;
    }
    await this.countOtherUnsynced();
  }

  /**
   * Every ended event's attendee data and pass go at once; its check-ins once nothing
   * is waiting to sync, or 30 days after the pass ended (`endedEventAction`). Runs at
   * boot, on the refresh tick and when the tab comes back; each event is decided
   * again inside its own transaction, so a pass set up meanwhile is never touched.
   * A tab showing an expired event leaves it for the provision screen first.
   */
  cleanUpEndedEvents(): Promise<void> {
    // One run at a time; a call during a run gets one more after it, which sees
    // whatever changed meanwhile (a pass the server has just refused).
    if (this.cleaning) {
      this.cleanAgain ??= this.cleaning.then(() => {
        this.cleanAgain = null;
        return this.cleanUpEndedEvents();
      });
      return this.cleanAgain;
    }
    const job = this.runCleanUp().finally(() => {
      if (this.cleaning === job) this.cleaning = null;
    });
    this.cleaning = job;
    return job;
  }

  private async runCleanUp(): Promise<void> {
    const now = Date.now();
    const current = this.pass;
    if (current) {
      const stored = await db.getPass(current.eventId);
      const sameStored = stored?.token === current.token ? stored : undefined;
      if ((hasExpired(current, now) || (sameStored && hasExpired(sameStored, now))) && this.pass?.token === current.token) {
        this.leaveExpiredEvent();
      }
    }
    for (const pass of await db.getAllPasses()) {
      if (isLive(pass, now)) continue;
      try {
        await db.cleanUpEndedEvent(pass.eventId, now);
      } catch (err) {
        console.warn("[scanner] an ended event could not be cleaned up yet", err);
      }
    }
    await this.listEvents();
    await this.countOtherUnsynced();
  }

  /** This tab's pass has expired: its attendee data leaves memory now, and the tab says why. */
  private leaveExpiredEvent(): void {
    this.reprovision();
    this.provisionError = PASS_EXPIRED_MESSAGE;
  }

  /**
   * The server refused a pass. Expired: the phone takes it as expired whatever its own
   * clock says, and cleans up at once. Otherwise dead, as before. Either way only that
   * pass: a newer one another tab set up for the event is left alone.
   */
  private async passRefused(pass: db.StoredPass, message: string, expired: boolean): Promise<void> {
    if (this.pass?.token === pass.token) this.passDead = message;
    if (expired) {
      await db.markPassExpired(pass.eventId, pass.token, Date.now()).catch(() => undefined);
      await this.cleanUpEndedEvents();
    } else {
      await db.markPassDead(pass.eventId, message, pass.token).catch(() => undefined);
    }
  }

  private async listEvents(): Promise<void> {
    const live = liveEvents(await db.getAllPasses(), Date.now());
    this.events = await Promise.all(
      live.map(async (p) => ({ eventId: p.eventId, title: (await db.getPack(p.eventId))?.eventTitle ?? "Event" })),
    );
  }

  /** This tab's event, in the URL so a reload reopens it. The id only - never the pass. */
  private showEventInUrl(eventId: string): void {
    history.replaceState(null, "", new URL(eventMarker(eventId), location.href).href);
  }

  private forgetEventInUrl(): void {
    if (parseEventMarker(location.hash) !== null) {
      history.replaceState(null, "", new URL(location.pathname + location.search, location.href).href);
    }
  }

  private async countOtherUnsynced(): Promise<void> {
    this.otherUnsynced = unsyncedElsewhere(await db.getAllPendingKeys(), this.pass?.eventId ?? null);
  }

  private async downloadPack(): Promise<boolean> {
    const pass = this.pass;
    if (!pass || !this.online || this.passDead) return false;
    try {
      const requestedAt = Date.now();
      const pack = await this.fetchPack(pass.eventId, pass.token);
      // Provisioned onto another pass while this was in flight: the pack is the old one's.
      if (this.pass?.token !== pass.token) return false;
      await this.absorbPack(pack);
      this.lastRefreshAt = Date.now();
      this.packAsOf = requestedAt;
      return true;
    } catch (err) {
      if (err instanceof PackError && err.failure.kind === "dead") {
        await this.passRefused(pass, err.failure.message, err.failure.expired);
      }
      if (err instanceof PackError && err.failure.kind === "outdated") void takeoverIfNewer().catch(() => false);
      return false;
    }
  }

  private maybeAutoRefresh(minGapMs: number): void {
    const due = shouldAutoRefresh({
      ready: this.phase === "ready",
      online: this.online,
      passDead: this.passDead !== null,
      claimInFlight: this.claiming,
      busy: this.scanning || this.refreshing !== null,
      visible: document.visibilityState === "visible",
      sinceLastMs: Date.now() - this.lastRefreshAt,
      minGapMs,
    });
    if (due) void this.refreshPack().finally(() => void this.refreshDoorEntries());
  }

  /** Coming back to the tab: an expired event is cleaned up first, then the pack may refresh. */
  private onReturn(): void {
    void this.cleanUpEndedEvents();
    this.maybeAutoRefresh(RETURN_REFRESH_MS);
  }

  /** Fetch the door entries after this tab's cursor. One poll at a time. */
  refreshDoorEntries(): Promise<void> {
    if (this.entriesPolling) return this.entriesPolling;
    const job = this.pollDoorEntries().finally(() => {
      if (this.entriesPolling === job) this.entriesPolling = null;
    });
    this.entriesPolling = job;
    return job;
  }

  /**
   * Follows `next` while the server says `more`. The pass is captured first: a reply
   * that arrives after the tab moved to another pass (a switch, a new pass, or the pass
   * ending) is dropped, and storage takes it only while that pass is still the stored
   * one. A 503 or no signal keeps what is held; a refused pass is handled as `sync` does.
   */
  private async pollDoorEntries(): Promise<void> {
    const pass = this.pass;
    if (!pass || !this.online || this.passDead) return;
    const pack = this.pack;
    let passSecret: Uint8Array | null = null;
    try {
      passSecret = base64UrlDecode(pass.keyB64url);
      const ctx = {
        eventId: pass.eventId,
        passSecret,
        seriesName: (seriesId: string) => pack?.series.find((x) => x.seriesId === seriesId)?.name ?? "",
      };
      let state = this.doorEntries;
      for (let i = 0; i < MAX_ENTRY_PAGES; i++) {
        const since = state.next;
        const answer = await fetchDoorEntriesPage({
          fetchFn: (input, init) => fetch(input, init),
          apiBase: API_BASE,
          eventId: pass.eventId,
          token: pass.token,
          deviceId: this.deviceId,
          since,
        });
        // About the pass it was asked under (`passRefused` names it), whatever this tab shows now.
        if (answer.kind === "dead") {
          await this.passRefused(pass, answer.message, answer.expired);
          return;
        }
        if (answer.kind === "outdated") {
          void takeoverIfNewer().catch(() => false);
          return;
        }
        if (answer.kind === "later") return;

        const { page } = answer;
        const applied = (await applyDoorEntriesPage(state, page, ctx)).state;
        await this.checkDoorKey(pass, passSecret, page.doorKeyRef);
        // Checked after the last await: the tab may have moved during the request or the opening.
        if (this.pass?.token !== pass.token) return;
        state = applied;
        this.doorEntries = state;
        await db.putDoorEntries(pass.eventId, pass.token, toStoredDoorEntries(state)).catch((err) => {
          console.warn("[scanner] door entries could not be stored", err);
        });
        // No progress means a server that keeps saying `more`: wait for the next tick.
        if (!page.more || (page.next <= since && !page.reset)) return;
      }
    } catch (err) {
      console.warn("[scanner] door entries could not be read", err);
    } finally {
      passSecret?.fill(0);
    }
  }

  private async checkDoorKey(pass: db.StoredPass, passSecret: Uint8Array, doorKeyRef: string | null): Promise<void> {
    const checked = `${pass.token}|${doorKeyRef}`;
    if (this.doorKeyChecked === checked) return;
    this.doorKeyChecked = checked;
    const matches = await doorKeyMatches(passSecret, doorKeyRef);
    if (this.pass?.token === pass.token) this.doorKeyMismatch = matches === false;
  }

  /**
   * A ticket the pack does not know: fetch a pack made after this scan and look
   * again. A download that was already running may predate the sale, so it is
   * waited out and a new one started.
   */
  private async recheckMissing(seriesId: string, edition: number): Promise<RecheckResult> {
    const key = db.ticketKey(seriesId, edition);
    const now = Date.now();
    const step = onPackMiss({
      online: this.online,
      passDead: this.passDead,
      claimInFlight: this.claiming,
      lastRecheckAt: this.rechecked.get(key),
      now,
    });
    if (step.kind !== "refresh") return step;

    this.lookingUp = true;
    try {
      while (this.refreshing) await this.refreshing;
      if (!(await this.refreshPack())) return this.passDead ? { kind: "cant-confirm", message: this.passDead } : { kind: "failed" };
      for (const [k, at] of this.rechecked) if (now - at >= MISS_RECHECK_MS) this.rechecked.delete(k);
      this.rechecked.set(key, Date.now());
      return { kind: "refreshed" };
    } finally {
      this.lookingUp = false;
    }
  }

  /** The door's decision for a genuine, unrefunded ticket - rules in `admission.ts`. */
  private admitTicket(seriesId: string, edition: number, method: "scan" | "manual"): Promise<Admission> {
    // Built and handed over with no await in between, so `claimInFlight` is
    // still true-to-now when `claimAtServer` raises the flag.
    return admit({
      mode: this.doorMode,
      passDead: this.passDead,
      online: this.online,
      claimInFlight: this.claiming,
      known: this.isCheckedIn(seriesId, edition),
      markLocally: () => this.mark(seriesId, edition, method),
      claimAtServer: () => this.claimAtServer(seriesId, edition, method),
    });
  }

  /**
   * Ask the server to admit a ticket ("several" passes). The claimId is kept
   * until an answer arrives, so a re-scan after a lost response retries the SAME
   * attempt and is admitted, not turned away as "already in" by its own claim.
   *
   * `claiming` stays up until the answer is recorded here: while it is down, the
   * next scan of this ticket must find it in `checkins` or find no pending
   * claimId - never neither, or it would replay this claim and show green twice.
   */
  private async claimAtServer(seriesId: string, edition: number, method: "scan" | "manual"): Promise<ClaimAnswer> {
    this.claiming = true;
    try {
      const pass = this.pass;
      if (!pass) return { kind: "cant-confirm", message: "Scanner not provisioned" };
      const claimId = (await db.getPendingClaimId(pass.eventId, seriesId, edition)) ?? newClaimId();
      await db.setPendingClaimId(pass.eventId, seriesId, edition, claimId);
      const answer = await claimAdmission({
        fetchFn: (input, init) => fetch(input, init),
        apiBase: API_BASE,
        eventId: pass.eventId,
        token: pass.token,
        deviceId: this.deviceId,
        claim: { seriesId, edition, method, claimId, at: new Date().toISOString() },
      });

      if (answer.kind === "pass-dead") {
        await this.passRefused(pass, answer.message, answer.expired);
        return answer;
      }
      if (answer.kind === "outdated") {
        void takeoverIfNewer().catch(() => false);
        return answer;
      }
      if (answer.kind === "cant-confirm") return answer;

      // Final either way. Into memory first, before anything can yield; then the
      // pending claimId goes BEFORE the record is written, because a stale claimId
      // is the only thing that could replay this admission.
      const next = withConfirmed(this.checkins, db.ticketKey(seriesId, edition), answer.record, pass.token, this.pass?.token);
      if (next) this.checkins = next;
      try {
        await db.clearPendingClaimId(pass.eventId, seriesId, edition);
        await db.absorbServerCheckins(pass.eventId, [answer.record], []);
      } catch (err) {
        // The server holds the record and the next sync brings it back; the
        // answer stands.
        console.warn("[scanner] could not store a confirmed check-in locally", err);
      }
      return answer;
    } finally {
      this.claiming = false;
    }
  }

  private async mark(seriesId: string, edition: number, method: "scan" | "manual"): Promise<CheckinRecord | null> {
    const pass = this.pass;
    if (!pass) return null;
    const record: CheckinRecord = {
      seriesId,
      edition,
      at: new Date().toISOString(),
      deviceId: this.deviceId,
      method,
    };
    const existing = await db.checkAndMark(pass.eventId, record);
    if (!existing) {
      // Stored under the event it was admitted at; a tab that switched while it
      // was written shows another event's set and count, which it is not part of.
      const next = withConfirmed(this.checkins, db.ticketKey(seriesId, edition), record, pass.token, this.pass?.token);
      if (next) {
        this.checkins = next;
        this.pendingCount += 1;
      }
      void this.sync();
    }
    return existing;
  }

  private async fetchPack(eventId: string, token: string): Promise<CheckinPack> {
    let resp: Response;
    try {
      resp = await fetch(`${API_BASE}/api/checkin/${encodeURIComponent(eventId)}/pack`, {
        headers: { "X-Door-Pass": token, [SCANNER_DEVICE_HEADER]: this.deviceId },
      });
    } catch {
      throw new PackError({ kind: "error", message: NO_CONNECTION_MESSAGE });
    }
    const body = (await resp.json().catch(() => null)) as { ok: boolean; data?: CheckinPack; error?: string } | null;
    if (!resp.ok || !body?.ok || !body.data) throw new PackError(describePackFailure(resp.status, body));
    return body.data;
  }

  private async absorbPack(pack: CheckinPack): Promise<void> {
    const pass = this.pass;
    // Stored only under the pass that fetched it: once that pass is replaced or has
    // ended and been cleaned up, its roster must not come back.
    if (pass) await db.putPackUnderPass(pass.token, pack);
    this.pack = pack;

    if (pack.roster && pass) {
      try {
        const roster = await decryptRoster(pack.roster, pass.keyB64url);
        if (this.pass?.token === pass.token) {
          this.roster = roster;
          await db.putRosterUnderPass(pack.eventId, pass.token, roster);
        }
      } catch (err) {
        console.warn("[scanner] roster decrypt failed — pass key mismatch?", err);
      }
    }

    await db.absorbServerCheckins(pack.eventId, pack.checkins, []);
    await this.reloadCheckins();
  }

  private async reloadCheckins(): Promise<void> {
    if (!this.pass) return;
    const eventId = this.pass.eventId;
    const all = await db.getAllCheckins(eventId);
    const map = new Map<string, CheckinRecord>();
    for (const r of all) map.set(db.ticketKey(r.seriesId, r.edition), r);
    // A union, never a replacement: the set only grows. A snapshot read before a
    // confirmed check-in reached storage must not drop it from memory, or a
    // re-scan could replay that claim (#641). `reset()` clears explicitly.
    for (const [k, v] of this.checkins) if (!map.has(k)) map.set(k, v);
    this.checkins = map;
    this.pendingCount = (await db.getPending(eventId)).length;
    await this.countOtherUnsynced();
  }

  private startSyncLoop(): void {
    if (!this.syncTimer) this.syncTimer = setInterval(() => void this.sync(), SYNC_INTERVAL_MS);
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => {
        void this.cleanUpEndedEvents();
        this.maybeAutoRefresh(PACK_REFRESH_MS);
      }, REFRESH_TICK_MS);
    }
  }

  private stopLoops(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.syncTimer = null;
    this.refreshTimer = null;
  }
}

/** The pass's id - door entries are opened under it, and a newer pass has another. */
function passJti(pass: db.StoredPass): string | null {
  return decodeDoorPassToken(pass.token)?.payload.jti ?? null;
}

export const scanner = new ScannerStore();
