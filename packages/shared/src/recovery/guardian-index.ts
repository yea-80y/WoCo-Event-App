/**
 * The guardian's own account index — what lets a locked-out user connect their
 * backup wallet and have the portal FIND their account (#157).
 *
 * It used to be a platform-signed feed keyed by the (public, derivable) guardian
 * address, written by the server from whatever `guardianAddress` an
 * authenticated caller sent. That made it world-writable — any account could
 * claim any guardian and point the victim's auto-find at itself — and its
 * public read linked a Kernel to its backup for anyone who asked.
 *
 * Now it is a Single-Owner Chunk OWNED BY THE GUARDIAN: the SOC signer is
 * derived from the backup wallet's signature (`deriveGuardianKeys().socSigner`,
 * the same key that owns the escrow envelope), so
 *  - only the holder of the backup wallet can write it — there is nothing for a
 *    third party to overwrite or evict;
 *  - its address is derived from a SIGNATURE, not from the backup address, so
 *    nobody can compute where to look without the backup wallet — the
 *    guardian↔account link is no longer a one-call public lookup;
 *  - the server is not in the loop at all: no write on its behalf, no read
 *    endpoint, no platform feed to withhold.
 *
 * ONE index per guardian, listing every account that guardian protects (a
 * backup wallet may guard several). Written through the versioned content-feed
 * rail (`writeContentFeed`), read back with the tri-state reader.
 *
 * It is a DISCOVERY hint, not an authority: the portal confirms each candidate
 * against the chain (`isGuardianRegistered`) and the ceremony proves ownership
 * by decrypting the escrow. A stale entry (the account removed this backup
 * without the backup wallet present — it cannot rewrite this index) is filtered
 * by that chain check, which is stronger than the tombstones it replaces.
 */

export const GUARDIAN_ACCOUNT_INDEX_FORMAT = "woco.guardian-account-index.v1" as const;

/**
 * Fixed content-feed topic. The OWNER (guardian SOC signer) is what makes it
 * unique per guardian, so the topic needs no key of its own.
 */
export const GUARDIAN_ACCOUNT_INDEX_TOPIC = "woco/recovery/guardian-account-index/v1";

/**
 * Sanity ceiling on accounts one backup wallet lists. Only the guardian writes
 * here, so this bounds a bug, not a third party; past it the add is refused and
 * the portal's manual entry still works.
 */
export const MAX_GUARDIAN_INDEX_ACCOUNTS = 64;

export interface GuardianAccountEntry {
  /** Lowercased Kernel address this guardian can recover. */
  kernelAddress: string;
  /** Optional sub-ENS label ({label}.woco.eth) for a human-readable confirmation. */
  label?: string;
  /** ms-epoch when the entry was (first) written — candidates are tried oldest first. */
  addedAt: number;
}

export interface GuardianAccountIndex {
  format: typeof GUARDIAN_ACCOUNT_INDEX_FORMAT;
  accounts: GuardianAccountEntry[];
}

const ADDR_RE = /^0x[0-9a-f]{40}$/;
const LABEL_RE = /^[a-z0-9-]{1,63}$/;

export function isGuardianAccountEntry(v: unknown): v is GuardianAccountEntry {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.kernelAddress !== "string" || !ADDR_RE.test(o.kernelAddress)) return false;
  if (o.label !== undefined && (typeof o.label !== "string" || !LABEL_RE.test(o.label))) return false;
  return typeof o.addedAt === "number" && Number.isFinite(o.addedAt) && o.addedAt >= 0;
}

/** Structural check for bytes read back from Swarm — a foreign payload is not an index. */
export function isGuardianAccountIndex(v: unknown): v is GuardianAccountIndex {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.format !== GUARDIAN_ACCOUNT_INDEX_FORMAT) return false;
  if (!Array.isArray(o.accounts) || o.accounts.length > MAX_GUARDIAN_INDEX_ACCOUNTS) return false;
  return o.accounts.every(isGuardianAccountEntry);
}

export function emptyGuardianAccountIndex(): GuardianAccountIndex {
  return { format: GUARDIAN_ACCOUNT_INDEX_FORMAT, accounts: [] };
}

export type UpsertGuardianAccountResult =
  | { kind: "unchanged"; index: GuardianAccountIndex }
  | { kind: "written"; index: GuardianAccountIndex }
  | { kind: "refused"; reason: string };

/**
 * Add or refresh one account in the index. Pure. Case is folded on the address;
 * a re-protect with the same backup keeps the ORIGINAL `addedAt` (the portal
 * tries oldest first, and re-protecting must not demote an account) but takes
 * the new label. `unchanged` means nothing needs writing — a SOC write is a
 * stamped chunk, so the caller should skip it.
 */
export function upsertGuardianAccount(
  current: GuardianAccountIndex | null,
  entry: { kernelAddress: string; label?: string; addedAt: number },
): UpsertGuardianAccountResult {
  const kernel = entry.kernelAddress.toLowerCase();
  if (!ADDR_RE.test(kernel)) return { kind: "refused", reason: `not an address: ${entry.kernelAddress}` };
  const label = entry.label?.toLowerCase();
  if (label !== undefined && !LABEL_RE.test(label)) return { kind: "refused", reason: `bad label: ${entry.label}` };
  if (!Number.isFinite(entry.addedAt) || entry.addedAt < 0) return { kind: "refused", reason: "bad addedAt" };

  const base = current ?? emptyGuardianAccountIndex();
  const i = base.accounts.findIndex((a) => a.kernelAddress === kernel);
  if (i >= 0) {
    const prev = base.accounts[i]!;
    if (prev.label === label) return { kind: "unchanged", index: base };
    const accounts = base.accounts.slice();
    accounts[i] = { kernelAddress: kernel, addedAt: prev.addedAt, ...(label ? { label } : {}) };
    return { kind: "written", index: { format: GUARDIAN_ACCOUNT_INDEX_FORMAT, accounts } };
  }
  if (base.accounts.length >= MAX_GUARDIAN_INDEX_ACCOUNTS) {
    return { kind: "refused", reason: `index already lists ${MAX_GUARDIAN_INDEX_ACCOUNTS} accounts` };
  }
  return {
    kind: "written",
    index: {
      format: GUARDIAN_ACCOUNT_INDEX_FORMAT,
      accounts: [...base.accounts, { kernelAddress: kernel, addedAt: entry.addedAt, ...(label ? { label } : {}) }],
    },
  };
}

/**
 * The order the portal tries candidates in: oldest first, duplicates (by
 * address, any case) collapsed to the first seen. Oldest first because the
 * entry that has been there longest is the one the user most likely means, and
 * because it is the order the guardian wrote them in.
 */
export function orderGuardianCandidates(index: GuardianAccountIndex): GuardianAccountEntry[] {
  const seen = new Set<string>();
  return [...index.accounts]
    .sort((a, b) => a.addedAt - b.addedAt)
    .filter((a) => {
      const k = a.kernelAddress.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((a) => ({ ...a, kernelAddress: a.kernelAddress.toLowerCase() }));
}
