/**
 * Who to read — the participant registry.
 *
 * A tally is a function of the statements ingested, and ingesting requires
 * knowing whose feeds to open. Feed topics resolve inside an OWNER's address
 * space (`chunk address = keccak256(identifier || owner)`), so the same topic
 * string names a different chunk per person: without a set of owners there is
 * no address to read, and the count is not "empty", it is uncomputable.
 *
 * HOW OWNERS GET HERE, and why it needs no new trust. The relay sees every
 * client-signed SOC it stamps, but only as (owner, identifier, bytes) — the
 * identifier is a hash, so the topic cannot be inverted from it. The payload,
 * however, is self-describing: a public statement carries its own `format` and
 * `subject`, which is everything needed to recompute the topic later. So the
 * registry is populated by READING what we were already asked to store, not by
 * trusting a client-supplied label.
 *
 * That has a property worth naming: an ENCRYPTED statement is opaque to us, so
 * it is never registered and never counted. Privacy is enforced by the same
 * mechanism that makes counting possible, rather than by a flag we must
 * remember to honour.
 *
 * REBUILDABILITY (commitment 6). This file is a cache, not truth. Losing it
 * shrinks the index to whoever writes next — bad, not fatal, and honest to say
 * out loud. The durable copy is the `participants` list inside each published
 * evidence manifest, which is exactly why that field exists: an index rebuilt
 * from a manifest recovers the input set without asking us.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../marketing/persist.js";

const STORE_FILE = join(process.cwd(), ".data", "social-participants.json");

/** format -> subject -> feed owners known to have written about it. */
type Registry = Record<string, Record<string, string[]>>;

/** Statement formats the relay may register. Public types only — a sealed
 *  payload never parses, so credits appear here only once published. */
const INDEXABLE_FORMATS = new Set(["woco.like.v1", "woco.follow.v1", "woco.credit.v1"]);

const SUBJECT_RE = /^0x[0-9a-f]{64}$/;
const OWNER_RE = /^0x[0-9a-f]{40}$/;

let registry: Registry = load();
/** Serialises the read-modify-write so two concurrent relays cannot each
 *  rewrite the file from a stale copy — the same lost-update shape the client
 *  index has, with the same fix. */
let writeChain: Promise<unknown> = Promise.resolve();

function load(): Registry {
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Registry) : {};
  } catch {
    // Absent on first boot, and unreadable is treated the same way ON PURPOSE:
    // there is nothing to protect here, and refusing to start over a cache
    // would be worse than rebuilding it from the next writes.
    return {};
  }
}

/**
 * Register a feed owner as having written about a subject, if the bytes we were
 * asked to stamp turn out to be a public statement.
 *
 * Never throws and never blocks the write it observes. This is bookkeeping for
 * a view-plane cache; a failure here must not fail a user's like.
 */
export function observeStatementBytes(ownerHex: string, payload: Uint8Array): void {
  try {
    const owner = (ownerHex.startsWith("0x") ? ownerHex : `0x${ownerHex}`).toLowerCase();
    if (!OWNER_RE.test(owner)) return;

    const parsed: unknown = JSON.parse(new TextDecoder().decode(payload));
    if (!parsed || typeof parsed !== "object") return;
    const o = parsed as Record<string, unknown>;

    const format = o.format;
    const subject = o.subject;
    if (typeof format !== "string" || !INDEXABLE_FORMATS.has(format)) return;
    if (typeof subject !== "string" || !SUBJECT_RE.test(subject)) return;

    const owners = registry[format]?.[subject];
    if (owners?.includes(owner)) return; // already known — no write, no churn

    registry[format] ??= {};
    registry[format]![subject] ??= [];
    registry[format]![subject]!.push(owner);
    persist();
  } catch {
    // Not JSON, sealed, or malformed — all mean "not an indexable statement".
  }
}

function persist(): void {
  const snapshot: Registry = JSON.parse(JSON.stringify(registry));
  writeChain = writeChain
    .catch(() => undefined)
    .then(() => {
      writeJsonAtomic(STORE_FILE, snapshot, "social-participants");
    });
}

/** Feed owners known to have written about `subject` under `format`. */
export function participantsFor(format: string, subject: string): string[] {
  return [...(registry[format]?.[subject.toLowerCase()] ?? [])].sort();
}

/** Every subject we hold participants for, under a format. */
export function knownSubjects(format: string): string[] {
  return Object.keys(registry[format] ?? {}).sort();
}

/**
 * Merge participants recovered from a published evidence manifest. This is the
 * rebuild path: an operator (or another indexer) can restore the input set from
 * public data rather than from our disk.
 */
export function mergeParticipants(format: string, subject: string, owners: readonly string[]): number {
  if (!INDEXABLE_FORMATS.has(format) || !SUBJECT_RE.test(subject)) return 0;
  registry[format] ??= {};
  const list = (registry[format]![subject] ??= []);
  let added = 0;
  for (const raw of owners) {
    const owner = raw.toLowerCase();
    if (!OWNER_RE.test(owner) || list.includes(owner)) continue;
    list.push(owner);
    added++;
  }
  if (added > 0) persist();
  return added;
}

/** Test seam — resets in-memory state without touching disk. */
export function __resetParticipants(next: Registry = {}): void {
  registry = next;
}
