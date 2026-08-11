/**
 * Background portability-envelope re-probe (#245 fix 4) — the self-heal for a
 * device pinned to a phantom counterfactual account.
 *
 * WHAT IT REPAIRS. The kernel-address cache (`woco:kaddr:`) is seeded off a
 * NEGATIVE: "the envelope probe definitively found nothing, so this passkey was
 * never recovered". Two things falsify that negative after the fact:
 *
 *  - #245's race — recovery ran on another device and the envelope was written
 *    seconds later, so a login inside that window read a true-at-the-time absence
 *    and cached it forever;
 *  - #138's residue — a bee-level retrieval fault on a chunk that DOES exist still
 *    reaches the caller as `absent`.
 *
 * Either way the device caches the fresh credential's own counterfactual Kernel,
 * the fast path (`loginPasskey`, the kaddr branch) consults that cache BEFORE any
 * envelope re-probe forever after, and the account stays unreachable from this
 * device until storage is cleared or recovery re-runs here. The cache header in
 * auth-store.svelte.ts argues a recovery can never make an entry stale; with the
 * envelope missing, the fresh credential itself seeds the entry, which is what
 * falsified that premise.
 *
 * THREAT MODEL. Not an attacker path — a race and a transient network lie. The
 * heal is authorized by the CHAIN, never by the blob: an envelope is applied only
 * when the ECDSA validator says the preserved Kernel's live sudo owner IS this
 * device's PRF-EOA. So this can only ever move a device FROM an account it does
 * not control TO one it provably controls right now. A hostile RPC can suppress
 * the heal; it cannot redirect it (the envelope is sealed to a PRF-derived HPKE
 * key, so a forged or replayed one decrypts to nothing else). A credential
 * orphaned BY a recovery reads a different owner and is deliberately left alone —
 * see the `orphaned` outcome.
 *
 * COST, and why the shape is what it is. A Swarm lookup that MISSES is a full
 * network search on our own gateway — the expensive direction, and the shape that
 * melted the bee once. Missing is also the common answer here. So the cost is
 * squeezed at four points:
 *
 *  - the throttle gates EVERYTHING: a non-due login does zero network, not even
 *    the eth_call;
 *  - a cheap on-chain owner read gates the Swarm lookup entirely, and a positive
 *    one is TERMINAL — an account that has ever transacted never probes again;
 *  - the Swarm question is existence only, which is ONE lookup (`envelopeExists`),
 *    not the full read's three; the full read runs only after a hit, where its
 *    lookups all succeed;
 *  - the ladder is finite: five attempts per credential per device, ever.
 *
 * Worst case for a device that never transacts: five lookups, spread over at
 * least eight days. Baseline for comparison — every device's FIRST passkey login
 * already pays three on the slow path, unavoidably.
 */

import type { PortabilityRead, portabilityEnvelopeExists } from "./recovery-portability.js";

/** The existence probe's three states, taken from its implementation so the two cannot drift. */
export type EnvelopePresence = Awaited<ReturnType<typeof portabilityEnvelopeExists>>;

/** Only passkey accounts have a PRF-derived envelope; web3auth owners have none by design. */
export type ReprobeKind = "passkey";

export interface EnvelopeReprobeDeps {
  /** 3-state on-chain owner read — `"error"` MUST stay distinct from `null`. */
  readKernelOwner: (kernelAddress: string) => Promise<string | null | "error">;
  /**
   * ONE chunk lookup answering existence only. This is the question fix 4 asks in
   * the common case, and the common answer is no — so it must cost one miss, not
   * the full read's three. See `portabilityEnvelopeExists`.
   */
  envelopeExists: (passkeyPrivKey: string) => Promise<EnvelopePresence>;
  /** Read + open the PRF-sealed envelope. Reached ONLY after a hit, so its lookups succeed. */
  readEnvelope: (passkeyPrivKey: string) => Promise<PortabilityRead>;
  /** Durable device-local fact: this PRF-EOA opens the preserved Kernel. THE heal. */
  putRecoveryBinding: (podAddress: string, kernel: string) => Promise<void>;
  /** Drop the poisoned `woco:kaddr:` entry (auth-store owns that key's format). */
  clearCachedKernelAddress: (kind: ReprobeKind, eoa: string) => void;
  /** True only while the store still holds the identity this probe was launched for. */
  isStillSignedInAs: (eoa: string, parent: string) => boolean;
  logout: () => Promise<void>;
  /** One-shot explanation for the forced sign-out, surfaced by the login modal. */
  postNotice?: (message: string) => void;
  now?: () => number;
  storage?: ReprobeStorage;
  online?: () => boolean;
}

/** The two localStorage operations this module needs, so tests need no DOM. */
export interface ReprobeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type ReprobeOutcome =
  /** Nothing ran. Cheap and by far the common case. */
  | { status: "skipped"; reason: "throttled" | "exhausted" | "confirmed" | "in-flight" | "offline" }
  /** The chain says this parent is a deployed Kernel owned by this credential. Terminal. */
  | { status: "confirmed" }
  /**
   * The chain says this parent is deployed and owned by SOMEONE ELSE — proof the
   * credential was orphaned by a recovery (#255). Reported, never acted on: see
   * the note at the call site for why acting here makes it worse.
   */
  | { status: "orphaned"; owner: string }
  /** Nobody could answer. No durable state written, no attempt consumed. */
  | { status: "inconclusive"; reason: string }
  /** A probe ran and produced no envelope to apply. An attempt IS consumed. */
  | { status: "clear"; reason: string }
  /** Envelope found, on-chain owner verified, binding written, device signed out. */
  | { status: "healed"; preserved: string; signedOut: boolean };

const REPROBE_PREFIX = "woco:kreprobe:";
/** One-shot sign-out explanation; sessionStorage, read + cleared by the login modal. */
export const AUTH_NOTICE_KEY = "woco:auth-notice";

/**
 * Cooldown before attempt n+1, indexed by attempts already made. Five attempts,
 * then stop — the ladder is keyed on ATTEMPTS, not the calendar, so a device
 * opened twice a year still gets all five; only a probe that reached a verdict
 * advances it.
 *
 * Five is a cost cap, not a claim that a device which exhausts them is healthy:
 * fix 2 now AWAITS the envelope write inside the ceremony, so the window this
 * repairs is minutes wide and `0 / 1h / 6h / 24h / 7d` covers it many times over.
 * An envelope that first becomes readable later than that is not a failure mode
 * anyone has seen; the documented remediation (clear site data, or re-run
 * recovery here) stands behind it.
 */
const LADDER_MS = [0, 3_600_000, 21_600_000, 86_400_000, 604_800_000];
const MAX_ATTEMPTS = LADDER_MS.length;

interface ReprobeState {
  /** Attempts that reached a verdict. */
  n: number;
  /** Epoch ms of the last attempt. */
  at: number;
  /**
   * The parent address a positive chain read confirmed. Bound to the address it
   * confirms rather than stored as a bare boolean, so a confirmation can never be
   * read as applying to some other cached parent.
   */
  ok?: string;
}

function stateKey(kind: ReprobeKind, eoa: string): string {
  return `${REPROBE_PREFIX}${kind}:${eoa.toLowerCase()}`;
}

function readState(store: ReprobeStorage, kind: ReprobeKind, eoa: string): ReprobeState {
  try {
    const raw = store.getItem(stateKey(kind, eoa));
    if (!raw) return { n: 0, at: 0 };
    const parsed = JSON.parse(raw) as Partial<ReprobeState>;
    return {
      n: Number.isInteger(parsed.n) && parsed.n! >= 0 ? parsed.n! : 0,
      at: Number.isFinite(parsed.at) && parsed.at! >= 0 ? parsed.at! : 0,
      ok: typeof parsed.ok === "string" ? parsed.ok.toLowerCase() : undefined,
    };
  } catch {
    // A corrupt record costs at most a redundant probe — never correctness.
    return { n: 0, at: 0 };
  }
}

function writeState(store: ReprobeStorage, kind: ReprobeKind, eoa: string, s: ReprobeState): void {
  try {
    store.setItem(stateKey(kind, eoa), JSON.stringify(s));
  } catch {
    /* throttle record is best-effort — see the trust note below */
  }
}

function clearState(store: ReprobeStorage, kind: ReprobeKind, eoa: string): void {
  try {
    store.removeItem(stateKey(kind, eoa));
  } catch {
    /* best-effort */
  }
}

/** One probe per page-session per credential, whatever the throttle says. */
const _inFlight = new Set<string>();

/** Test seam — the module-level in-flight set is process-wide by design. */
export function _resetInFlightForTests(): void {
  _inFlight.clear();
}

/**
 * WHAT THIS PATH MAY WRITE — the rule that keeps the fix from becoming another #138.
 *
 * MAY write:
 *  - the throttle record. It bounds cost and nothing else; a wrong or lost value
 *    can only delay a heal or spend one extra probe, never decide an address.
 *  - `ok`, and ONLY on a positive, definitive chain read (a non-null owner equal
 *    to this PRF-EOA). It stops future probing but does not decide the parent —
 *    that still comes from the kaddr entry, and `_ensureKernel`'s address
 *    assertion plus the server's owner-of-Kernel authorization still stand behind
 *    it. Worst case for a corrupt `ok` is a heal that never happens.
 *  - the recovery binding, on a heal, after the chain has proven ownership.
 *
 * MUST NOT write, ever:
 *  - a new or refreshed `woco:kaddr:` entry. This path can only DELETE one. A
 *    clean `absent` from the re-probe changes exactly one thing: the counter.
 *  - anything derived from `unusable` / `unreadable` / a throw. Those are not
 *    absence and are not evidence in either direction.
 */
export async function reprobeEnvelope(
  args: {
    kind: ReprobeKind;
    /** PRF-EOA — the credential under test. */
    eoa: string;
    /** The cached parent the fast path just trusted: the address under suspicion. */
    cachedParent: string;
    /** Captured at login, not read from the store, so a concurrent logout cannot swap it. */
    passkeyPrivKey: string;
  },
  deps: EnvelopeReprobeDeps,
): Promise<ReprobeOutcome> {
  const { kind, eoa, cachedParent, passkeyPrivKey } = args;
  const store = deps.storage ?? (globalThis.localStorage as unknown as ReprobeStorage | undefined);
  const now = deps.now ?? (() => Date.now());
  const online = deps.online ?? (() => globalThis.navigator?.onLine !== false);
  if (!store) return { status: "skipped", reason: "throttled" };

  const state = readState(store, kind, eoa);

  // Terminal: the chain already proved this exact parent is a real Kernel owned
  // by this credential. Bound to the address, so a different cached parent would
  // not inherit the confirmation.
  if (state.ok && state.ok === cachedParent.toLowerCase()) {
    return { status: "skipped", reason: "confirmed" };
  }
  if (state.n >= MAX_ATTEMPTS) return { status: "skipped", reason: "exhausted" };

  const t = now();
  if (state.at > t) {
    // Clock moved backwards. Re-anchor rather than treat every login as due —
    // a wrong clock must not turn into a probe on every sign-in.
    writeState(store, kind, eoa, { ...state, at: t });
    return { status: "skipped", reason: "throttled" };
  }
  if (state.n > 0 && t - state.at < LADDER_MS[state.n]) {
    return { status: "skipped", reason: "throttled" };
  }
  // Offline costs an attempt for no information, so it is checked after the
  // throttle and before anything is consumed.
  if (!online()) return { status: "skipped", reason: "offline" };

  const flightKey = stateKey(kind, eoa);
  if (_inFlight.has(flightKey)) return { status: "skipped", reason: "in-flight" };
  _inFlight.add(flightKey);

  try {
    // The cheap gate. A deployed Kernel owned by this credential is a real
    // account — no Swarm probe, now or ever.
    const owner = await deps.readKernelOwner(cachedParent);
    if (owner === "error") {
      // Nothing was learned, so nothing is spent. This is the whole reason for
      // the strict 3-state read.
      return { status: "inconclusive", reason: "owner read failed" };
    }
    if (owner !== null) {
      const spent = { n: state.n + 1, at: t, ok: state.ok };
      if (owner === eoa.toLowerCase()) {
        writeState(store, kind, eoa, { ...spent, ok: cachedParent.toLowerCase() });
        return { status: "confirmed" };
      }
      // Deployed, and this credential does not own it: proof of orphaning, which
      // is #255's evidence, not this fix's. Acting on it here would clear the
      // device's state and walk the user straight into #255's fallthrough — a
      // fresh phantom account with an encouraging login. Report and stop.
      writeState(store, kind, eoa, spent);
      return { status: "orphaned", owner };
    }

    // Undeployed: consistent with poisoning AND with a legitimate account that has
    // simply never transacted. Only Swarm can tell them apart — so ask it the
    // cheapest question that separates them, and spend the full read only when the
    // answer is yes. This is the one lookup the common case pays.
    const spend = { n: state.n + 1, at: t, ok: state.ok };
    let presence: EnvelopePresence;
    try {
      presence = await deps.envelopeExists(passkeyPrivKey);
    } catch (e) {
      writeState(store, kind, eoa, spend);
      return { status: "inconclusive", reason: `envelope probe threw: ${(e as Error).message}` };
    }
    if (presence.status !== "present") {
      writeState(store, kind, eoa, spend);
      return presence.status === "absent"
        ? { status: "clear", reason: "no envelope" }
        : { status: "inconclusive", reason: presence.reason };
    }

    let read: PortabilityRead;
    try {
      read = await deps.readEnvelope(passkeyPrivKey);
    } catch (e) {
      writeState(store, kind, eoa, spend);
      return { status: "inconclusive", reason: `envelope read threw: ${(e as Error).message}` };
    }
    if (read.status !== "found") {
      // Bytes are there and we could not use them. Never an absence — and never
      // `clear`, which is the outcome that reads as "this device is fine".
      writeState(store, kind, eoa, spend);
      return {
        status: "inconclusive",
        reason: read.status === "absent" ? "envelope vanished between probe and read" : read.reason,
      };
    }

    // The blob claims an address; the chain decides whether to believe it. Same
    // backstop the login-time portability path applies, for the same reason.
    const preserved = read.value.preservedKernelAddress.toLowerCase();
    const preservedOwner = await deps.readKernelOwner(preserved);
    if (preservedOwner !== eoa.toLowerCase()) {
      writeState(store, kind, eoa, spend);
      return {
        status: "inconclusive",
        reason:
          preservedOwner === "error"
            ? "preserved-Kernel owner read failed"
            : `preserved Kernel owner is ${String(preservedOwner)}, not this credential`,
      };
    }

    // HEAL. The binding alone is the repair: `_recoveryKernelFor` is consulted
    // before the kaddr cache, so the next login rebuilds at the preserved address
    // and its slow path restores the POD seed + feed signer through the reviewed
    // portability block. Deliberately NOT written here: the POD seed (logout's
    // `clearPodIdentity` would delete it on the way out) and the verified-binding
    // marker (the recovered fast path needs secrets this device does not yet
    // hold, and fewer durable claims is the safer shape).
    //
    // Order is load-bearing: every prefix of it leaves the device correct or
    // retrying. Binding first — once it exists the poisoned cache is unreachable.
    await deps.putRecoveryBinding(eoa, preserved);
    deps.clearCachedKernelAddress(kind, eoa);
    clearState(store, kind, eoa);

    // The session in memory belongs to the phantom. Only tear it down if the user
    // is still in it — if they signed out or switched during the probe, the
    // binding is already the whole repair and a forced logout would be noise.
    const signedOut = deps.isStillSignedInAs(eoa, cachedParent);
    if (signedOut) {
      deps.postNotice?.(
        "This account was recovered on another device. Sign in again to reconnect to it.",
      );
      await deps.logout();
    }
    return { status: "healed", preserved, signedOut };
  } finally {
    _inFlight.delete(flightKey);
  }
}
