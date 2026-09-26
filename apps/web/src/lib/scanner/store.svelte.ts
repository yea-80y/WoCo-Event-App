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
  decodeDoorPassToken,
  parseDoorPassFragment,
  SCANNER_DEVICE_HEADER,
  type DoorMode,
  type CheckinConflict,
  type CheckinPack,
  type CheckinRecord,
  type CheckinSyncResponse,
  type RosterEntry,
} from "@woco/shared";
import * as db from "./db.js";
import { decryptRoster } from "./roster-crypto.js";
import { verifyTicket, type VerifyVerdict } from "./verify.js";
import { claimAdmission, newClaimId, type ClaimAnswer } from "./claim.js";
import { admit, doorModeOf, type Admission } from "./admission.js";

const API_BASE = import.meta.env.VITE_API_URL || "";
const SYNC_INTERVAL_MS = 30_000;

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

export type ManualCheckinResult =
  | { kind: "checked-in" }
  | { kind: "duplicate"; record: CheckinRecord }
  | { kind: "refunded" }
  | { kind: "cant-confirm"; message: string };

class ScannerStore {
  phase = $state<"loading" | "unprovisioned" | "provisioning" | "ready">("loading");
  provisionError = $state<string | null>(null);

  pass = $state<db.StoredPass | null>(null);
  pack = $state<CheckinPack | null>(null);
  roster = $state<RosterEntry[]>([]);
  /** ticketKey → record; mirrors the IndexedDB nullifier set for the UI. */
  checkins = $state<Map<string, CheckinRecord>>(new Map());
  conflicts = $state<CheckinConflict[]>([]);

  online = $state(typeof navigator !== "undefined" ? navigator.onLine : true);
  syncing = $state(false);
  lastSyncAt = $state<string | null>(null);
  pendingCount = $state(0);
  /** Set when the server said the pass was revoked/expired — device must re-provision. */
  passDead = $state<string | null>(null);
  /** A server claim is in flight - the scan screen shows "checking" and pauses the camera. */
  claiming = $state(false);

  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private deviceId = "";

  totalCapacity = $derived(this.pack?.series.reduce((n, s) => n + s.totalSupply, 0) ?? 0);
  doorMode = $derived<DoorMode>(doorModeOf(this.pack));
  checkedInCount = $derived(this.checkins.size);

  async init(): Promise<void> {
    this.deviceId = await db.getDeviceId();

    window.addEventListener("online", () => {
      this.online = true;
      void this.sync();
    });
    window.addEventListener("offline", () => (this.online = false));

    // A door-pass fragment in the URL always wins — it (re)provisions the device.
    const fragment = parseDoorPassFragment(location.hash);
    if (fragment) {
      await this.provision(fragment.token, fragment.keyB64url);
      // Scrub the secret-bearing fragment from the address bar + history.
      history.replaceState(null, "", new URL(location.pathname + location.search, location.href).href);
      return;
    }

    const pass = await db.getStoredPass();
    const pack = await db.getStoredPack();
    if (pass && pack) {
      this.pass = pass;
      this.pack = pack;
      this.roster = (await db.getStoredRoster()) ?? [];
      this.conflicts = (await db.getStoredConflicts()) ?? [];
      await this.reloadCheckins();
      this.phase = "ready";
      this.startSyncLoop();
      void this.sync();
    } else {
      this.phase = "unprovisioned";
    }
  }

  /** Accept a door pass (from URL fragment, scanned QR, or pasted link). */
  async provision(token: string, keyB64url: string): Promise<boolean> {
    this.phase = "provisioning";
    this.provisionError = null;

    const decoded = decodeDoorPassToken(token);
    if (!decoded) {
      this.provisionError = "That doesn't look like a WoCo door pass.";
      this.phase = this.pack ? "ready" : "unprovisioned";
      return false;
    }

    try {
      const pack = await this.fetchPack(decoded.payload.eventId, token);
      const pass: db.StoredPass = {
        token,
        keyB64url,
        eventId: decoded.payload.eventId,
        exp: decoded.payload.exp,
      };
      await db.setStoredPass(pass);
      this.pass = pass;
      this.passDead = null;
      await this.absorbPack(pack);
      this.phase = "ready";
      this.startSyncLoop();
      void this.sync();
      return true;
    } catch (err) {
      this.provisionError = err instanceof Error ? err.message : "Could not reach the WoCo server.";
      this.phase = this.pack ? "ready" : "unprovisioned";
      return false;
    }
  }

  /** Verify a scanned QR payload, then atomically consume the nullifier. */
  async scan(raw: string): Promise<ScanOutcome> {
    if (!this.pack) return { kind: "rejected", reason: "Scanner not provisioned" };

    const verdict: VerifyVerdict = await verifyTicket(raw, this.pack);
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
    return this.roster.find((r) => r.seriesId === seriesId && r.edition === edition);
  }

  async sync(): Promise<void> {
    if (!this.pass || this.syncing || !this.online || this.passDead) return;
    this.syncing = true;
    try {
      const pending = await db.getPending();
      const resp = await fetch(`${API_BASE}/api/checkin/${encodeURIComponent(this.pass.eventId)}/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Door-Pass": this.pass.token,
          [SCANNER_DEVICE_HEADER]: this.deviceId,
        },
        body: JSON.stringify({ deviceId: this.deviceId, checkins: pending }),
      });
      // 409: a single-scanner pass that is bound to another phone - same remedy.
      if (resp.status === 401 || resp.status === 403 || resp.status === 409) {
        const body = (await resp.json().catch(() => null)) as { error?: string } | null;
        this.passDead = body?.error ?? "Door pass no longer valid";
        return;
      }
      if (!resp.ok) return;
      const body = (await resp.json()) as { ok: boolean; data?: CheckinSyncResponse };
      if (!body.ok || !body.data) return;

      await db.absorbServerCheckins(
        body.data.checkins,
        pending.map((r) => db.ticketKey(r.seriesId, r.edition)),
      );
      this.conflicts = body.data.conflicts;
      await db.setStoredConflicts(body.data.conflicts);
      await this.reloadCheckins();
      this.lastSyncAt = new Date().toISOString();
    } catch {
      // Offline or flaky network — pending queue holds everything for next time.
    } finally {
      this.syncing = false;
      this.pendingCount = (await db.getPending()).length;
    }
  }

  /** Re-download the pack (new sales, refreshed roster). */
  async refreshPack(): Promise<boolean> {
    if (!this.pass || !this.online) return false;
    try {
      const pack = await this.fetchPack(this.pass.eventId, this.pass.token);
      await this.absorbPack(pack);
      return true;
    } catch {
      return false;
    }
  }

  async reset(): Promise<void> {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    await db.resetDevice();
    this.pass = null;
    this.pack = null;
    this.roster = [];
    this.checkins = new Map();
    this.conflicts = [];
    this.passDead = null;
    this.phase = "unprovisioned";
  }

  // ── internals ─────────────────────────────────────────────────────────────

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
   */
  private async claimAtServer(seriesId: string, edition: number, method: "scan" | "manual"): Promise<ClaimAnswer> {
    this.claiming = true;
    let answer: ClaimAnswer;
    try {
      if (!this.pass) return { kind: "cant-confirm", message: "Scanner not provisioned" };
      const claimId = (await db.getPendingClaimId(seriesId, edition)) ?? newClaimId();
      await db.setPendingClaimId(seriesId, edition, claimId);
      answer = await claimAdmission({
        fetchFn: (input, init) => fetch(input, init),
        apiBase: API_BASE,
        eventId: this.pass.eventId,
        token: this.pass.token,
        deviceId: this.deviceId,
        claim: { seriesId, edition, method, claimId, at: new Date().toISOString() },
      });
    } finally {
      this.claiming = false;
    }

    if (answer.kind === "pass-dead") {
      this.passDead = answer.message;
      return answer;
    }
    if (answer.kind === "cant-confirm") return answer;

    // The server's answer is final either way: remember who holds the ticket so a
    // re-scan here is an instant "already in", and drop the in-flight claim.
    await db.absorbServerCheckins([answer.record], []);
    await db.clearPendingClaimId(seriesId, edition);
    const next = new Map(this.checkins);
    next.set(db.ticketKey(seriesId, edition), answer.record);
    this.checkins = next;
    return answer;
  }

  private async mark(seriesId: string, edition: number, method: "scan" | "manual"): Promise<CheckinRecord | null> {
    const record: CheckinRecord = {
      seriesId,
      edition,
      at: new Date().toISOString(),
      deviceId: this.deviceId,
      method,
    };
    const existing = await db.checkAndMark(record);
    if (!existing) {
      const next = new Map(this.checkins);
      next.set(db.ticketKey(seriesId, edition), record);
      this.checkins = next;
      this.pendingCount += 1;
      void this.sync();
    }
    return existing;
  }

  private async fetchPack(eventId: string, token: string): Promise<CheckinPack> {
    const resp = await fetch(`${API_BASE}/api/checkin/${encodeURIComponent(eventId)}/pack`, {
      headers: { "X-Door-Pass": token, [SCANNER_DEVICE_HEADER]: this.deviceId },
    });
    const body = (await resp.json().catch(() => null)) as { ok: boolean; data?: CheckinPack; error?: string } | null;
    if (!resp.ok || !body?.ok || !body.data) {
      throw new Error(body?.error ?? `Server error (${resp.status})`);
    }
    return body.data;
  }

  private async absorbPack(pack: CheckinPack): Promise<void> {
    await db.setStoredPack(pack);
    this.pack = pack;

    if (pack.roster && this.pass) {
      try {
        this.roster = await decryptRoster(pack.roster, this.pass.keyB64url);
        await db.setStoredRoster(this.roster);
      } catch (err) {
        console.warn("[scanner] roster decrypt failed — pass key mismatch?", err);
      }
    }

    await db.absorbServerCheckins(pack.checkins, []);
    await this.reloadCheckins();
  }

  private async reloadCheckins(): Promise<void> {
    const all = await db.getAllCheckins();
    const map = new Map<string, CheckinRecord>();
    for (const r of all) map.set(db.ticketKey(r.seriesId, r.edition), r);
    this.checkins = map;
    this.pendingCount = (await db.getPending()).length;
  }

  private startSyncLoop(): void {
    if (this.syncTimer) return;
    this.syncTimer = setInterval(() => void this.sync(), SYNC_INTERVAL_MS);
  }
}

export const scanner = new ScannerStore();
