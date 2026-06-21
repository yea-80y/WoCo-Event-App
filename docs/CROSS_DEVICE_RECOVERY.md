# Cross-Device Recovered Passkeys — Design

**Status:** DESIGN (2026-06-21). The bug is diagnosed and the fix is specified here;
implementation is gated behind the client-side feed signer (see "Dependency" below).
Companion docs: [`PASSKEY_AUTH.md`](./PASSKEY_AUTH.md),
[`PASSKEY_SMART_WALLET.md`](./PASSKEY_SMART_WALLET.md),
[`PASSKEY_RECOVERY_PLAN.md`](./PASSKEY_RECOVERY_PLAN.md),
[`EMAIL_WEB3AUTH_LOGIN.md`](./EMAIL_WEB3AUTH_LOGIN.md).

---

## 1. The problem (observed)

A user recovered a passkey account on their **phone**. On the phone the right
address + history show. On their **laptop**, logging in with the *same* recovered
passkey shows a **different address** (and, on the dashboard, would fail to decrypt
history). A *non-recovered* passkey account is identical on both devices.

## 2. Root cause — two device-local divergences, one cause

Recovery (`recoverAndRekey` in `auth-store.svelte.ts`) **rotates the on-chain
sudo owner** of the Kernel to a *fresh* passkey while **preserving the Kernel
address**, and **restores the original POD seed from the guardian escrow**. Both
of those facts are written to the **recovery device's IndexedDB only**:

| Preserved secret | Where written | Re-derivable from the new passkey alone? |
|---|---|---|
| Kernel address override | `RECOVERED_KERNEL_BINDING` (`auth-store.svelte.ts:963`) | ❌ CREATE2 mixed the *old* owner |
| Original POD seed | `storePodSeed(...)` (`pod-identity.ts` / `auth-store.svelte.ts:955`) | ❌ would derive a *divergent* seed |

So on a second device the recovered passkey:

1. **Wrong address.** `buildKernelFromPrivateKey` with no override re-derives the
   *new* passkey's counterfactual CREATE2 address (`kernel-account.ts:132` docblock)
   — an undeployed phantom, not the preserved account.
2. **Wrong POD identity.** `ensurePodIdentity` (`auth-store.svelte.ts:660-678`)
   finds no stored seed and re-derives one from the rotated PRF key — the very
   "divergent seed" its own comment warns against — so it can't decrypt the user's
   tickets/dashboard.

Same cause: **recovery preserves secrets that are not re-derivable from the new
passkey, and they live only on the device where recovery ran.**

### Why only passkey has this
`web3` and `web3auth` reconstruct the *same* parent EOA on any device (seed phrase
/ Web3Auth MPC), so their deterministic EIP-712 POD seed is reproduced everywhere —
no device-local state, no recovery envelope. `local` is single-device by design.
Only a **recovered** passkey carries non-reproducible preserved state.

## 3. The fix — a PRF-sealed portability envelope + on-chain verification

Carry the preserved state in a tiny record any device with the passkey can fetch
and open, and trust it via the chain rather than via whoever stored it.

Reuse the **existing, security-reviewed** escrow crypto (`recovery-escrow.ts`:
HPKE/RFC-9180 DEK-wrap + XChaCha20-Poly1305 bundle) — do **not** hand-roll a new
AEAD. The portability copy is just the same `RecoveryBundle` with **one extra HPKE
recipient**: a key the user's own passkey can re-derive on any device.

```
  Recovered passkey (biometric) ──► PRF output (32B, high entropy)
        │
        ├── deterministic key #1 (SOC owner)  ── OWNS the portability feed
        │     feed address = f(owner, fixed topic) → discoverable on ANY device,
        │     and only the passkey holder can WRITE it (Single-Owner Chunk)
        │
        └── deterministic key #2 (X25519 HPKE recipient, via the existing
              deriveGuardianEncryptionKeypair pattern, distinct domain/nonce)
                 └─► added as a RECIPIENT when sealing the RecoveryBundle DEK
                     (alongside the guardian recipients)

  RecoveryBundle (sealed):  { podSeed[, feedSignerPrivKey] }   (+ preservedKernelAddress carried alongside)

  On a new device (same recovered passkey):
     PRF ─► derive keys #1/#2 ─► resolve+read the feed (SOC) ─► HPKE-open the
            DEK with key #2 ─► XChaCha20 open the bundle
         ─► VERIFY ON-CHAIN: Kernel(preservedKernelAddress).owner == PRF-EOA ?
              ├─ yes → apply override + storePodSeed + cache binding  ✅
              └─ no  → ignore (stale/tampered); block + route to recovery
```

> Distinct keys #1 (SOC owner) and #2 (HPKE recipient) are independent
> domain-separated derivations from the PRF, so they don't reveal each other.
> Keys derived deterministically per the same fixed-nonce-signature trick already
> used by `pod-identity.ts` and `deriveGuardianEncryptionKeypair`.

### Why this is sound (auditor's checklist)
- **Confidentiality of the POD seed.** The bundle is sealed with the **already-
  reviewed HPKE + XChaCha20 construction**, wrapped to an X25519 recipient derived
  *only* from the PRF output — gated by the authenticator's user-verification and
  never leaving it in usable form. The blob is public on Swarm but useless without
  the passkey (or a guardian). No new/hand-rolled AEAD is introduced.
- **Write authenticity.** The portability feed is a Single-Owner Chunk owned by a
  PRF-derived key. Only the passkey holder can produce that key, so **only the user
  can write their own envelope** — no platform key, no attacker write.
- **Read integrity / anti-spoof.** Even granting a tampered or stale feed, the
  **on-chain owner check is the authority**: the override is applied *only if* the
  deployed Kernel at the claimed address currently has this PRF-EOA as its ECDSA
  sudo owner. A wrong address fails the check and is discarded. (A wrong address
  could never *steal* funds either — signing still requires the user's PRF key —
  but we refuse it to avoid a confusing phantom-account state.)
- **No new gas.** The binding already exists on-chain (recovery paid to rotate the
  owner). The envelope is a free-ish Swarm write; verification is a gasless
  `eth_call`. We do **not** mint any new on-chain record.
- **Escrow stays minimal.** The envelope is the *device-portability* copy, sealed
  to the passkey. The **guardian escrow** (`recovery-escrow.ts`, HPKE + XChaCha20,
  sealed to the backup wallet) remains the *recovery* copy and is unchanged.

## 4. Relationship to the client-side feed signer (the "next" piece)

Today all Swarm feeds are written by the **platform key** (`FEED_PRIVATE_KEY`,
server-side). The roadmap moves content-feed signing **client-side**. The feed
signer key controls the user's *mutable content* (events, profile, sites) — a
compromise lets an attacker overwrite/impersonate that content (NOT spend funds;
funds live in the Kernel under the separate passkey+guardian trust domain).

### Recovery-stability is the hard constraint
Feeds are **owner-addressed**: rotating the feed signer orphans every feed the user
ever wrote. So the feed signer key **must survive passkey recovery**. Crucially,
for a passkey **no deterministic derivation is recovery-stable on its own** —
anything re-derived from the rotated PRF diverges. Recovery-stability comes only
from **escrow + restore** (the same reason the POD seed is escrowed, not
re-derived). So the open decision is *not* "derive from POD vs derive separately";
it is:

**Should the feed signer share the POD seed's trust domain, or be its own escrowed secret? — OPEN, owner to decide.**

| | **A. Independent `feedSignerPrivKey` in the escrow bundle** (prior reviewed design, slot reserved `recovery-escrow.ts:8-9,56`) | **B. Derived from the POD seed** (HKDF, domain-separated) |
|---|---|---|
| Escrowed secrets | 2 (`podSeed` + `feedSignerPrivKey`) | 1 (`podSeed`) |
| Compromise isolation | POD-seed leak ≠ feed-overwrite | shared root: POD leak ⇒ feed-overwrite too |
| Non-recovered multi-device | needs a sync/seal layer for **all** devices | reproducible from the parent — no sync except recovered-passkey |
| New crypto | none | one domain-separated HKDF |

Tradeoff is genuine but the isolation gap in B is small (a POD-seed holder can
already decrypt all data + forge tickets; funds are unaffected either way). A is
the textbook least-privilege choice and matches the prior review; B is simpler.

### Cross-device mechanism (same for A or B) — reuse existing crypto
The `RecoveryBundle` DEK is already HPKE-wrapped to *multiple* recipients
(`recovery-escrow.ts` wraps to multiple guardians). Wrap it to **(i)** a key the
**parent can re-derive on any device** (own-device portability, no ceremony) **and
(ii)** the **guardian(s)** (recovery after device loss). After a recovery, the
recovery device re-wraps the bundle to the *new* passkey's derived key so the
recovered identity is portable to its future devices. The §3 envelope is this
"wrap to the parent's own key" recipient. **No new primitives** — one extra HPKE
recipient on the envelope the escrow already produces.

> Determinism across kinds (for the parent-derived recipient key): the parent
> signs a fixed-nonce EIP-712 message → `keccak256(getBytes(sig))` → seed (same
> trick as `pod-identity.ts` / `deriveGuardianEncryptionKeypair`). Reproducible per
> parent for web3 / web3auth, per PRF-EOA for passkey. For a **recovered** passkey
> the parent-derived recipient must be re-wrapped post-recovery (above), because
> the PRF rotated.

### Dependency / sequencing (Option 1, agreed 2026-06-21)
The envelope must be written as a **client-owned SOC** (signed by the bootstrap
key, stamped+uploaded via the server's postage batch). That write path *is* the
client-feed-signer infrastructure. So:

1. **Now:** payout gate relaxed for all fund-capable kinds (shipped); this design
   documented.
2. **Next:** build the client feed signer (client-owned SOC write via server stamp).
3. **Then:** write the portability envelope at recovery time (back-fill on first
   login of an already-recovered account) + read/verify/apply on new-device login,
   with the on-chain owner check as the trust backstop and a block-and-route
   fallback when it can't be satisfied.

### Interim status (until step 3 ships)
A **recovered** passkey account is effectively **single-device** — use the device
you recovered on, or re-run the recovery ceremony (backup wallet) on the new
device. Non-recovered passkey, web3, and web3auth accounts are unaffected and work
cross-device today.
