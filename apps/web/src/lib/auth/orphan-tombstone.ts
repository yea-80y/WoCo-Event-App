/**
 * Durable orphan tombstone (#283): "this credential's account was recovered
 * away — don't rebuild here."
 *
 * WHY IT EXISTS. #255's honest refusal needs something to trip on: a binding,
 * or an envelope. The ORIGINAL credential of a recovered account carries
 * neither — its own counterfactual IS the preserved Kernel — so after the
 * account is recovered elsewhere, the kaddr fast path signs it straight back
 * into an account whose every request now fails. The envelope re-probe already
 * READS the proof (a deployed Kernel whose live owner is someone else); this
 * record is that proof, kept, so the next login can refuse honestly instead of
 * re-entering a dead session.
 *
 * WRITE RULE — chain-proof only. A tombstone is written from exactly one
 * place, the re-probe's `orphaned` outcome, and only off an ANSWERED foreign
 * owner (never silence, never a cache — the #277 rule). It is the mirror image
 * of the re-probe's terminal `ok` record.
 *
 * NO DELETE, ON PURPOSE. The fact cannot become false: every recovery mints a
 * FRESH credential, so a retired one never owns its account again — a new
 * recovery on this device gets its own clean credential with its own binding,
 * and this credential stays correctly refused. A tombstone that is somehow
 * wrong (a chain that lied) can only refuse a login that recovery repairs,
 * never grant one — and clearing site data remains the escape hatch, same as
 * every other device-local record.
 *
 * CORRUPT READS AS ABSENT. A refusal must rest on a well-formed proof; a
 * garbled note downgrades to the pre-#283 behavior (dead-session entry, healed
 * by the #256 banner) rather than refusing on evidence nobody can inspect.
 */

import type { OrphanedCredentialKind } from "./orphaned-credential.js";

export interface OrphanTombstone {
  /** The Kernel this credential used to open — its own counterfactual. */
  kernel: string;
  /** The on-chain owner that displaced it, as the chain answered. */
  owner: string;
  /** Epoch ms when the proof was read. Forensics only — never logic. */
  at: number;
}

/** The two storage ops this module needs, so tests need no DOM. */
export interface TombstoneStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PREFIX = "woco:korphan:";
const ADDR = /^0x[0-9a-f]{40}$/;

function keyOf(kind: OrphanedCredentialKind, eoa: string): string {
  return `${PREFIX}${kind}:${eoa.toLowerCase()}`;
}

export function readOrphanTombstone(
  kind: OrphanedCredentialKind,
  eoa: string,
  store: TombstoneStorage | undefined = globalThis.localStorage,
): OrphanTombstone | null {
  try {
    const raw = store?.getItem(keyOf(kind, eoa));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<OrphanTombstone>;
    if (typeof p.kernel !== "string" || !ADDR.test(p.kernel)) return null;
    if (typeof p.owner !== "string" || !ADDR.test(p.owner)) return null;
    return { kernel: p.kernel, owner: p.owner, at: typeof p.at === "number" ? p.at : 0 };
  } catch {
    return null;
  }
}

export function writeOrphanTombstone(
  kind: OrphanedCredentialKind,
  eoa: string,
  fact: { kernel: string; owner: string },
  store: TombstoneStorage | undefined = globalThis.localStorage,
): void {
  try {
    store?.setItem(
      keyOf(kind, eoa),
      JSON.stringify({
        kernel: fact.kernel.toLowerCase(),
        owner: fact.owner.toLowerCase(),
        at: Date.now(),
      }),
    );
  } catch {
    /* best-effort: without it the next login re-enters the dead account and
       the #256 banner carries the explanation instead */
  }
}
