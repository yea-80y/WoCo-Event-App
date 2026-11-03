/**
 * The live wiring for the automatic buyer add - the rules are in `audience-sync.ts`.
 *
 * ONE entry point, `syncAudience()`: the Audience screen calls it when it opens
 * and from "Check now"; organiser pages call it in the background (CreatorApp).
 * A background run never asks for anything: a request is made only on a session
 * already on this device, keys are taken only if already open, and sealing only
 * on a key generation already confirmed - otherwise the run is skipped. "Check
 * now" is a tap, so it may ask the organiser to confirm it's them before sealing
 * (Fable sign-off 2026-10-14).
 */
import type { MarketingListMeta, MarketingListPayload } from "@woco/shared";
import { auth } from "../../auth/auth-store.svelte.js";
import { canOrganise } from "../../auth/organiser-account.js";
import { getEventSWR, getMyEventsSWR } from "../../api/creator-cache.js";
import { getEventOrderCount } from "../../api/events.js";
import {
  checkMarketingEmails,
  getMarketingList,
  getMarketingListSummary,
  uploadMarketingList,
} from "../../api/marketing.js";
import { markAudienceImported } from "../home/onboarding.svelte.js";
import {
  createLock,
  createSyncGate,
  runAudienceSync,
  watermarkStore,
  SYNC_INTERVAL_MS,
  type StartStamp,
  type SyncDeps,
  type SyncGate,
  type SyncProgress,
  type SyncRecord,
  type SyncResult,
} from "./audience-sync.js";
import { listKeysOf } from "./list-keys.js";

/** The live reader and opener, loaded on first use. */
type SyncLive = typeof import("./sync-live.js");

/** Every write to the sealed list in this tab takes this lock - the Audience screen's saves too. */
export const withListLock = createLock();

type Listener = (payload: MarketingListPayload, meta: MarketingListMeta) => void;
const listeners = new Set<Listener>();

/**
 * A screen showing the list takes each sync write as it lands - inside the lock,
 * so a save waiting behind the sync starts from the list that includes it.
 */
export function onListWritten(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Per organiser, in localStorage: `last` = the last run as the Audience screen
 * shows it, `startedAt` = when the last run began, so a reload honours the hour.
 * Unreadable = empty, which only means a run may start.
 */
const recordKey = (parent: string) => `woco:audience-sync-status:${parent}`;

function readBlob(parent: string): Record<string, unknown> {
  try {
    const raw = storage()?.getItem(recordKey(parent));
    const v: unknown = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeBlob(parent: string, patch: Record<string, unknown>): void {
  try {
    storage()?.setItem(recordKey(parent), JSON.stringify({ ...readBlob(parent), ...patch }));
  } catch {
    /* best effort */
  }
}

function startStamp(parent: string): StartStamp {
  return {
    read: () => {
      const t = readBlob(parent).startedAt;
      return typeof t === "number" ? t : null;
    },
    write: (t) => writeBlob(parent, { startedAt: t ?? undefined }),
  };
}

/** A run in progress on this device (any tab), refreshed while it lasts: `runningAt`. */
function runningMark(parent: string): StartStamp {
  return {
    read: () => {
      const t = readBlob(parent).runningAt;
      return typeof t === "number" ? t : null;
    },
    write: (t) => writeBlob(parent, { runningAt: t ?? undefined }),
  };
}

function readRecord(parent: string): SyncRecord | null {
  try {
    const r = readBlob(parent).last as Partial<SyncRecord> | undefined;
    if (!r || typeof r !== "object") return null;
    const nums = [r.at, r.added, r.failedEvents, r.unreadableOrders];
    if (!nums.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
    if (r.status !== "ok" && r.status !== "partial" && r.status !== "failed") return null;
    return {
      at: r.at!,
      status: r.status,
      added: r.added!,
      failedEvents: r.failedEvents!,
      unreadableOrders: r.unreadableOrders!,
      ...(typeof r.error === "string" ? { error: r.error } : {}),
    };
  } catch {
    return null;
  }
}

function writeRecord(parent: string, rec: SyncRecord): void {
  writeBlob(parent, { last: rec });
}

class AudienceSyncState {
  running = $state(false);
  /** The last run for the bound organiser, as the Audience screen shows it. */
  record = $state<SyncRecord | null>(null);
  /** While a run lasts: which event it is on and how far, for the status line. */
  progress = $state.raw<SyncProgress | null>(null);
  parent: string | null = null;

  bind(parent: string): void {
    if (this.parent === parent) return;
    this.parent = parent;
    this.record = readRecord(parent);
    this.progress = null;
  }
}

export const audienceSync = new AudienceSyncState();

const gates = new Map<string, SyncGate<SyncResult>>();

/**
 * Run the sync now if it may: never two at once, at most once an hour on this
 * device unless `force`. `manual` = the organiser pressed "Check now": the one
 * run that may ask them to confirm it's them. Null = not run.
 */
export function syncAudience(opts: { force?: boolean; manual?: boolean } = {}): Promise<SyncResult> | null {
  const parent = auth.parent?.toLowerCase();
  // An existing session only: a request must never be what asks for a signature.
  if (!parent || !auth.isConnected || !auth.hasSession || !canOrganise(auth.kind)) return null;
  audienceSync.bind(parent);
  let gate = gates.get(parent);
  if (!gate) {
    gate = createSyncGate<SyncResult>({
      minIntervalMs: SYNC_INTERVAL_MS,
      now: Date.now,
      // A locked run read nothing; unlocking should not have to wait out the window.
      counts: (r) => r.status !== "locked",
      stamp: startStamp(parent),
      // A run cut short (its tab closed) stops refreshing this, so it never costs the hour.
      lease: runningMark(parent),
      every: (ms, fn) => {
        const h = setInterval(fn, ms);
        return () => clearInterval(h);
      },
    });
    gates.set(parent, gate);
  }
  const manual = opts.manual === true;
  return gate.run(opts.force === true || manual, () => runFor(parent, manual));
}

async function runFor(parent: string, manual: boolean): Promise<SyncResult> {
  audienceSync.running = true;
  let run: { deps: SyncDeps; dispose(): void } | null = null;
  try {
    // The reader is loaded on first use; a load that fails is a failed check, never a throw.
    let live: SyncLive | null = null;
    try {
      live = await import("./sync-live.js");
    } catch {
      live = null;
    }
    if (live) run = liveDeps(parent, manual, live);
    const res: SyncResult = run
      ? await runAudienceSync(run.deps)
      : { status: "failed", added: 0, updated: 0, failedEvents: 0, unreadableOrders: 0, error: "Could not load the check." };
    // Logged, never shown off the Audience screen: a background check must not put an error on an unrelated page.
    if (res.status === "failed") console.warn("[audience-sync] check did not finish:", res.error);
    if (res.added > 0) markAudienceImported(parent);
    const rec: SyncRecord = {
      at: Date.now(),
      status: res.status,
      added: res.added,
      failedEvents: res.failedEvents,
      unreadableOrders: res.unreadableOrders,
      ...(res.error ? { error: res.error } : {}),
      ...(manual ? { manual } : {}),
    };
    // A locked run is shown, not remembered: it says nothing about the last real check.
    if (res.status !== "locked") writeRecord(parent, rec);
    if (audienceSync.parent === parent) audienceSync.record = rec;
    return res;
  } finally {
    // Every worker's keys go with the run, whatever ended it.
    run?.dispose();
    if (audienceSync.parent === parent) audienceSync.progress = null;
    audienceSync.running = false;
  }
}

/**
 * The confirmed current key generation for a "Check now" tap: whatever is held, else
 * one confirm (the unlock, or the catch-up for a device behind). Null = not confirmed.
 */
async function confirmedSecrets(): Promise<{ current: string; all: string[] } | null> {
  try {
    const held = await auth.getAccountSecrets({ toSeal: true });
    if (held) return held;
    if (!(await auth.ensureAccountSetup({ identity: true }))) return null;
    return await auth.getAccountSecrets({ toSeal: true });
  } catch {
    return null;
  }
}

function liveDeps(parent: string, manual: boolean, live: SyncLive): { deps: SyncDeps; dispose(): void } {
  const current = () => auth.isConnected && auth.parent?.toLowerCase() === parent;
  // The keys' account, fixed when the run starts: a relock, sign-out or another sign-in moves one of these.
  const account = auth.seedAddress;
  // Read directly before every hand-over and after every step - never through the watcher having run.
  const bound = () =>
    current() && account !== null && auth.seedAddress === account && !(auth.kind === "passkey" && !auth.hasIdentitySeed);
  const opener = live.syncOpener({
    bound,
    async keys() {
      const secrets = await auth.getAccountSecrets();
      if (!secrets || !bound()) return null;
      const { orderKeysOf } = await import("../../keyring/order-keys.js");
      return (await orderKeysOf(secrets)).secretKeys;
    },
  });
  // The workers drop their keys the moment the account or its unlock moves, mid-step too.
  const unwatch = $effect.root(() => {
    $effect(() => {
      if (!bound()) opener.lock();
    });
  });
  const deps: SyncDeps = {
    organiser: parent,
    async openKeys() {
      // A probe only - no unlock is ever asked for, and the run holds no key: opening and
      // the list each ask again when they need one.
      const secrets = await auth.getAccountSecrets();
      if (!secrets || !bound()) return null;
      return {
        openOrders: (eventId, jobs, progress) => opener.open(eventId, jobs, progress),
        async openList(box) {
          const held = await auth.getAccountSecrets();
          if (!held || !bound()) throw new Error("Your account locked before your list could be opened.");
          const keys = await listKeysOf(held, parent);
          try {
            const { openJsonWithAnyKey } = await import("../../keyring/order-keys.js");
            return await openJsonWithAnyKey<MarketingListPayload>(keys.secretKeys, box, keys.ctx);
          } finally {
            for (const k of keys.secretKeys) k.fill(0);
          }
        },
        stillOpen: bound,
      };
    },
    async sealKeys() {
      // Sealing needs the confirmed current generation (#186). In the background `silent` =
      // never the catch-up prompt (an unconfirmed generation throws: no write); a "Check
      // now" tap may confirm it's them.
      const secrets = manual
        ? await confirmedSecrets()
        : await auth.getAccountSecrets({ toSeal: true, silent: true }).catch(() => null);
      if (!secrets || !current()) return null;
      const keys = await listKeysOf(secrets, parent);
      return {
        sealList: (payload) => keys.box.sealBoxJsonCompressed(keys.publicKey, payload, keys.ctx),
        // Asked again right before the upload: a key ring that moved on meanwhile (#186) = no
        // write. Then one fresh read of the ring's anchor (no prompt), never the in-memory verdict alone.
        async unchanged() {
          const again = await auth.getAccountSecrets({ toSeal: true, silent: true }).catch(() => null);
          if (again === null || !current() || again.current !== secrets.current) return false;
          return auth.keyRingStillCurrent().catch(() => false);
        },
      };
    },
    async listEvents() {
      const res = await getMyEventsSWR(parent).refresh();
      if (!res.ok || !res.data) throw new Error(res.error || "Could not load your events.");
      return res.data;
    },
    async listStamp() {
      return (await getMarketingListSummary())?.updatedAt ?? null;
    },
    orderCount: (eventId) => getEventOrderCount(eventId),
    // In the browser, as the dashboard reads them (#201): never the server's full read,
    // except for a ledger this browser cannot read (sync-orders.ts).
    getOrders: (eventId, progress) => live.readOrders(eventId, progress),
    async getOrderFields(ev) {
      const res = await getEventSWR(ev.eventId).refresh();
      if (!res.ok || !res.data) throw new Error(res.error || "Could not read this event's questions.");
      return res.data.orderFields ?? [];
    },
    check: (emails) => checkMarketingEmails(emails),
    async readList() {
      const res = await getMarketingList();
      return res ? { sealedList: res.sealedList, updatedAt: res.meta.updatedAt } : null;
    },
    writeList: (sealed, emails, ifUpdatedAt) => uploadMarketingList(sealed, emails, { ifUpdatedAt }),
    stillCurrent: current,
    withLock: withListLock,
    published(payload, meta) {
      for (const fn of listeners) {
        try {
          fn(payload, meta);
        } catch (err) {
          console.warn("[audience-sync] a list listener threw:", err);
        }
      }
    },
    watermark: watermarkStore(storage(), parent),
    now: Date.now,
    onProgress(p) {
      if (audienceSync.parent === parent) audienceSync.progress = p;
    },
  };
  return {
    deps,
    dispose() {
      unwatch();
      opener.lock();
    },
  };
}
