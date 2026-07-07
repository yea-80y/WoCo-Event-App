/**
 * Scanner state machine (Svelte 5 runes). Owns provisioning, the offline
 * pack, the nullifier set, and opportunistic sync. All actions work offline
 * except provisioning/sync, which need the API.
 */

import {
  decodeDoorPassToken,
  parseDoorPassFragment,
  type CheckinConflict,
  type CheckinPack,
  type CheckinRecord,
  type CheckinSyncResponse,
  type RosterEntry,
} from "@woco/shared";
import * as db from "./db.js";
import { decryptRoster } from "./roster-crypto.js";
import { verifyTicket, type VerifyVerdict } from "./verify.js";

const API_BASE = import.meta.env.VITE_API_URL || "";
const SYNC_INTERVAL_MS = 30_000;

export type ScanOutcome =
  | { kind: "checked-in"; strength: "onchain" | "ledger"; seriesName: string; edition: number; attendee?: RosterEntry }
  | { kind: "duplicate"; record: CheckinRecord; seriesName?: string; edition: number; attendee?: RosterEntry }
  | { kind: "rejected"; reason: string }
  | { kind: "wrong-event" }
  | { kind: "unreadable" };

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

  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private deviceId = "";

  totalCapacity = $derived(this.pack?.series.reduce((n, s) => n + s.totalSupply, 0) ?? 0);
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
      history.replaceState(null, "", location.pathname + location.search);
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

    const { ticket } = verdict;
    const duplicate = await this.mark(ticket.seriesId, ticket.edition, "scan");
    const attendee = this.findAttendee(ticket.seriesId, ticket.edition);
    if (duplicate) {
      return { kind: "duplicate", record: duplicate, seriesName: verdict.seriesName, edition: ticket.edition, attendee };
    }
    return { kind: "checked-in", strength: verdict.strength, seriesName: verdict.seriesName, edition: ticket.edition, attendee };
  }

  /** Roster-list check-in — no QR involved, so no signature to verify. */
  async manualCheckin(seriesId: string, edition: number): Promise<CheckinRecord | null> {
    return this.mark(seriesId, edition, "manual");
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
        headers: { "Content-Type": "application/json", "X-Door-Pass": this.pass.token },
        body: JSON.stringify({ deviceId: this.deviceId, checkins: pending }),
      });
      if (resp.status === 401 || resp.status === 403) {
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
      headers: { "X-Door-Pass": token },
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
