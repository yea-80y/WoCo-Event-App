# Client feed-signer architecture — external review (Fable, 2026-07-02)

Fresh-eyes crypto/CTO review of the client-owned content-feed signer work
(branch `feat/feed-signer-recovery`, WIP unification included). **Verdict: the
settled design is sound — keep it.** Findings + the lock-down plan below so the
review isn't lost. Read with `CLIENT_FEEDS_AUTH_KINDS_HANDOVER.md` and
`WEB3AUTH_FEED_SIGNER_HANDOVER.md`.

## Verdict on the construction (do not reopen)

- **Sign-to-derive is the established industry pattern**, not an invention:
  keccak256 of a deterministic (RFC-6979) EIP-712 signature over a fixed,
  domain-separated message. Prior art: Umbra stealth keys, dYdX/StarkEx L2 keys,
  Loopring, Aztec account keys, XMTP identity. A cryptographer will recognise it.
- **keccak256-as-KDF is sound** for this input (65-byte ECDSA sig, full key
  entropy; keccak has no length-extension issue). Decision: DOCUMENT the
  rationale rather than migrate to HKDF — migration churns every derived key for
  zero real gain. (Guardian two-key split already uses HKDF-Expand — correct,
  that's where KDF hygiene matters.)
- **The one real weakness — accepted + documented here:** the signature IS the
  key. Any site that gets the wallet to sign the exact `DeriveFeedSigner`
  payload derives the user's feed key (EIP-712 domains are not origin-bound, and
  host CANNOT be bound into the message — cross-host determinism is the point).
  Same exposure POD identity has carried since day one. Blast radius = content
  feeds only, never funds. Mitigation = rotation story (carrier re-stamp +
  `FEED_SIGNER_DERIVE_NONCE` v-bump), already triaged post-launch.
- **The passkey-escrow vs re-derive asymmetry is forced, not aesthetic:** the
  discriminator is "can the credential reproduce the signature later?" Web3
  wallet / Web3Auth key: yes → re-derivation IS the backup. Recovered passkey:
  new credential, new PRF → no → stored secret + guardian escrow, stored key
  always wins. The WIP unification (single sign-to-derive construction for all
  kinds, then persisted; escrow as an extra durability channel where needed) is
  the correct end shape — finish it, don't revert.
- The portability envelope (CROSS_DEVICE_RECOVERY §3) is a superior realisation of the original
  "store the feed key on Swarm encrypted to the ed25519 account" idea: HPKE to a
  PRF-derived key + **on-chain Kernel-owner check as authenticity** (the blob is
  confidentiality only). Sealing to the POD key would have been circular (the POD
  seed itself is what needs recovery, and both derive from the same root).

## Alternatives assessed — all rejected (with reasons, so they stay rejected)

- **Swarm KV store (ETHPrague project):** our content-feed layer already IS a
  Swarm KV (topic → SOC identifier → signed chunk + paging). Any Swarm KV rides
  the same SOC primitive and still needs a write key — relocates the custody
  problem, doesn't solve it.
- **ZeroDev modules / session keys:** govern ON-CHAIN execution (EntryPoint
  validation). Swarm SOC ownership is bare off-chain ecrecover — no 1271, no
  modules, no rotation. ZeroDev cannot hold or police a feed key. (This is also
  exactly why CSW client-feeds are parked.)
- **EIP-7702:** changes what an EOA does on-chain; feed signing is off-chain
  ECDSA over chunk digests. Irrelevant to feeds. Keep 7702 where LAUNCH_PLAN has
  it (web3 attester parity for likes).
- **FHE:** solves compute-on-encrypted-data, not key custody/availability. No
  honest mapping. Nearest relevant tech = threshold-MPC custody (Lit PKPs) — and
  email users' root key is ALREADY threshold-MPC via Web3Auth; adding a second
  MPC network adds liveness+trust deps for nothing. Guardian escrow is simpler
  and self-sovereign.

## Findings

- **F1 — FIXED (this review): cross-identity leak via persisted address cache.**
  `CONTENT_FEED_SIGNER_ADDRESS` was a bare global KV that survived logout
  (`clearAllAuth` never deleted it) and the WIP read it first with no parent
  check → user B on user A's browser resolved A's feed signer for self-reads.
  Fix (in tree): the persisted cache is REMOVED; the AAD-bound encrypted key
  blob (feed-signer-store) is the single durable source of truth — AES-GCM AAD
  means it cryptographically cannot decrypt for the wrong parent — with a
  parent-validated in-memory memo for passive reads. `clearAllAuth` deletes the
  legacy KV.
- **F2 — FIXED (this review): silent profile-save failures.** Two causes:
  (a) recovered-account read/write divergence — writes used the escrow-restored
  STORED key, passive reads re-derived from the LIVE (new) PRF key → divergent
  address → reads fell back to the legacy platform profile → "update didn't
  stick". The WIP self-heal (resolve address from the stored key) fixes the read
  side. (b) `ProfilePage.saveProfile` swallowed all errors (console only) and
  ignored `ensureSession()`'s boolean. Fixed: visible `saveError` state +
  cancelled-session guard. Also added: in-flight coalescing on
  `getContentFeedSigner()` (mirrors ensureSession/ensurePodIdentity) — two
  parallel first-writes could fire overlapping derive ceremonies, and
  `signingRequest.request` auto-rejects an overlapping confirm → prompt "never
  appeared". PublishButton + SiteBuilder already surface errors; ProfilePage was
  the only silent path.
- **F3 — UX: prompts are OURS for raw-key kinds.** For passkey/web3auth the POD
  + Feed "EIP-712 prompts" are our own confirm dialogs (ethers signs silently).
  Collapse account setup into ONE ceremony ("Setting up your account keys" —
  one confirm covering both derivations; biometric once for passkey). Establish
  keys EAGERLY at account creation, not lazily mid-publish. Only external web3
  wallets genuinely need N wallet popups (incl. the double-sign determinism
  check — consider skipping the second sign for known-RFC-6979 wallets).
  **Sonnet-able once the ceremony contract is specced.**
- **F4 — Guardian phishing = escrow confidentiality bound.** The envelope is
  public on Swarm; its confidentiality equals ONE deterministic guardian
  signature (`RECOVERY_ENC_DOMAIN`). Phished guardian sig ⇒ POD seed + feed
  signer disclosed. Accepted per PASSKEY_RECOVERY_PLAN §11.4; mitigations =
  guardian-setup warning copy (triaged, Sonnet) + M-of-N post-launch.
- **F5 — Web3Auth key at rest** persists across page loads in Web3Auth's own
  localStorage session (their SDK), OUTSIDE our device-key AES-GCM envelope.
  Within Web3Auth's threat model; documented custody difference, no action.

## Lock-down plan (ordered)

1. ~~F1 + F2 fixes~~ — DONE this session (auth-store + ProfilePage).
2. Finish + commit the WIP unification; run the **cold-device web3auth gate**
   (live https, device A write → cold device B same feeds). Nothing ships
   before it passes. (Opus)
3. **Universal guardian escrow = handover option (B), for web3auth.** Seal
   `feedSignerPrivKey` for web3auth users into the same generic bundle. Closes
   the Web3Auth-repoint orphaning risk (their key reconstruction is a
   `FEED_PRIVATE_KEY`-class external config) and gives the uniform auditor
   story: *every feed signer is a stored secret, deterministically
   bootstrapped, guardian-recoverable*. Also makes future CSW trivial (random
   key + same channel). (Opus)
   **NOT for web3 wallets**: re-sign IS their recovery; if the wallet is lost
   the parent identity is lost too (feed topics embed the parent), so a
   recovered feed key alone is useless. Revisit only post-7702 if web3 parents
   gain owner rotation. **No user choice** — per-kind mechanism stays
   credential-driven; offering options doubles the test surface and pushes a
   crypto decision onto users.
4. One-ceremony eager key setup (F3). (Sonnet, after Opus specs the contract)
5. Guardian-setup warning copy (F4). (Sonnet)

## Follow-up Q&A (owner questions, answered 2026-07-02)

- **Web3 EOA escrow + "EAS ownership transfer":** two DIFFERENT layers. (1) Secret
  escrow (feed signer / POD seed) preserves content-signing; (2) identity
  SUCCESSION preserves the parent. An EAS "old parent → new parent" record must
  be signed by the OLD key — works for proactive migration/rotation, NOT for key
  LOSS (nothing left to sign with). Passkey users have both layers (escrow +
  Kernel owner rotation); web3 EOAs have neither and can't until the planned
  EIP-7702 Kernelization gives them a rotatable owner (7702 gives loss-recovery
  but NOT compromise-recovery — the raw EOA key stays a super-authority).
  ⇒ Revisit web3 escrow AFTER 7702 lands; at that point align web3 with the
  passkey recovery backbone. The EAS idea the owner remembers = the feed-signer
  ROTATION record from the security triage (parent-authorized, consulted lazily)
  — related instinct, different layer.
- **POD seed escrow:** YES for passkey — `podSeed` was the ORIGINAL escrow
  payload (§11: funds rotation can't restore POD). POD is sign-to-derived (same
  construction as the feed signer, `POD_IDENTITY_DOMAIN`); a recovered passkey
  would derive a divergent seed, hence escrow. web3auth currently re-derives POD
  from the Web3Auth key (no escrow) — the Web3Auth-repoint risk applies to POD
  exactly as to the feed signer, so **option B must seal BOTH `podSeed` and
  `feedSignerPrivKey`** for web3auth (bundle is already generic).
- **POD gating:** rules (`PodGate`/`PodGateGroup`, keyed by `manifestRef`) are
  part of the EVENT definition (V2 `dropGate`); holdings are read TRUSTLESSLY
  from WoCoEventV2 slot ownership on-chain (`lib/pod/holdings.ts`), never from
  platform feeds; evaluation is a pure shared function (`shared/pod/gate.ts`).
  The server enforces at claim time as a chokepoint but is NOT a trust point —
  rule, holdings, and evaluation are all publicly recomputable client-side.
- **Passkey cross-app feed portability:** passkeys are RP-ID (domain)-bound —
  a different app/domain = a different credential = different PRF = different
  derived keys. Cross-app portability for passkey users therefore rides the
  GUARDIAN ESCROW (the guardian wallet can unseal the bundle in any app that
  implements the envelope spec), not the passkey. NOTE/verify: woco.eth.limo vs
  gateway.woco-net.com are DIFFERENT RP IDs — a passkey registered on one host
  cannot assert on the other; confirm passkey login is offered on one host only
  (or scope which host is canonical) before launch.

## Auth model (for reference — asked during review)

No server-side accounts/passwords/session store. Parent identity = client-held
key (web3 EOA / Kernel via passkey-PRF or Web3Auth key). Client mints a random
30-day session key; parent signs EIP-712 `AuthorizeSession` (delegation lives in
IndexedDB, AES-GCM under a non-extractable device key). Every request is signed
by the session key over the canonical challenge (method|path|ts|nonce|bodyhash);
delegation rides in headers; the server verifies STATELESSLY (ecrecover or
1271/6492 multi-chain) + timestamp window + ALLOWED_HOSTS. Only server-side auth
state = the revocation lists in `.data/`.
