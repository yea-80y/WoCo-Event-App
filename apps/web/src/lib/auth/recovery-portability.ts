/**
 * Cross-device recovery portability envelope (CROSS_DEVICE_RECOVERY.md §3 /
 * CLIENT_FEED_SIGNER_HANDOVER.md step 4).
 *
 * A WoCo-guardian *recovery* rotates a passkey Kernel's on-chain owner while
 * PRESERVING the Kernel address, and restores the original POD seed from escrow.
 * Both facts get written to the recovery DEVICE's IndexedDB only, so the recovered
 * account is single-device (a second device shows a divergent counterfactual
 * address + a divergent POD identity). This module carries those preserved
 * secrets in a tiny record any device with the SAME passkey can fetch and open:
 *
 *  - The record is a Single-Owner-Chunk owned by a key DERIVED from the passkey's
 *    PRF secret (domain-separated). Only the passkey holder can produce that key,
 *    so only the user can write their own envelope. It is read by COMPUTED chunk
 *    address (Etherna-safe — never /feeds).
 *  - The payload is the SAME audited `RecoveryEnvelope` from `recovery-escrow.ts`,
 *    sealed to ONE extra HPKE recipient: a second PRF-derived (X25519) key. No new
 *    crypto — one extra recipient on the bundle the escrow already produces.
 *
 * Trust on read is NOT this blob: the caller MUST verify on-chain that the
 * preserved Kernel's current ECDSA owner == this device's PRF-EOA before applying
 * any override (see auth-store / kernel-account.readKernelEcdsaOwner). The seal
 * only provides confidentiality; the chain provides authenticity.
 *
 * Determinism / recovery-stability: the two keys derive from the passkey's
 * secp256k1 PRF key (`keccak256(prfOutput)`), which is reproduced on any device
 * holding the passkey. After a recovery the envelope is (re)written under the
 * NEW passkey's derived keys, so the recovered identity becomes portable to that
 * passkey's future devices.
 */

import { keccak256, getBytes, toUtf8Bytes, concat, Wallet } from "ethers";
import {
  PORTABILITY_SOC_OWNER_DOMAIN,
  PORTABILITY_HPKE_DOMAIN,
  PORTABILITY_ENVELOPE_VERSION,
  PORTABILITY_SOC_IDENTIFIER_INPUT,
  type PortabilityEnvelope,
} from "@woco/shared";
import {
  deriveEncryptionKeypairFromSeed,
  sealRecoveryBundle,
  openRecoveryBundle,
  type GuardianEncryptionKeypair,
} from "./recovery-escrow.js";
import { writeContentFeed, readContentFeedResult } from "../swarm/content-feed.js";

/** Domain-separated 32-byte seed = keccak256(utf8(domain) || prfPrivKeyBytes). */
function domainSeed(domain: string, prfPrivKeyBytes: Uint8Array): Uint8Array {
  return getBytes(keccak256(concat([toUtf8Bytes(domain), prfPrivKeyBytes])));
}

export interface PortabilityKeys {
  /** secp256k1 SOC-owner key (0x-prefixed) + lowercased address. */
  socOwnerPrivKey: string;
  socOwnerAddress: string;
  /** X25519 HPKE recipient keypair (wrap on write, unwrap on read). */
  hpke: GuardianEncryptionKeypair;
}

/**
 * Derive the two domain-separated keys from a passkey's PRF secp256k1 private key
 * (`_passkeyPrivateKey` in auth-store; == keccak256(PRF output)). Distinct domains
 * ⇒ the SOC-owner key and the HPKE recipient key don't reveal each other.
 */
export async function derivePortabilityKeys(passkeyPrivKey: string): Promise<PortabilityKeys> {
  const prfBytes = getBytes(passkeyPrivKey.startsWith("0x") ? passkeyPrivKey : `0x${passkeyPrivKey}`);

  const socSeed = domainSeed(PORTABILITY_SOC_OWNER_DOMAIN, prfBytes);
  const socOwnerPrivKey = keccak256(socSeed); // 0x + 32 bytes → valid secp256k1 key
  const wallet = new Wallet(socOwnerPrivKey);

  const hpkeSeed = domainSeed(PORTABILITY_HPKE_DOMAIN, prfBytes);
  let hpke: GuardianEncryptionKeypair;
  try {
    hpke = await deriveEncryptionKeypairFromSeed(hpkeSeed);
  } finally {
    hpkeSeed.fill(0);
    socSeed.fill(0);
  }

  return { socOwnerPrivKey, socOwnerAddress: wallet.address.toLowerCase(), hpke };
}

/**
 * Seal the preserved secrets to the passkey's PRF-derived HPKE key and write the
 * envelope as the fixed-identifier SOC (overwrite-in-place). `preservedKernelAddress`
 * is the recovered account's Kernel address; the bundle inside carries the POD
 * seed and the content-feed-signer key. Non-throwing failures are the
 * caller's to handle — this throws on any error.
 */
export async function writePortabilityEnvelope(args: {
  passkeyPrivKey: string;
  preservedKernelAddress: string;
  podSeed: string;
  /** Content-feed signer key, carried so the account's further devices restore it
   *  (same role the guardian escrow plays on the recovery device). Optional only
   *  because external-wallet kinds have no feed signer to carry. */
  feedSignerPrivKey?: string;
}): Promise<void> {
  const { passkeyPrivKey, preservedKernelAddress, podSeed, feedSignerPrivKey } = args;
  const keys = await derivePortabilityKeys(passkeyPrivKey);

  // The preserved Kernel goes INSIDE the sealed bundle (v2 privacy fix) — never
  // cleartext on the chunk, so a reader can't link socOwnerAddress → real Kernel.
  const secrets: Record<string, string> = {
    preservedKernelAddress: preservedKernelAddress.toLowerCase(),
    podSeed,
  };
  if (feedSignerPrivKey) secrets.feedSignerPrivKey = feedSignerPrivKey;

  // Bind the AAD + envelope.kernelAddress to the PRF-derived socOwnerAddress
  // pseudonym (already public — it IS the chunk owner), NOT the real Kernel. The
  // PRF-derived HPKE recipient key still binds the account, so anti-transplant
  // holds while nothing on the chunk reveals the preserved Kernel address.
  const envelope = await sealRecoveryBundle({
    bundle: { version: PORTABILITY_ENVELOPE_VERSION, secrets },
    kernelAddress: keys.socOwnerAddress,
    guardianPublicKeysHex: [keys.hpke.publicKeyHex],
  });

  const payloadObj: PortabilityEnvelope = {
    v: PORTABILITY_ENVELOPE_VERSION,
    envelope,
  };

  // Versioned content-feed rail: after a recovery the envelope is REWRITTEN under
  // the new passkey's derived keys — a fixed-identifier SOC would silently discard
  // that rewrite (immutable chunk). The topic string IS the fixed identifier input,
  // so `contentFeedSocIdentifier(PORTABILITY_SOC_IDENTIFIER_INPUT)` matches the
  // legacy identifier and old envelopes stay discoverable via the fallback.
  await writeContentFeed({
    signerPrivKey: keys.socOwnerPrivKey,
    topic: PORTABILITY_SOC_IDENTIFIER_INPUT,
    data: payloadObj,
  });
}

export interface OpenedPortability {
  preservedKernelAddress: string;
  podSeed: string;
  feedSignerPrivKey?: string;
}

/**
 * The outcome of a portability-envelope read.
 *
 * `absent` is separate because the caller acts on it in a way it can never take
 * back: "this passkey was never recovered" is what seeds the returning-device
 * address cache, and a wrong negative there pins the account to the wrong Kernel
 * for the life of the device (#138). Neither other negative is ever cacheable.
 *
 * `unreadable` and `unusable` are separate because the BACK-FILL acts on them
 * oppositely: an envelope that is present but stale/corrupt should be rewritten
 * (that is the documented self-heal), while one we simply could not fetch must be
 * left alone — rewriting on every transient fault is unbounded growth on the
 * shared postage batch (#153).
 */
export type PortabilityRead =
  | { status: "found"; value: OpenedPortability }
  /** The read stack definitively established there is no envelope chunk. */
  | { status: "absent" }
  /** Nobody could answer whether an envelope exists. */
  | { status: "unreadable"; reason: string }
  /** An envelope IS there, but this client cannot use it (version, integrity). */
  | { status: "unusable"; reason: string };

/**
 * Read + open the portability envelope for the passkey holding `passkeyPrivKey`.
 * Does NOT perform the on-chain owner check — the caller MUST verify
 * `Kernel(preservedKernelAddress).owner == PRF-EOA` before trusting the result.
 *
 * `absent` means one thing only: the read stack definitively established that no
 * envelope chunk exists, i.e. this really is a never-recovered account.
 */
export async function readPortabilityEnvelope(args: {
  passkeyPrivKey: string;
}): Promise<PortabilityRead> {
  const keys = await derivePortabilityKeys(args.passkeyPrivKey);

  const read = await readContentFeedResult<PortabilityEnvelope>(
    keys.socOwnerAddress,
    PORTABILITY_SOC_IDENTIFIER_INPUT,
  );
  if (read.status === "absent") return { status: "absent" };
  if (read.status === "unavailable") {
    return { status: "unreadable", reason: read.reason ?? "envelope chunk unreadable" };
  }
  const parsed = read.value;

  // A version we don't understand is an envelope that IS there. The back-fill
  // rewrites it — but only on a device that already holds a recovery binding, so
  // a new device must not read this as "never recovered".
  if (parsed.v !== PORTABILITY_ENVELOPE_VERSION || !parsed.envelope) {
    return { status: "unusable", reason: `envelope version ${String(parsed.v)} != ${PORTABILITY_ENVELOPE_VERSION}` };
  }

  try {
    // Sealed under the socOwnerAddress pseudonym (v2), not the real Kernel.
    const bundle = await openRecoveryBundle({
      envelope: parsed.envelope,
      kernelAddress: keys.socOwnerAddress,
      guardianKeypair: keys.hpke,
    });
    const preservedKernelAddress = bundle.secrets.preservedKernelAddress;
    const podSeed = bundle.secrets.podSeed;
    if (!preservedKernelAddress || !podSeed) {
      return { status: "unusable", reason: "opened bundle is missing required secrets" };
    }
    return {
      status: "found",
      value: {
        preservedKernelAddress: preservedKernelAddress.toLowerCase(),
        podSeed,
        feedSignerPrivKey: bundle.secrets.feedSignerPrivKey,
      },
    };
  } catch (e) {
    // Decrypt failure on bytes that exist — corruption, or someone else's chunk at
    // this address. An integrity fault, never an absence.
    return { status: "unusable", reason: `envelope decrypt failed: ${(e as Error).message}` };
  }
}

/**
 * Does an envelope exist for this passkey — ONE chunk lookup, not the full read.
 *
 * `readPortabilityEnvelope` costs three lookups when the answer is no: versions 0
 * and 1 (the resolver's probe window), then the pre-versioning identifier. Every
 * one of those is a search for a chunk that is not there, and a miss is a full
 * network search on our own gateway — the expensive direction in Swarm, and the
 * shape that melted the bee once.
 *
 * The background re-probe (#245 fix 4) only ever asks EXISTENCE, and existence
 * needs exactly one question: `writeContentFeed` computes `(latest ?? -1) + 1`, so
 * a feed's first write is always version 0 and any envelope at all implies a v0
 * base chunk — including a paged one, whose manifest IS that base chunk. Ask v0;
 * escalate to the full read only on a hit, where the lookups then all succeed.
 *
 * Two deliberate narrowings, neither a regression:
 *  - a hint-less full read ALREADY reports absent when v0 is missing but a later
 *    version exists (`resolveLatestSocVersion` starts at 0 and stops on the first
 *    gap), so this inherits that behaviour rather than introducing it;
 *  - the legacy pre-versioning identifier is not consulted. An envelope written
 *    before versioning landed would be missed here — the cost is that such a
 *    device does not self-heal, which is the status quo it is being lifted out of,
 *    never a wrong address.
 *
 * Three states, for the usual reason: a failed lookup is not an absence.
 */
export async function portabilityEnvelopeExists(args: {
  passkeyPrivKey: string;
}): Promise<{ status: "present" } | { status: "absent" } | { status: "unreadable"; reason: string }> {
  const [keys, { probeSoc }, { contentFeedSocIdentifier, versionedSocIdentifier }] =
    await Promise.all([
      derivePortabilityKeys(args.passkeyPrivKey),
      import("../swarm/client-soc.js"),
      import("@woco/shared"),
    ]);

  const base = contentFeedSocIdentifier(PORTABILITY_SOC_IDENTIFIER_INPUT);
  try {
    const probe = await probeSoc(keys.socOwnerAddress, versionedSocIdentifier(base, 0));
    if (probe.status === "found") return { status: "present" };
    if (probe.status === "absent") return { status: "absent" };
    return { status: "unreadable", reason: probe.reason ?? "envelope probe unavailable" };
  } catch (e) {
    // probeSoc throws on a client-side network exception (deliberately loud).
    // Here that is "nobody could answer", never "nothing is there".
    return { status: "unreadable", reason: `envelope probe threw: ${(e as Error).message}` };
  }
}

/** Normalise a secp256k1 private key for comparison (0x-prefixed, lowercase). */
function normKey(k: string | undefined): string | undefined {
  if (!k) return undefined;
  return (k.startsWith("0x") ? k : `0x${k}`).toLowerCase();
}

export interface PortabilityBackfill {
  action: "wrote" | "skipped" | "deferred";
  reason: string;
}

/**
 * Bring the portability envelope in line with the secrets this device holds,
 * writing only when it actually differs.
 *
 * The old skip test read the LEGACY pre-versioning identifier (`keccak(topic)`)
 * while the writer targets the VERSIONED rail (`keccak(keccak(topic) ‖ v)`) — a
 * 32-byte preimage against a 40-byte one, so it could never match anything written
 * since versioning landed. "Once written it self-skips" was false: every session
 * mint re-sealed and re-uploaded a fresh version, growing the sequence without
 * bound, adding ~ceil(n/2) sequential probes to the new-device read this feature
 * exists for, and re-disclosing the Kernel ↔ socOwnerAddress link each time (#153).
 *
 * Compares against the OPENED envelope through the same resolver the writer uses.
 * A skip is only ever taken on a definitive read.
 *
 * SINGLE-FLIGHT (same idiom as auth-store's _sessionInFlight). Right after a
 * recovery, two legitimate callers race by design: the session mint's
 * fire-and-forget backfill (frozen, and load-bearing for later devices) and the
 * portal's awaited finalizeRecovery (#245). Same process, same secrets — letting
 * both run costs a redundant envelope version, or a spurious retryable warning
 * when the loser's version probe turns inconclusive. Concurrent callers for the
 * same passkey share one run and its outcome; cleared on settle, so a genuine
 * later call (new secrets, retry) always runs fresh.
 *
 * DEADLINE. Every network primitive underneath — the bee-js gateway chunk read,
 * the server fallback, the authenticated SOC stamp — runs without an
 * AbortController, and browsers impose no default fetch timeout, so a stalled
 * (not dropped) connection leaves this promise pending forever. That was
 * invisible while the only caller was fire-and-forget; now it gates the screen
 * shown straight after an IRREVERSIBLE on-chain rotation, where a user who
 * concludes it failed may re-run the whole ceremony. It also wedges the map: a
 * run that never settles never clears its entry, pinning the raw passkey key and
 * making every later call join the dead run. Bounding it converts both into the
 * ordinary retryable failure the portal already handles. The underlying fetch is
 * not cancelled (nothing downstream takes a signal) — it is abandoned, and a
 * late write is harmless: the next read simply skips as already-current.
 */
const BACKFILL_DEADLINE_MS = 120_000;

const _backfillInFlight = new Map<string, Promise<PortabilityBackfill>>();

/**
 * The one payload shape an envelope write takes. Exported because it used to be
 * declared inline at every seam (#260) — and a field added to one copy while
 * the others pinned the old shape is exactly how an envelope ends up written
 * without the new secret.
 */
export interface PortabilityBackfillArgs {
  passkeyPrivKey: string;
  preservedKernelAddress: string;
  podSeed: string;
  feedSignerPrivKey?: string;
}

export function backfillPortabilityEnvelope(
  args: PortabilityBackfillArgs & {
    /** Test seam — override the deadline (ms). Production always takes the default. */
    deadlineMs?: number;
  },
): Promise<PortabilityBackfill> {
  // An unusable key would collapse every such caller onto one shared "" slot.
  // Both production callers guard it; fail loudly rather than coalesce blind.
  const key = normKey(args.passkeyPrivKey);
  if (!key) return Promise.reject(new Error("backfillPortabilityEnvelope: passkeyPrivKey is required"));
  const existing = _backfillInFlight.get(key);
  if (existing) return existing;

  const run = _withDeadline(_backfillOnce(args), args.deadlineMs ?? BACKFILL_DEADLINE_MS).finally(
    () => _backfillInFlight.delete(key),
  );
  _backfillInFlight.set(key, run);
  return run;
}

function _withDeadline(
  work: Promise<PortabilityBackfill>,
  ms: number,
): Promise<PortabilityBackfill> {
  return new Promise<PortabilityBackfill>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`portability envelope timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function _backfillOnce(args: PortabilityBackfillArgs): Promise<PortabilityBackfill> {
  const read = await readPortabilityEnvelope({ passkeyPrivKey: args.passkeyPrivKey });

  // Could not tell what is out there. Writing blind is what runs the version
  // counter away; the next session mint retries.
  if (read.status === "unreadable") return { action: "deferred", reason: read.reason };

  if (read.status === "found") {
    const cur = read.value;
    const current =
      cur.preservedKernelAddress === args.preservedKernelAddress.toLowerCase() &&
      cur.podSeed === args.podSeed;
    if (current) {
      const curSigner = normKey(cur.feedSignerPrivKey);
      const newSigner = normKey(args.feedSignerPrivKey);
      if (curSigner === newSigner) return { action: "skipped", reason: "envelope already current" };
      // Never rewrite an envelope that carries a feed signer with one that does
      // not — a session without the signer to hand would strip the escrowed key
      // and orphan this account's content feeds on its future devices.
      if (!newSigner) {
        return { action: "skipped", reason: "no feed signer this session — refusing to strip the escrowed one" };
      }
    }
  }

  await writePortabilityEnvelope(args);
  return {
    action: "wrote",
    reason: read.status === "found" ? "contents differed" : read.status,
  };
}
