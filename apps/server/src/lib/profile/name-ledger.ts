/**
 * Which sub-ENS name is an account's PROFILE name, and when it may change.
 *
 * Two things need this and neither can get it from anywhere else:
 *
 *  1. The binding points (`stamp-event`, the site deploy hook, `set-contenthash`)
 *     must refuse to point an account's PROFILE name at an event or a site. A
 *     name's on-chain record cannot say which role it plays — `ownerOf` answers
 *     "who holds it", never "is this their identity or a URL" — and the profile
 *     feed is CLIENT-signed under Phase B, so its `subEnsLabel` is the user's
 *     own claim rather than anything the server may trust. This ledger is the
 *     server's only record of the role, written exclusively at the two points
 *     where the server itself verified ownership on-chain.
 *
 *  2. The rename cooldown. WoCo pays for every rename (the mint is sponsored or
 *     permit-gassed; the release is a paymaster-sponsored userOp with no
 *     on-chain cap), and rapid cycling churns the namespace and confuses
 *     followers. The registrar's per-recipient mint cap bounds VOLUME; nothing
 *     on-chain bounds how often one identity changes its name.
 *
 * WHAT THIS IS NOT: authority over a name. Chain ownership is the authority and
 * is re-checked live before every use — each caller runs `getLabelOwner` first,
 * so an entry whose label the account no longer owns can never grant anything.
 * The entry itself is IGNORED, never deleted ("confirm, never condemn": a failed
 * or lagging RPC read must not be able to erase a user's record). This file is
 * admission policy, the category `SWARM_SOCIAL_PLAN.md:115` already carves out,
 * not data plane: nothing here is user content, nothing here is truth about a name.
 *
 * LOSING OWNERSHIP DROPS THE ROLE, NEVER THE CLOCK. `release` is the holder's
 * own transaction and is deliberately ungated, so if letting a name go also
 * cleared the rename record, `release old → mint new → bind` would read as a
 * FIRST bind and walk straight past the cooldown — the cooldown would then only
 * bind users who kept their old name, i.e. exactly the ones not churning. So no
 * code path here deletes a record, and `firstBoundAt` / `lastChangedAt` /
 * `freeCorrectionUsed` outlive any name they refer to.
 *
 * MUST survive restarts, but losing it is recoverable and fails OPEN, by design:
 * every cooldown resets and the profile-name refusal at the binding points stops
 * firing until each user re-binds. Nothing a user cannot redo is lost. That is
 * the right failure direction for admission policy — the alternative, failing
 * closed, would lock every organiser out of stamping any name after a disk loss.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../marketing/persist.js";

const DATA_DIR = join(process.cwd(), ".data");
const STORE_FILE = join(DATA_DIR, "profile-names.json");

/** Owner decision, 2026-09-03 (plan doc "OWNER ANSWERS 5b" item 2). */
export const NAME_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
/** One free correction, for a typo caught soon after the first bind. */
export const FREE_CORRECTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface NameRecord {
  /**
   * The last label this account bound as its profile name. Kept even while
   * unbound, so re-binding the SAME name is still recognised as "not a change"
   * — an unbind is not a change and must not consume the cooldown, and neither
   * should undoing one.
   */
  label: string;
  /** False after an explicit unbind. `profileNameOf` reports null while false. */
  active: boolean;
  /** Epoch ms of the FIRST bind ever — the free-correction window runs from here. */
  firstBoundAt: number;
  /** Epoch ms of the last CHANGE (first bind counts; an unbind does not). */
  lastChangedAt: number;
  freeCorrectionUsed: boolean;
}

type Store = Record<string, NameRecord>;

/** lowercase parent address → record. */
const byAccount = new Map<string, NameRecord>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(readFileSync(STORE_FILE, "utf-8")) as Store;
    for (const [account, rec] of Object.entries(raw)) {
      if (!rec || typeof rec.label !== "string" || !rec.label) continue;
      byAccount.set(account.toLowerCase(), {
        label: rec.label.toLowerCase(),
        active: rec.active !== false,
        firstBoundAt: Number(rec.firstBoundAt) || 0,
        lastChangedAt: Number(rec.lastChangedAt) || 0,
        freeCorrectionUsed: rec.freeCorrectionUsed === true,
      });
    }
    console.log(`[profile-names] loaded ${byAccount.size} profile-name records`);
  } catch {
    // Absent on first boot. Not distinguished from unparseable: `writeJsonAtomic`
    // makes a torn write impossible, so an unreadable file means something
    // outside this process, and the loud path for that is the persistence
    // counter on /api/health — not refusing to boot over admission policy.
  }
}

function persist(): void {
  const out: Store = {};
  for (const [account, rec] of byAccount) out[account] = rec;
  writeJsonAtomic(STORE_FILE, out, "profile-names");
}

const norm = (s: string): string => s.toLowerCase().trim();

/**
 * The label `account` has bound as its profile name, or null.
 *
 * CALLERS MUST STILL CONFIRM OWNERSHIP ON-CHAIN before treating the answer as
 * meaningful — this returns a claim the server once verified, not a live fact.
 * The binding points use it only to REFUSE (a 409), so a stale entry costs a
 * user one confusing refusal, never someone else's name.
 */
export function profileNameOf(account: string): string | null {
  ensureLoaded();
  const rec = byAccount.get(norm(account));
  return rec && rec.active ? rec.label : null;
}

/**
 * Whether `label` is `account`'s PROFILE name — i.e. its identity rather than a
 * URL — and therefore must not be pointed at an event or a site.
 *
 * The distinction is unknowable from chain (`ownerOf` says who holds a name,
 * never what it is FOR) and the profile feed is client-signed, so this ledger
 * is the only place it lives. Used only to REFUSE, so a stale entry costs one
 * confusing refusal and can never hand over someone else's name.
 */
export function isProfileName(account: string, label: string): boolean {
  return profileNameOf(account) === norm(label);
}

export interface NameChangeStatus {
  /** The currently bound profile name, or null. */
  label: string | null;
  /** Whether a bind of a DIFFERENT label would be accepted right now. */
  allowed: boolean;
  /** Epoch ms when a different label becomes bindable, or null if it already is. */
  nextChangeAllowedAt: number | null;
  /** Whether the one free early correction has been spent. */
  freeCorrectionUsed: boolean;
}

/**
 * Whether `account` may bind a name, and when.
 *
 * The rule (plan doc §2), exactly: a bind of a label OTHER than the current one
 * is allowed iff the free-correction window is still open and unspent, OR the
 * cooldown since the last change has elapsed. A first bind, an unbind, and a
 * rebind of the same label are all ungated.
 */
export function nameChangeStatus(account: string, now: number = Date.now()): NameChangeStatus {
  ensureLoaded();
  const rec = byAccount.get(norm(account));
  if (!rec) {
    return { label: null, allowed: true, nextChangeAllowedAt: null, freeCorrectionUsed: false };
  }
  const freeWindowOpen = !rec.freeCorrectionUsed && now - rec.firstBoundAt <= FREE_CORRECTION_WINDOW_MS;
  const cooldownDone = now - rec.lastChangedAt >= NAME_CHANGE_COOLDOWN_MS;
  const allowed = freeWindowOpen || cooldownDone;
  return {
    label: rec.active ? rec.label : null,
    allowed,
    nextChangeAllowedAt: allowed ? null : rec.lastChangedAt + NAME_CHANGE_COOLDOWN_MS,
    freeCorrectionUsed: rec.freeCorrectionUsed,
  };
}

export type BindResult =
  | { ok: true; status: NameChangeStatus }
  | { ok: false; reason: "cooldown"; status: NameChangeStatus };

/**
 * Record that `account` bound `label` as its profile name.
 *
 * ONLY call this after verifying on-chain that `account` owns `label` — this
 * function does no ownership check and cannot: it is a ledger, not an
 * authority. Returns `ok:false` with the status when the cooldown refuses the
 * change; the caller turns that into a 409 and writes NOTHING.
 */
export function bindProfileName(account: string, label: string, now: number = Date.now()): BindResult {
  ensureLoaded();
  const acct = norm(account);
  const lbl = norm(label);
  const rec = byAccount.get(acct);

  // First bind ever — ungated, and it starts both clocks.
  if (!rec) {
    byAccount.set(acct, {
      label: lbl,
      active: true,
      firstBoundAt: now,
      lastChangedAt: now,
      freeCorrectionUsed: false,
    });
    persist();
    return { ok: true, status: nameChangeStatus(acct, now) };
  }

  // Same label. Idempotent: re-binding what is already bound writes no clock,
  // and re-binding after an unbind is an undo, not a change.
  if (rec.label === lbl) {
    if (!rec.active) {
      rec.active = true;
      persist();
    }
    return { ok: true, status: nameChangeStatus(acct, now) };
  }

  const status = nameChangeStatus(acct, now);
  if (!status.allowed) return { ok: false, reason: "cooldown", status };

  // A genuine change. Spend the free correction only when that is what allowed it.
  const freeWindowOpen = !rec.freeCorrectionUsed && now - rec.firstBoundAt <= FREE_CORRECTION_WINDOW_MS;
  const cooldownDone = now - rec.lastChangedAt >= NAME_CHANGE_COOLDOWN_MS;
  rec.label = lbl;
  rec.active = true;
  rec.lastChangedAt = now;
  if (!cooldownDone && freeWindowOpen) rec.freeCorrectionUsed = true;
  persist();
  return { ok: true, status: nameChangeStatus(acct, now) };
}

/**
 * Unbind `account`'s profile name.
 *
 * The clock is deliberately NOT touched: an unbind is not a change, so it
 * neither starts nor resets the cooldown. The NEXT bind of a different label is
 * the change, and it is gated from the last real change — otherwise
 * unbind-then-bind would be a free rename for anyone who noticed.
 */
export function unbindProfileName(account: string): void {
  ensureLoaded();
  const rec = byAccount.get(norm(account));
  if (!rec || !rec.active) return;
  rec.active = false;
  persist();
}

/** Test seam only. */
export function _resetProfileNamesForTests(): void {
  byAccount.clear();
  loaded = false;
}
