/**
 * The issuer-registry RELAY (issuer-curve migration PR 5b; design record:
 * HANDOVER-pod-curve-migration.md + `packages/shared/src/issuer/types.ts`).
 *
 * The server attests NOTHING here — every statement is parent-signed EIP-712
 * with the issuing key's own proof of possession, and any client re-verifies
 * the published log from bytes alone (`verifyIssuerLog`). What the relay
 * adds is exactly three things a signature cannot:
 *
 *  1. WHO MAY WRITE — the session-authenticated route only relays a statement
 *     whose `parent` is the verified session parent (the #433 lesson: the
 *     record must be unwritable by anyone but its owner);
 *  2. SEQUENCING — one statement per generation, stepping by exactly 1 from
 *     the pinned record, so the published log is always a verifiable chain;
 *  3. THE SIDE EFFECTS — the binding-store pin/rotation (which the create
 *     rails and the gate boundary enforce against) and the platform feed
 *     write at `woco/issuer/{parent}`.
 *
 * DURABILITY BEFORE PUBLICATION: the log store is written first (atomic),
 * then the feed. A feed write that fails leaves `published: false` and the
 * client retries the SAME statement — the relay recognises the byte-identical
 * republish and only re-publishes, so a flaky gateway can never fork state.
 *
 * The log rides ONE 4096-byte JSON feed page (gzip fallback). A statement is
 * ~700 bytes raw, rotations are rare, and `encodeJsonFeed` throws loudly at
 * the ceiling — paging is a later problem and will announce itself.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ISSUER_LOG_FORMAT,
  buildIssuerRotationMessage,
  recoverPersonalSigner,
  verifyIssuerStatement,
  type IssuerLogV1,
  type IssuerStatementV1,
} from "@woco/shared";
import { writeJsonAtomic } from "../marketing/persist.js";
import { writeFeedPage, encodeJsonFeed } from "../swarm/feeds.js";
import { topicIssuerRegistry } from "../swarm/topics.js";
import {
  applyIssuerRotation,
  getIssuerBinding,
  verifyAndPinIssuerBinding,
  type IssuerBindingRecord,
} from "./binding.js";

const STORE_FILE = join(process.cwd(), ".data", "issuer-registry.json");

let logs = new Map<string, IssuerStatementV1[]>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const obj = JSON.parse(readFileSync(STORE_FILE, "utf-8")) as Record<string, IssuerStatementV1[]>;
    if (obj && typeof obj === "object") logs = new Map(Object.entries(obj));
  } catch {
    // File doesn't exist yet — that's fine.
  }
}

function persist(): void {
  writeJsonAtomic(STORE_FILE, Object.fromEntries(logs), "issuer-registry");
}

function logFor(parent: string): IssuerLogV1 {
  return {
    format: ISSUER_LOG_FORMAT,
    parent: parent as IssuerLogV1["parent"],
    statements: logs.get(parent) ?? [],
  };
}

async function publishLog(parent: string): Promise<boolean> {
  try {
    await writeFeedPage(topicIssuerRegistry(parent), encodeJsonFeed(logFor(parent)));
    return true;
  } catch (err) {
    console.warn(`[issuer] registry feed write failed for ${parent.slice(0, 10)}:`, err);
    return false;
  }
}

export type RelayResult =
  | { ok: true; published: boolean; gen: number }
  | { ok: false; error: string };

/**
 * Verify, sequence, record and publish one statement.
 *
 * `verifiedParent` MUST be the session-verified parent — never a body value.
 */
export async function relayIssuerStatement(
  verifiedParent: string,
  value: unknown,
): Promise<RelayResult> {
  const parent = verifiedParent.toLowerCase();

  const v = verifyIssuerStatement(value);
  if (!v.ok) return { ok: false, error: v.error };
  const s = v.statement;

  if (s.parent !== parent) {
    return { ok: false, error: "the statement names a different account than this session" };
  }

  ensureLoaded();
  const existing = logs.get(parent) ?? [];
  const record = getIssuerBinding(parent);

  // Byte-identical republish: heal a previously failed feed write, change
  // nothing else. Compared as JSON — the closed schema has no float or
  // key-order ambiguity to exploit here.
  const last = existing[existing.length - 1];
  if (last && JSON.stringify(last) === JSON.stringify(s)) {
    return { ok: true, published: await publishLog(parent), gen: s.gen };
  }

  if (existing.some((e) => e.gen === s.gen)) {
    return {
      ok: false,
      error: `a different statement for generation ${s.gen} already stands — one statement per generation`,
    };
  }

  if (existing.length === 0) {
    // SEED statement — makes the gen-0 binding public and client-verifiable.
    // REQUIRED before any rotation: a published log must be a chain a reader
    // can verify from its first entry, and `verifyIssuerLog` (rightly) refuses
    // a first entry that claims to be a rotation.
    if (s.gen !== 0) {
      return { ok: false, error: "publish the generation-0 statement first — a log starts at its seed" };
    }
    if (s.prevSig !== undefined) {
      return { ok: false, error: "a seed statement cannot carry a rotation co-signature" };
    }
    // The pin runs through the SAME path the create rails use, so the
    // divergence and generation rules hold here too. For an account already
    // pinned by a create this is an idempotent match — the ordinary case.
    const pin = verifyAndPinIssuerBinding(
      parent,
      { issuer: s.issuer, gen: 0, sig: s.bindingSig },
      [],
      "issuer-statement",
    );
    if (!pin.ok) return pin;
  } else {
    // ROTATION: exactly one generation forward from the published chain. The
    // pinned record moves in lockstep with the log (every path below updates
    // both), so `last` and `record` agree — the record is used for the
    // co-signature check because it is what the create rails enforce against.
    if (!record || s.gen !== last!.gen + 1 || record.gen !== last!.gen) {
      return {
        ok: false,
        error: `this account is at generation ${last!.gen} — the next statement must declare generation ${last!.gen + 1}`,
      };
    }
    if (s.prevSig !== undefined) {
      const coSigner = recoverPersonalSigner(
        buildIssuerRotationMessage(parent, record.gen, s.gen, s.issuer),
        s.prevSig,
      );
      if (coSigner !== record.issuer) {
        return { ok: false, error: "prevSig is not the outgoing issuer's co-signature for this rotation" };
      }
    }
    // An ABSENT prevSig is accepted — break-glass, permanently visible as an
    // unattested rotation in the published log (see shared issuer/types.ts).
    const rotated = applyIssuerRotation(parent, s.issuer, s.gen, s.bindingSig);
    if (!rotated.ok) return rotated;
  }

  logs.set(parent, [...existing, s]);
  persist();
  return { ok: true, published: await publishLog(parent), gen: s.gen };
}

export interface IssuerRegistryView {
  /** The CURRENT binding — the 5a pin, kept current by rotations. Null only
   *  for an account that has never created or published anything. */
  current: IssuerBindingRecord | null;
  /** The published statement chain (may be empty — gen 0 needs no statement). */
  statements: IssuerStatementV1[];
}

export function getIssuerRegistry(parentAddress: string): IssuerRegistryView {
  ensureLoaded();
  const parent = parentAddress.toLowerCase();
  return { current: getIssuerBinding(parent), statements: logs.get(parent) ?? [] };
}

/** Test seam — the store is process-lifetime state. */
export function _resetIssuerRegistry(): void {
  logs = new Map();
  loaded = true;
}
