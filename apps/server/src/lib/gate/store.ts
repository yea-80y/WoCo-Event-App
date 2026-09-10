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
 * Every binding recorded for one event.
 *
 * A linear scan, deliberately: bindings are indexed by ticket and by parent
 * because those are the lookups the gate itself makes, and adding a third index
 * to serve one organiser-facing read would be three maps to keep consistent for
 * no measurable gain at this scale.
 *
 * WHAT THIS DOES ESTABLISH, AND ALL IT ESTABLISHES. A binding proves the
 * platform saw a verified possession proof for (seriesId, edition) and bound it
 * to the server-verified `parentAddress`. That address IS the owner of record;
 * the self-declared holder key that used to ride alongside it never was, and it
 * is gone (#518, #345 with it). The certificate rail gets its holder identity
 * back when it migrates to secp256k1.
 */
export function getBindingsForEvent(eventId: string): GateBinding[] {
  load();
  return cache!.bindings.filter((b) => b.eventId === eventId);
}

/**
 * Atomically consume the ticket nullifier and record the binding.
 * Returns false if the edition was already consumed (no partial state).
 * Single-threaded node: check-and-set needs no lock.
 *
 * THE RECORD IS BUILT FIELD BY FIELD, never spread from the caller's object,
 * and that is a guard rather than a style: this store is the only definition of
 * what a binding IS, and a spread let any caller persist any extra property it
 * happened to be holding. That is exactly how the self-declared `podPubKey`
 * reached disk unverified (#345) — a route read it off an untrusted body and
 * handed the whole object through. Whitelisting here means a future caller
 * cannot make that mistake again without editing this list, which is a decision
 * someone has to make on purpose. Pinned by test/gate-binding-fields.test.ts.
 */
export function bindTicket(binding: Omit<GateBinding, "boundAt" | "parentAddress"> & {
  parentAddress: string;
}): boolean {
  load();
  const key = ticketKey(binding.seriesId, binding.edition);
  if (byTicket!.has(key)) return false;
  const record: GateBinding = {
    seriesId: binding.seriesId,
    edition: binding.edition,
    eventId: binding.eventId,
    ...(binding.emailHash !== undefined ? { emailHash: binding.emailHash } : {}),
    ...(binding.paid !== undefined ? { paid: binding.paid } : {}),
    route: binding.route,
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

// ---------------------------------------------------------------------------
// Picker rows for the certificate rail (#172)
// ---------------------------------------------------------------------------

export interface AttendeeKeyRow {
  seriesId: string;
  edition: number;
  /**
   * How the binding was made. Carried so a caller can distinguish a binding
   * made alongside a verified session (`claim`) from one made from possession
   * of an emailed link (`email-link`).
   */
  route: GateBinding["route"];
}

/**
 * Map bindings to picker rows.
 *
 * NO HOLDER KEY IS SERVED ANY MORE (#518). The ed25519 key these rows used to
 * carry was self-declared by the claiming client and never checked against
 * anything (#345), so it was never a holder identity — it was a string the
 * client chose. The certificate rail gets a real one when it migrates to the
 * secp256k1 issuing/holder pair; until then the honest answer is that no
 * attendee is certifiable, and the surface must say so rather than sign a
 * permanent, unrevocable certificate over an unverified key.
 *
 * EVERY binding is still returned. A picker handed a short list cannot tell
 * "nobody qualifies" from "the read came back truncated", and this rail's whole
 * hazard profile is failures that look like empty successes.
 */
export function toAttendeeKeyRows(bindings: readonly GateBinding[]): AttendeeKeyRow[] {
  return bindings.map((b) => ({
    seriesId: b.seriesId,
    edition: b.edition,
    route: b.route,
  }));
}
