/**
 * Issuer-binding verification + the pinned parent → issuer record
 * (issuer-curve migration PR 5a; design record: HANDOVER-pod-curve-migration.md).
 *
 * Every create payload that asserts an issuer identity (event create, badge
 * mint) carries an `IssuerBindingV1`: the derived issuing key's personal-sign
 * over `woco-issuer-binding-v1\n{parent}\n{gen}`. This module is the ONLY
 * place that proof is checked, and the check is the #345 rule made executable:
 * never accept a client-asserted issuer identity without proof of possession.
 *
 * WHY THE PAYLOAD'S MANIFESTS ARE NOT PROOF ENOUGH: a signed manifest proves
 * its key exists and signed THAT manifest — but manifests are public, so
 * anyone could replay someone else's into their own authenticated create and
 * have a FOREIGN issuer pinned to their parent. The binding signs the parent,
 * which a replayer cannot produce for a parent the key never named.
 *
 * THE PIN (`.data/issuer-bindings.json`) is the issuer registry's seed entry
 * (PR 5b): one parent, one gen-0 issuer. A create naming a DIFFERENT issuer
 * for a parent that already has one is REFUSED — the issuing key is
 * seed-derived and the seed is escrowed, so a divergent issuer on the same
 * account is either a client bug or the seed-divergence class (#149/#174)
 * surfacing, and both must be LOUD, not silently recorded. Rotation (a gen
 * bump) arrives with the registry statement in 5b, not here.
 *
 * The binding is deliberately REPLAYABLE — it asserts a durable fact. The
 * guard is that it is only accepted inside a session-authenticated create
 * whose VERIFIED parent must equal the parent in the signed message; freshness
 * would add nothing (see `crypto/issuing.ts`).
 *
 * Survives restarts (loaded lazily, written through `writeJsonAtomic` so the
 * #130 file-mode guarantee holds by construction). Losing the file loses the
 * divergence tripwire until each parent's next create re-pins it — real, but
 * self-healing; it is not on the CLAUDE.md must-survive list for that reason.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildIssuerBindingMessage,
  isIssuerAddress,
  recoverPersonalSigner,
  type IssuerBindingV1,
} from "@woco/shared";
import { writeJsonAtomic } from "../marketing/persist.js";

const STORE_FILE = join(process.cwd(), ".data", "issuer-bindings.json");

export interface IssuerBindingRecord {
  /** The pinned issuing ADDRESS (0x + 40 lowercase hex) — the CURRENT generation's. */
  issuer: string;
  /** Current issuing-key generation (bumped by registry rotations, PR 5b). */
  gen: number;
  /** The proof-of-possession signature that pinned it, kept as evidence. */
  sig: string;
  boundAt: string;
  /** What pinned it: "event-create" | "pod-mint" | "issuer-statement" | "rotation". */
  source: string;
  /** Issuing addresses this parent ROTATED AWAY FROM — refused everywhere a
   *  current issuer is expected, and the gate write boundary refuses badges
   *  whose manifest names one (the leaked-key containment seam, PR 5b). */
  retiredIssuers?: string[];
}

let bindings = new Map<string, IssuerBindingRecord>();
/** Flat view of every parent's retiredIssuers, for O(1) refusals. */
let retired = new Set<string>();
let loaded = false;

function rebuildRetired(): void {
  retired = new Set();
  for (const rec of bindings.values()) {
    for (const r of rec.retiredIssuers ?? []) retired.add(r);
  }
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const obj = JSON.parse(readFileSync(STORE_FILE, "utf-8")) as Record<string, IssuerBindingRecord>;
    if (obj && typeof obj === "object") bindings = new Map(Object.entries(obj));
    rebuildRetired();
  } catch {
    // File doesn't exist yet — that's fine.
  }
}

function persist(): void {
  writeJsonAtomic(STORE_FILE, Object.fromEntries(bindings), "issuer-bindings");
}

export type BindingVerdict = { ok: true } | { ok: false; error: string };

/**
 * Verify a create payload's issuer binding and pin it for `parentAddress`.
 *
 * `parentAddress` MUST be the session-verified parent (the route's
 * `parentAddress`), never a value from the body — it is lowercased here
 * because the client signs the LOWERCASE form and the auth middleware may
 * carry checksummed case. `manifestIssuers` are the `body.issuer` values of
 * every manifest in the payload; full signature verification of those
 * manifests happens in the create pipeline — this check makes the identities
 * one chain: possession of key K + K signed the manifests + K named THIS
 * parent.
 *
 * Every refusal is distinct so a producer bug is diagnosable from the message
 * alone. Never throws.
 */
export function verifyAndPinIssuerBinding(
  parentAddress: string,
  binding: unknown,
  manifestIssuers: readonly string[],
  source: "event-create" | "pod-mint" | "issuer-statement",
): BindingVerdict {
  const parent = parentAddress.toLowerCase();

  if (binding === null || typeof binding !== "object" || Array.isArray(binding)) {
    return { ok: false, error: "issuerBinding is required" };
  }
  const b = binding as Partial<IssuerBindingV1>;
  if (!isIssuerAddress(b.issuer)) {
    return { ok: false, error: "issuerBinding.issuer must be a 0x-prefixed lowercase 20-byte address" };
  }
  if (typeof b.gen !== "number" || !Number.isInteger(b.gen) || b.gen < 0) {
    return { ok: false, error: "issuerBinding.gen must be a non-negative integer" };
  }

  let message: string;
  try {
    message = buildIssuerBindingMessage(parent, b.gen);
  } catch {
    return { ok: false, error: "could not build the issuer-binding message for this account" };
  }
  const recovered = recoverPersonalSigner(message, b.sig);
  if (!recovered) {
    return { ok: false, error: "issuerBinding.sig is not a valid signature over this account's binding message" };
  }
  if (recovered !== b.issuer) {
    return {
      ok: false,
      error: "issuerBinding.sig was not made by the claimed issuer address — proof of possession failed",
    };
  }

  for (const mi of manifestIssuers) {
    if (mi !== b.issuer) {
      return {
        ok: false,
        error: "a manifest in this payload names a different issuer than the binding — refusing to pin either",
      };
    }
  }

  ensureLoaded();
  const existing = bindings.get(parent);
  if (existing) {
    // The pinned record is the truth about this account's CURRENT generation.
    // A binding for another generation is a stale or premature client, and a
    // binding for another issuer at the current generation is either a client
    // bug or the seed-divergence class — both surface loudly.
    if (b.gen !== existing.gen) {
      return {
        ok: false,
        error: `this account's issuing key is at generation ${existing.gen} — the create must bind the current generation`,
      };
    }
    if (b.issuer !== existing.issuer) {
      return {
        ok: false,
        error:
          "this account is already bound to a different issuer address — refusing to record a second issuer identity",
      };
    }
    return { ok: true };
  }
  // No record: an account with no rotation history starts at generation 0.
  if (b.gen !== 0) {
    return { ok: false, error: "issuerBinding.gen must be 0 — an account with no rotation history starts at generation 0" };
  }
  bindings.set(parent, {
    issuer: b.issuer,
    gen: 0,
    sig: b.sig as string,
    boundAt: new Date().toISOString(),
    source,
  });
  persist();
  return { ok: true };
}

/**
 * Apply a REGISTRY-VERIFIED rotation: bump the pinned record to the new
 * generation and retire the outgoing issuer. The caller
 * (`lib/issuer/registry.ts`) has already verified the parent-signed statement,
 * the PoP and the sequencing — this only mutates state, and refuses rather
 * than guesses if called out of order.
 */
export function applyIssuerRotation(
  parentAddress: string,
  newIssuer: string,
  newGen: number,
  bindingSig: string,
): BindingVerdict {
  ensureLoaded();
  const parent = parentAddress.toLowerCase();
  const existing = bindings.get(parent);
  if (!existing || newGen !== existing.gen + 1) {
    return { ok: false, error: "rotation out of order — the pinned record does not precede this generation" };
  }
  bindings.set(parent, {
    issuer: newIssuer,
    gen: newGen,
    sig: bindingSig,
    boundAt: new Date().toISOString(),
    source: "rotation",
    retiredIssuers: [...(existing.retiredIssuers ?? []), existing.issuer],
  });
  rebuildRetired();
  persist();
  return { ok: true };
}

/** Has ANY parent rotated away from this issuing address? Refused at the gate
 *  write boundary — a badge under a retired key is a badge a leaked key could
 *  have minted after the bump. */
export function isRetiredIssuer(issuer: string): boolean {
  ensureLoaded();
  return retired.has(issuer.toLowerCase());
}

/** The pinned binding for a parent, if any (lowercased lookup). */
export function getIssuerBinding(parentAddress: string): IssuerBindingRecord | null {
  ensureLoaded();
  return bindings.get(parentAddress.toLowerCase()) ?? null;
}

/** Test seam — the store is process-lifetime state. */
export function _resetIssuerBindings(): void {
  bindings = new Map();
  retired = new Set();
  loaded = true;
}
