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
  /** The pinned issuing ADDRESS (0x + 40 lowercase hex). */
  issuer: string;
  /** Issuing-key generation — 0 until the registry ships (5b). */
  gen: number;
  /** The proof-of-possession signature that pinned it, kept as evidence. */
  sig: string;
  boundAt: string;
  /** Which create pinned it first: "event-create" | "pod-mint". */
  source: string;
}

let bindings = new Map<string, IssuerBindingRecord>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const obj = JSON.parse(readFileSync(STORE_FILE, "utf-8")) as Record<string, IssuerBindingRecord>;
    if (obj && typeof obj === "object") bindings = new Map(Object.entries(obj));
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
  source: "event-create" | "pod-mint",
): BindingVerdict {
  const parent = parentAddress.toLowerCase();

  if (binding === null || typeof binding !== "object" || Array.isArray(binding)) {
    return { ok: false, error: "issuerBinding is required" };
  }
  const b = binding as Partial<IssuerBindingV1>;
  if (!isIssuerAddress(b.issuer)) {
    return { ok: false, error: "issuerBinding.issuer must be a 0x-prefixed lowercase 20-byte address" };
  }
  // Gen-0 only until the registry (5b) exists: a gen > 0 binding would claim a
  // rotation nothing can anchor or audit yet. Refusing is the honest answer.
  if (b.gen !== 0) {
    return { ok: false, error: "issuerBinding.gen must be 0 — generation rotation arrives with the issuer registry" };
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
  if (existing && existing.issuer !== b.issuer) {
    // Seed-derived keys cannot legitimately diverge for one account at gen 0.
    // This firing means a client bug or the seed-divergence class — surface it.
    return {
      ok: false,
      error:
        "this account is already bound to a different issuer address — refusing to record a second issuer identity",
    };
  }
  if (!existing) {
    bindings.set(parent, {
      issuer: b.issuer,
      gen: 0,
      sig: b.sig as string,
      boundAt: new Date().toISOString(),
      source,
    });
    persist();
  }
  return { ok: true };
}

/** The pinned binding for a parent, if any (lowercased lookup). */
export function getIssuerBinding(parentAddress: string): IssuerBindingRecord | null {
  ensureLoaded();
  return bindings.get(parentAddress.toLowerCase()) ?? null;
}

/** Test seam — the store is process-lifetime state. */
export function _resetIssuerBindings(): void {
  bindings = new Map();
  loaded = true;
}
