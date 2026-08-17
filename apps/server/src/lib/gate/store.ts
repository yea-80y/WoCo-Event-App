/**
 * Attendee gate — file-backed bindings + one-shot ticket nullifiers.
 *
 * A "binding" records that a verified ticket possession proof unlocked a
 * parent account: (seriesId, edition) → parentAddress. Each edition is
 * consumable exactly ONCE for account gating (sybil cap: 1 ticket = 1
 * profile unlock). This namespace is deliberately SEPARATE from door
 * check-in nullifiers — creating a profile must not burn entry and being
 * scanned must not burn the profile claim.
 *
 * `.data/attendee-gate-bindings.json` MUST survive restarts (same contract
 * as tx-registry / revoked-sessions).
 *
 * Design doc: docs/ATTENDEE_GATE_RESALE_PLAN.md
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../marketing/persist.js";

const DATA_DIR = join(process.cwd(), ".data");
const BINDINGS_FILE = join(DATA_DIR, "attendee-gate-bindings.json");

// "ticket-proof" and "wallet" went with the v1 rail (Route B / bind-wallet).
export type GateRoute = "email-link" | "claim";

export interface GateBinding {
  seriesId: string;
  edition: number;
  eventId: string;
  /** Verified parent address (lowercase) the ticket is bound to. */
  parentAddress: string;
  /** HMAC email hash the proof matched (email routes only). */
  emailHash?: string;
  /** Attendee ed25519 POD pubkey captured at bind time — the owner-of-record
   *  that later gets stamped into the ClaimedTicket (plan §3). */
  podPubKey?: string;
  /** True when the underlying series had a price — feeds sybil weighting. */
  paid?: boolean;
  route: GateRoute;
  boundAt: string;
}

interface BindingsFile {
  v: 1;
  bindings: GateBinding[];
}

function ticketKey(seriesId: string, edition: number): string {
  return `${seriesId} ${edition}`;
}

let cache: BindingsFile | null = null;
let byTicket: Map<string, GateBinding> | null = null;
let byParent: Map<string, GateBinding[]> | null = null;

function load(): void {
  if (cache) return;
  try {
    cache = JSON.parse(readFileSync(BINDINGS_FILE, "utf-8")) as BindingsFile;
  } catch {
    cache = { v: 1, bindings: [] };
  }
  byTicket = new Map();
  byParent = new Map();
  for (const b of cache.bindings) {
    byTicket.set(ticketKey(b.seriesId, b.edition), b);
    const list = byParent.get(b.parentAddress) ?? [];
    list.push(b);
    byParent.set(b.parentAddress, list);
  }
}

function persist(): void {
  // Throws, unlike most stores: the nullifier is consumed in memory before this
  // runs, so a swallowed failure would report an unlock the restart forgets —
  // handing the same ticket a second profile. The caller must see the failure.
  if (!writeJsonAtomic(BINDINGS_FILE, cache, "gate-bindings")) {
    throw new Error("attendee-gate bindings could not be persisted");
  }
}

/** Has this edition already been consumed for account gating? */
export function isTicketConsumed(seriesId: string, edition: number): boolean {
  load();
  return byTicket!.has(ticketKey(seriesId, edition));
}

export function getBindingsForParent(parentAddress: string): GateBinding[] {
  load();
  return byParent!.get(parentAddress.toLowerCase()) ?? [];
}

/**
 * Atomically consume the ticket nullifier and record the binding.
 * Returns false if the edition was already consumed (no partial state).
 * Single-threaded node: check-and-set needs no lock.
 */
export function bindTicket(binding: Omit<GateBinding, "boundAt" | "parentAddress"> & {
  parentAddress: string;
}): boolean {
  load();
  const key = ticketKey(binding.seriesId, binding.edition);
  if (byTicket!.has(key)) return false;
  const record: GateBinding = {
    ...binding,
    parentAddress: binding.parentAddress.toLowerCase(),
    boundAt: new Date().toISOString(),
  };
  cache!.bindings.push(record);
  byTicket!.set(key, record);
  const list = byParent!.get(record.parentAddress) ?? [];
  list.push(record);
  byParent!.set(record.parentAddress, list);
  persist();
  return true;
}
