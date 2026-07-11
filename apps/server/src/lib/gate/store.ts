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
 * as tx-registry / revoked-sessions). Pending email verification codes are
 * in-memory only: a restart just invalidates outstanding codes (10-min TTL),
 * which is safe.
 *
 * Design doc: docs/ATTENDEE_GATE_RESALE_PLAN.md
 */

import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), ".data");
const BINDINGS_FILE = join(DATA_DIR, "attendee-gate-bindings.json");

export type GateRoute = "ticket-proof" | "wallet" | "email-link" | "claim";

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
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(BINDINGS_FILE, JSON.stringify(cache), "utf-8");
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

// ---------------------------------------------------------------------------
// Pending email verification codes (Route B) — in-memory, 10-min TTL
// ---------------------------------------------------------------------------

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
/** Per-ticket send cap: stops using us to bomb a buyer's inbox. */
const MAX_SENDS_PER_TICKET_PER_HOUR = 3;

interface PendingCode {
  codeHash: Buffer;
  emailHash: string;
  eventId: string;
  expiresAt: number;
  attempts: number;
}

/** key = `${parentAddress} ${seriesId} ${edition}` */
const pendingCodes = new Map<string, PendingCode>();
/** key = ticketKey, values = send timestamps within the last hour */
const ticketSends = new Map<string, number[]>();

function pendingKey(parent: string, seriesId: string, edition: number): string {
  return `${parent.toLowerCase()} ${ticketKey(seriesId, edition)}`;
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

export function canSendCode(seriesId: string, edition: number): boolean {
  const key = ticketKey(seriesId, edition);
  const now = Date.now();
  const recent = (ticketSends.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
  ticketSends.set(key, recent);
  return recent.length < MAX_SENDS_PER_TICKET_PER_HOUR;
}

/** Create (or replace) the pending code for this parent+ticket. Returns the
 *  6-digit code to email — the store keeps only its hash. */
export function createPendingCode(params: {
  parentAddress: string;
  seriesId: string;
  edition: number;
  eventId: string;
  emailHash: string;
}): string {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  pendingCodes.set(pendingKey(params.parentAddress, params.seriesId, params.edition), {
    codeHash: sha256(code),
    emailHash: params.emailHash,
    eventId: params.eventId,
    expiresAt: Date.now() + CODE_TTL_MS,
    attempts: 0,
  });
  const key = ticketKey(params.seriesId, params.edition);
  ticketSends.set(key, [...(ticketSends.get(key) ?? []), Date.now()]);
  return code;
}

export type CodeVerdict =
  | { ok: true; emailHash: string; eventId: string }
  | { ok: false; reason: "not-found" | "expired" | "too-many-attempts" | "wrong-code" };

/** Verify and consume a pending code (one-shot on success or attempt cap). */
export function verifyPendingCode(
  parentAddress: string,
  seriesId: string,
  edition: number,
  code: string,
): CodeVerdict {
  const key = pendingKey(parentAddress, seriesId, edition);
  const pending = pendingCodes.get(key);
  if (!pending) return { ok: false, reason: "not-found" };
  if (pending.expiresAt < Date.now()) {
    pendingCodes.delete(key);
    return { ok: false, reason: "expired" };
  }
  pending.attempts++;
  if (pending.attempts > MAX_CODE_ATTEMPTS) {
    pendingCodes.delete(key);
    return { ok: false, reason: "too-many-attempts" };
  }
  const presented = sha256(code.trim());
  if (!timingSafeEqual(presented, pending.codeHash)) {
    return { ok: false, reason: "wrong-code" };
  }
  pendingCodes.delete(key);
  return { ok: true, emailHash: pending.emailHash, eventId: pending.eventId };
}
