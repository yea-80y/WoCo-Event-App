/**
 * Managing the recovery backups an account already has (#148, #165).
 *
 * Setting a backup UP lives in `auth-store.setupAccountRecovery`. This module is
 * the other half — reading what protection actually exists, and taking it away —
 * and it is deliberately a separate, store-free file (S2 freeze rule): every
 * function takes the secrets it needs as arguments, so it is unit-testable and
 * auth-store gains only a thin delegation.
 *
 * TWO RULES RUN THROUGH ALL OF IT:
 *
 *  1. THE CHAIN IS THE TRUTH. `RecoveryStatus` from the server is a hint the
 *     platform signs — forgeable, withholdable, and stale the moment a user
 *     removes a backup. Protection state is read from the Kernel's own selector
 *     table and only falls back to the hint when the chain is unreadable, which
 *     is reported as "couldn't tell", never as "not protected".
 *
 *  2. REMOVAL IS ALL-OR-NOTHING, AND IT IS NOT A REPLACE. The deployed ZeroDev
 *     caller hook has no per-guardian revoke: `onInstall` ORs guardians in and
 *     nothing clears them, so "replacing" a backup only ever ADDED one and left
 *     the old one with permanent takeover power (#148). The only real revoke is
 *     uninstalling the shared `doRecovery` route, which disables every guardian
 *     at once — see `removeAllBackups` in kernel-account.ts for the on-chain
 *     mechanics and the two limits it cannot fix.
 */

import type { BuiltKernel } from "./kernel-account.js";
import type { RecoveryRouteState } from "./kernel-account.js";
import type { GuardianSetRead, RouteHookKind } from "./guardian-hook.js";

/** Where a protection answer came from — the UI must not present a hint as chain truth. */
export type ProtectionSource = "chain" | "hint" | "none";

export interface BackupProtection {
  /** `null` = could not tell. NEVER render that as "not protected" (#138). */
  isProtected: boolean | null;
  source: ProtectionSource;
  /** Raw on-chain route state, for callers that want to distinguish the reasons. */
  routeState: RecoveryRouteState;
  /**
   * Which hook gates the route when `installed` (#164). `woco` = the set below is
   * real and a per-guardian revoke exists; `legacy` = ZeroDev's append-only hook,
   * no enumeration, no revoke, replaced by the next add; `other` = not ours.
   */
  hookKind?: RouteHookKind;
  /**
   * The on-chain guardian set, read from the WoCo hook — ONLY when `hookKind` is
   * `woco`. Tri-state: `unknown` is an unreadable chain, never an empty list.
   */
  onChainGuardians?: GuardianSetRead;
}

/**
 * What the server's presence hint said. Three outcomes, not two: `null` is the
 * server answering "no document", `"unreadable"` is it not answering at all.
 */
export type HintOutcome = { configured: boolean } | null | "unreadable";

/**
 * Pure decision: given the chain read and the hint read, what may we tell the user?
 *
 * THE RULE THAT MATTERS: a platform-signed hint can attest PRESENCE — somebody
 * wrote it — but it can NEVER attest ABSENCE. Three independent reasons, all real
 * in this codebase:
 *  - the hint write at setup is explicitly non-fatal (`setupAccountRecovery`), so a
 *    genuinely protected account can legitimately have no status document at all;
 *  - the server reads it through the lenient feed read, which collapses a transient
 *    bee error into the same `null` as a real absence;
 *  - the platform signs it, so it is forgeable and withholdable by design.
 *
 * So "no hint" and "hint says not configured" both resolve to `null` — could not
 * tell — and ONLY a chain read may return `false`. Getting this wrong is not a
 * cosmetic bug: it is what lets the recovery portal tell a protected, locked-out
 * user that "recovery isn't possible for this account" (#138/#169 failure class).
 *
 * Exported and pure so the matrix is unit-tested rather than eyeballed.
 */
export function decideProtection(route: RecoveryRouteState, hint: HintOutcome): BackupProtection {
  if (route === "installed") return { isProtected: true, source: "chain", routeState: route };
  if (route === "absent") return { isProtected: false, source: "chain", routeState: route };

  if (hint && hint !== "unreadable" && hint.configured) {
    return { isProtected: true, source: "hint", routeState: "unknown" };
  }
  return { isProtected: null, source: "none", routeState: "unknown" };
}

/**
 * Does this account currently have a working recovery route?
 *
 * Chain first (`selectorConfig(doRecovery)`), the server hint only as a fallback
 * for an unreadable chain — and even then only as evidence OF protection, never
 * against it (see `decideProtection`). Callers MUST render `isProtected: null` as
 * uncertainty; presenting it as "you have no backup" is the bug this guards.
 */
export async function readBackupProtection(kernelAddress: string): Promise<BackupProtection> {
  const { readRecoveryRoute, readGuardianSet } = await import("./kernel-account.js");
  const route = await readRecoveryRoute(kernelAddress);
  if (route.state !== "unknown") {
    const protection = decideProtection(route.state, null);
    if (route.state !== "installed") return protection;
    // The set is only meaningful behind the WoCo hook; for a legacy route there is
    // nothing to enumerate and the manifest is the only (untrusted) list.
    const onChainGuardians = route.hookKind === "woco" ? await readGuardianSet(kernelAddress) : undefined;
    return { ...protection, hookKind: route.hookKind, ...(onChainGuardians ? { onChainGuardians } : {}) };
  }

  let hint: HintOutcome = "unreadable";
  try {
    const { fetchRecoveryStatus } = await import("../api/recovery.js");
    const status = await fetchRecoveryStatus(kernelAddress);
    hint = status ? { configured: !!status.configured } : null;
  } catch {
    hint = "unreadable";
  }
  return decideProtection("unknown", hint);
}

export interface RemoveBackupsOutcome {
  /**
   * Proven on-chain: no guardian can call `doRecovery` on this account. Always
   * true on return — an unproven removal throws rather than resolving false, so
   * no caller can render "backups removed" off an unverified result.
   */
  removed: true;
  /**
   * The account is not deployed, so no route can exist and no userOp was sent —
   * the ONLY case that skips the transaction. A deployed account always sends the
   * uninstall, even when the route already looks absent, because one RPC's "absent"
   * is not proof (see `removeAllBackups`).
   */
  alreadyAbsent: boolean;
  txHash?: string;
  /**
   * Server presence hint flipped AND every named guardian's reverse-index entry
   * tombstoned. False means some hint somewhere may still point at this account —
   * cosmetic (the chain governs every decision), but the flag exists to be honest,
   * so it must not report success it cannot see.
   */
  hintCleared: boolean;
  /** Local encrypted-to-self backup list retired (best-effort). */
  manifestCleared: boolean;
}

/**
 * "Remove all backups" end to end: the on-chain revoke first, then the two pieces
 * of bookkeeping that only describe it.
 *
 * ORDER IS LOAD-BEARING. The chain step throws unless the route is provably gone,
 * so nothing downstream can claim a removal that did not happen. The hint and
 * manifest clears run only afterwards and are best-effort: they hold no authority,
 * and failing them must not turn a completed revoke into a reported failure — the
 * caller reports what each flag says rather than pretending both always run.
 */
export async function removeAllAccountBackups(args: {
  kernel: BuiltKernel;
  /** The account's Kernel address (also the manifest's parent address). */
  kernelAddress: string;
  /**
   * Content-feed signer that owns + seals the manifest, or null if it could not be
   * obtained. NULL MEANS UNAVAILABLE, NOT ABSENT: for the only kinds that reach here
   * (passkey / web3auth) `_getContentFeedSigner` returns a signer or THROWS — it
   * never resolves null — so a null arriving here is a swallowed failure, and both
   * bookkeeping flags must report that nothing was done.
   */
  feedSigner: { privKey: string; address: string } | null;
  /**
   * Was the user being shown "you are protected" when they asked for this? If so,
   * a chain that reads back as undeployed is a CONTRADICTION, not a quiet success —
   * see `removeAllBackups`. Callers that offer the button off a protected state
   * must pass true; it is the guard against a lagging RPC printing a false all-clear.
   */
  expectInstalled?: boolean;
}): Promise<RemoveBackupsOutcome> {
  const { removeAllBackups } = await import("./kernel-account.js");
  const chain = await removeAllBackups(args.kernel, { expectInstalled: args.expectInstalled });

  // Read the guardian list BEFORE retiring it, and read the FULL history rather
  // than the live entries: a previous removal whose tombstone pass failed left
  // retired rows whose reverse-index hints still point at this account, and this
  // is the run that can finally clear them.
  // ENUMERATED, not just non-empty. An empty list is ambiguous — no past guardians,
  // or we never managed to look — and the server can only ever contribute the single
  // guardian named in its own status doc. So an unread history leaves every OLDER
  // auto-find hint live while the request still returns ok, which would make
  // `hintCleared` true for a clearance that did not happen.
  let guardianHistoryKnown = false;
  let guardianAddresses: string[] = [];
  let guardiansTruncated = false;
  if (args.feedSigner) {
    try {
      const { MAX_CLEAR_GUARDIANS } = await import("@woco/shared");
      const { readUserManifestResult } = await import("../manifest/inventory.js");
      // The tri-state read — a lenient one would collapse "no manifest" and
      // "couldn't read it" into the same empty array (#138/#155 class).
      const res = await readUserManifestResult({
        signer: { privKey: args.feedSigner.privKey, address: args.feedSigner.address },
        parentAddress: args.kernelAddress,
        // THOROUGH, for the same reason the tri-state read is used above. A
        // false absent hands this an EMPTY history, so it clears no auto-find
        // hints — and sets `guardianHistoryKnown = true`, suppressing the
        // "history unreadable" warning below. The user asked to remove all
        // backups and would be told it worked while every stale hint survived.
        // The chain still governs the revoke itself, so this is a privacy leak
        // rather than a lost revocation — but it is silent, and this path runs
        // once, on a deliberate user action, where a slow read costs nothing.
        thorough: true,
      });
      if (res.status !== "unavailable") {
        guardianHistoryKnown = true;
        const history = res.status === "found" ? res.manifest.backups : [];
        // The server REJECTS an over-long list rather than truncating it, so sending
        // more than the cap would clear nothing at all. Newest first, because a recent
        // guardian is the one whose auto-find hint is actually live.
        guardiansTruncated = history.length > MAX_CLEAR_GUARDIANS;
        guardianAddresses = [...history]
          .sort((a, b) => b.addedAt - a.addedAt)
          .slice(0, MAX_CLEAR_GUARDIANS)
          .map((b) => b.guardianAddress);
        if (guardiansTruncated) {
          console.warn(
            `[recovery] ${history.length} past guardians but only ${MAX_CLEAR_GUARDIANS} hints can be ` +
              "cleared per request — the oldest keep their auto-find hint (cosmetic; the chain governs).",
          );
        }
      } else {
        console.warn("[recovery] guardian history unreadable — older auto-find hints may survive");
      }
    } catch (err) {
      console.warn("[recovery] couldn't read the guardian history for tombstoning:", err);
    }
  }

  let hintCleared = false;
  try {
    const { clearRecoveryHint } = await import("../api/recovery.js");
    const res = await clearRecoveryHint({ guardianAddresses });
    // `ok` only says the request was served. Individual tombstone writes are
    // swallowed server-side, so a green response with failures is not "cleared".
    hintCleared =
      res.ok && (res.data?.failedGuardians ?? 0) === 0 && !guardiansTruncated && guardianHistoryKnown;
    if (!res.ok) console.warn("[recovery] clearing the presence hint failed (non-fatal):", res.error);
  } catch (err) {
    console.warn("[recovery] clearing the presence hint failed (non-fatal):", err);
  }

  // FALSE when there is no signer — the opposite of the obvious reading. A null
  // signer here is never "this account has no manifest": the kinds that reach this
  // function get a signer or an exception, so null means the exception was swallowed
  // and the manifest — which may well exist and still list live-looking backups —
  // was never touched. The account most likely to land here is a recovered one whose
  // escrow restore never ran, i.e. exactly the user pressing this button after an
  // incident. Claiming a clean sweep at them is the failure this flag exists to stop.
  let manifestCleared = false;
  if (args.feedSigner) {
    try {
      const { retireBackupInventory } = await import("../manifest/inventory.js");
      const result = await retireBackupInventory({
        signer: { privKey: args.feedSigner.privKey, address: args.feedSigner.address },
        parentAddress: args.kernelAddress,
      });
      // "unavailable" means we could not read the manifest, so we deliberately did
      // NOT write one. Nothing was retired — say so rather than assume.
      manifestCleared = result !== "unavailable";
      if (result === "unavailable") {
        console.warn("[recovery] backup manifest unreadable — entries not retired (non-fatal)");
      }
    } catch (err) {
      manifestCleared = false;
      console.warn("[recovery] retiring the backup manifest failed (non-fatal):", err);
    }
  }

  return {
    removed: true,
    alreadyAbsent: chain.alreadyAbsent,
    txHash: chain.txHash,
    hintCleared,
    manifestCleared,
  };
}

export interface RevokeBackupOutcome {
  /** Proven on-chain: this guardian is no longer in the account's set. Always true on return. */
  revoked: true;
  txHash: string;
  /** Its reverse-index hint tombstoned (presence hint left standing — other backups still work). */
  hintCleared: boolean;
  /** Its manifest row marked retired (best-effort; an unreadable manifest reports false). */
  manifestMarked: boolean;
}

/**
 * Revoke ONE backup (#164) — the per-guardian removal the legacy hook could not
 * offer. Same shape as `removeAllAccountBackups`: the on-chain revoke first and it
 * THROWS unless the hook's set provably no longer contains the guardian; only then
 * the two pieces of bookkeeping, best-effort and reported, never assumed.
 *
 * The presence hint is deliberately left standing (`keepStatus`): the account still
 * has working backups, and flipping it would make the portal's chain-unreadable
 * fallback tell a protected user "no backup found".
 */
export async function revokeAccountBackup(args: {
  kernel: BuiltKernel;
  kernelAddress: string;
  guardianAddress: string;
  feedSigner: { privKey: string; address: string } | null;
}): Promise<RevokeBackupOutcome> {
  const { revokeGuardianOnChain } = await import("./kernel-account.js");
  const chain = await revokeGuardianOnChain(args.kernel, args.guardianAddress);

  let hintCleared = false;
  try {
    const { clearRecoveryHint } = await import("../api/recovery.js");
    const res = await clearRecoveryHint({ guardianAddresses: [args.guardianAddress], keepStatus: true });
    hintCleared = res.ok && (res.data?.failedGuardians ?? 0) === 0;
    if (!res.ok) console.warn("[recovery] tombstoning the revoked guardian's hint failed (non-fatal):", res.error);
  } catch (err) {
    console.warn("[recovery] tombstoning the revoked guardian's hint failed (non-fatal):", err);
  }

  // FALSE without a signer, for the reason `removeAllAccountBackups` spells out: a
  // null signer is a swallowed failure, not "no manifest".
  let manifestMarked = false;
  if (args.feedSigner) {
    try {
      const { retireOneBackup } = await import("../manifest/inventory.js");
      const result = await retireOneBackup({
        signer: { privKey: args.feedSigner.privKey, address: args.feedSigner.address },
        parentAddress: args.kernelAddress,
        guardianAddress: args.guardianAddress,
      });
      manifestMarked = result !== "unavailable";
      if (result === "unavailable") {
        console.warn("[recovery] backup manifest unreadable — entry not retired (non-fatal)");
      }
    } catch (err) {
      console.warn("[recovery] retiring the backup manifest entry failed (non-fatal):", err);
    }
  }

  return { revoked: true, txHash: chain.txHash, hintCleared, manifestMarked };
}
