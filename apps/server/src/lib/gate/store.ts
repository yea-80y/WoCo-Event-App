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
 * Every binding recorded for one event.
 *
 * A linear scan, deliberately: bindings are indexed by ticket and by parent
 * because those are the lookups the gate itself makes, and adding a third index
 * to serve one organiser-facing read would be three maps to keep consistent for
 * no measurable gain at this scale.
 *
 * WHAT THIS DOES NOT ESTABLISH. A binding proves the platform saw a verified
 * possession proof for (seriesId, edition) and bound it to `parentAddress`. It
 * does NOT prove that `podPubKey` is that account's POD identity: the field is
 * self-declared by the claiming client at bind time and is never checked
 * against the session's actual POD key (issue #345). Any caller turning these
 * into durable artifacts — a certificate especially, which is permanent and has
 * no v1 revocation — must carry that provenance through to whoever decides.
 */
export function getBindingsForEvent(eventId: string): GateBinding[] {
  load();
  return cache!.bindings.filter((b) => b.eventId === eventId);
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

// ---------------------------------------------------------------------------
// Picker rows for the certificate rail (#172)
// ---------------------------------------------------------------------------

/** ed25519 POD public key, hex, no 0x. */
const POD_PUBKEY_RE = /^[0-9a-f]{64}$/;

export interface AttendeeKeyRow {
  seriesId: string;
  edition: number;
  /** Absent when this attendee has no usable key — see the two rules below. */
  podPubKey?: string;
  /**
   * How the binding was made. Carried so a caller can distinguish a key
   * captured alongside a verified session (`claim`) from one accepted in an
   * unauthenticated redeem body (`email-link`). Neither is a proof of
   * possession — see {@link toAttendeeKeyRows}.
   */
  route: GateBinding["route"];
}

/**
 * Map bindings to picker rows.
 *
 * RULE 1 — EVERY binding is returned, including those with no key. A picker
 * handed only the certifiable ones cannot tell "nobody qualifies" from "the
 * list came back short", and this rail's whole hazard profile is failures that
 * look like empty successes. The surface is required to SHOW un-certifiable
 * attendees rather than drop them, and it can only do that if they arrive.
 *
 * RULE 2 — a malformed key is reported as ABSENT, never passed through. It can
 * only have come from the redeem path, which historically stored whatever
 * string it was sent, and a certificate signed over garbage is permanent and
 * unrevocable in v1.
 *
 * WHAT THESE ROWS DO NOT ESTABLISH: `podPubKey` is self-declared by the
 * claiming client and was never checked against the account's actual POD
 * identity (#345). A binding proves the platform saw a verified possession
 * proof for an edition; it does not prove whose badge key this is. Callers
 * writing permanent artifacts must carry that caveat to whoever decides.
 */
export function toAttendeeKeyRows(bindings: readonly GateBinding[]): AttendeeKeyRow[] {
  return bindings.map((b) => {
    const key = typeof b.podPubKey === "string" ? b.podPubKey.toLowerCase() : undefined;
    return {
      seriesId: b.seriesId,
      edition: b.edition,
      ...(key && POD_PUBKEY_RE.test(key) ? { podPubKey: key } : {}),
      route: b.route,
    };
  });
}
