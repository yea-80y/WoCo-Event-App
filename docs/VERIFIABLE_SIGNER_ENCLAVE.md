# Verifiable Signer Enclave — design doc

Status: DESIGN (not started). Author thread: 2026-06-16. Owner: yea-80y.

One-liner: a content-addressed, origin-isolated signing surface that any platform can
embed, whose code a user (or relying party) can cryptographically verify is the audited
build before they ever sign. Universal-ready, WoCo-first. EOA **and** passkey are
first-class signers. Built on existing standards (SIWE/CAIP-122 + WebAuthn + UCAN);
the novel piece is *verifiable delivery of the signing code*, not a new auth protocol.

This dovetails with the World Computer Registry work (`ContentHashRegistry.sol`) and the
planned `woco/registry/verified-frontends` feed.

---

## 1. Problem

Today auth = EIP-712 `AuthorizeSession` signed in the main app DOM. The SIWE-class
criticism is real: users habituate to approving opaque signing prompts and become more
likely to approve a malicious one. Three failure surfaces:

- A compromised server/gateway swaps the code that *requests* the signature (phishing the
  signature itself) — the user has no way to know the prompt came from genuine code.
- Any script sharing the page DOM can hook `window.ethereum` / overlay UI / rewrite the
  message before signing.
- "Universal auth" naively built = WoCo becomes a hosted IdP that sees every login
  everywhere. That reintroduces the exact trusted intermediary content-addressing exists to
  remove. **Off the table.**

## 2. Goals / non-goals

Goals:
- One signing event the user can *verify is genuine code*, reused via a local capability.
- Profile **reads** require no signature at all (public, ENS/Swarm-keyed).
- Signer-agnostic: EOA (MetaMask/WalletConnect) and passkey (Kernel) both first-class.
- Embeddable by third parties with per-RP pinned trust — no phone-home, no WoCo chokepoint.
- On-chain, multisig-governed trust root for the signing code.

Non-goals:
- New auth protocol (use SIWE/CAIP-122 + WebAuthn + UCAN).
- WoCo-hosted IdP / login analytics.
- Replacing per-transaction value signing (that stays explicit + clear-signed).

## 3. Four layers (separation is the core idea)

1. **Read / profile (NO signature).** ENS/sub-ENS → resolved address → Swarm profile feed
   (`woco/profile/data/{addr}`, `woco/profile/avatar/{addr}`) and ENS `avatar` text records.
   "Web3 account as a profile" lives entirely here. Anyone renders anyone's pfp with zero auth.
2. **Identity / auth (sign ONCE, in the enclave).** The user proves control of their account
   one time inside the verifiable enclave, producing a capability token (§6).
3. **Capability (local, reused).** Scoped UCAN, proof-of-possession bound, stored in the
   enclave origin (not the host page). Reused across platforms without re-signing.
4. **Value (explicit, per-action).** Payments/publishes always prompt, clear-signed
   (EIP-712 / ERC-7730). This is the ONLY place the user consciously signs value — which
   re-sensitises them, the opposite of complacency.

## 4. The signing surface (the enclave)

A small, separately-built, audited bundle served at its own content hash and anchored by
its own ENS name (e.g. a dedicated `*.eth` for the enclave). Embedded by every relying
party (WoCo app, `<woco-tickets>` embed, third parties) as a **sandboxed cross-origin
iframe**. Properties:

- **Origin isolation.** Different origin from the host page → host JS cannot read its DOM,
  storage, or signer state. `sandbox="allow-scripts"` + strict CSP locking it to its own
  origin and the one pinned module.
- **WYSIWYS rendering.** The enclave itself computes and displays the exact bytes to be
  signed (the SIWE/CAIP-122 challenge or EIP-712 struct). The host never renders the prompt.

### Signer routing (EOA and passkey)

- **Passkey (Kernel):** the WebAuthn ceremony runs *inside* the enclave. Fully isolated,
  no relay, key non-extractable in the authenticator.
- **WalletConnect:** the enclave owns its own WC session directly. Fully isolated, no host
  involvement.
- **Injected EOA (MetaMask in top frame):** MetaMask injects only into the top frame, so the
  enclave cannot reach it directly. The enclave renders the challenge and relays a sign
  request to the top frame via a constrained postMessage bridge. Defence-in-depth makes the
  relay non-load-bearing: the **wallet itself re-displays the EIP-712 message**, so a hostile
  relay that altered bytes is caught by the wallet's own confirmation screen, and the
  enclave-rendered text + wallet-rendered text must match. The cryptographic guarantee is the
  wallet's signature over what the wallet displayed; the relay can't forge that.

Recommendation: prefer passkey/WC paths (fully isolated). Injected-EOA is supported with the
re-display backstop.

## 5. Client-side verification — who checks the hash, in a vanilla browser

Layered, honest about residual trust:

- **SRI (the practical primitive, works today).** The enclave iframe loads exactly ONE
  module via `<script type="module" integrity="sha384-…" crossorigin src="…">`. The browser
  refuses to execute any bytes whose SHA-384 ≠ the pinned digest. **The relying party pins
  that digest at integration time** (the version they audited). This is the cryptographic
  check, browser-enforced, no extension required.
- **Trust root = the RP's pinned digest, not WoCo.** The on-chain registry / ENS contenthash
  provides *discovery + the canonical current digest + a monotonic version number* so RPs
  know when to bump. Coordination, not unilateral authority. An attacker who repoints ENS
  cannot affect an RP that pinned an older audited digest (no silent rollback either — see T8).
- **Service worker (closes the iframe-shell gap).** The tiny iframe HTML shell is not itself
  SRI-covered. A service worker registered by the enclave origin intercepts and hash-verifies
  every enclave asset (shell + module) against a signed manifest before serving. This gives
  full in-browser content verification without an extension.
- **ENS/IPFS-native path (strongest).** Brave / MetaMask ENS+IPFS or a verifying local node
  resolve the enclave document by content hash end-to-end.

Residual trust (state it plainly): on a vanilla browser hitting a normal gateway, the gateway
is trusted to serve the correct bytes *for the iframe shell*; SRI then guarantees the executed
logic, and the service worker closes the shell gap if registered. Fully trustless delivery
still needs a verifying client (SW / native). This is an ecosystem-wide open problem; we are
honest about it and pick the strongest layer available per client.

## 6. Capability tokens (UCAN)

- One signature (root, by EOA or passkey) mints a **UCAN**: DID = the user's account.
- **Attenuated scopes**: `profile:read`, `event:claim`, etc. The auth/profile capability is
  separate from any value capability.
- **Proof-of-possession bound** — audience = the RP origin, short TTL, bound to the signer
  (passkey-bound or DPoP-style) so a stolen token can't be replayed on another origin. Not a
  pure bearer token.
- **Stored in the enclave origin** (not host page localStorage), so host XSS can't read it.
- Offline-verifiable by any RP (verify the DID's signature / on-chain 1271/6492) — **no
  callback to WoCo**.
- Session-key delegation (existing) is the natural transport; revocation reuses the existing
  nonce blacklist / revoke-all infra.

## 7. Trust root & publish — omnipin as the L1 ENS governance layer

**What omnipin is (verified from source, not marketing):** a client-side CLI. It packs the
built bundle (CAR/IPFS or TAR/Swarm), uploads it to storage providers *we* configure, and
updates the **L1** ENS `contenthash` / DNSLink. It runs **no** storage infrastructure.

Confirmed facts:
- Swarm target = **our own Bee** (`OMNIPIN_BEE_URL` + `OMNIPIN_BEE_TOKEN` = postage batch) or
  **Swarmy** (third-party SaaS). For WoCo this uploads to our existing Hetzner Bee.
- **Cannot mix IPFS + Swarm in one deploy** (`deploy.ts`: Swarm providers, if present, take
  over and IPFS is skipped). Redundancy is within a protocol only.
- ENS update modes: **EOA** (hot key owns name — avoid), **Safe Delegate** (propose →
  manual multisig approval; most secure), **Zodiac Roles** (role-restricted hot key that can
  *only* `setContenthash`, name owned by a Safe; single-command CI).
- **L1 only** — `chainToRpcUrl` ⊃ {mainnet, sepolia}. **No Arbitrum / L2 / sub-ENS support.**
- **No reproducible-build verification** — it hashes whatever bytes it's given.

**Role in this design:** omnipin is the **publish + governance layer for the enclave bundle's
L1 ENS contenthash**, run from CI under **Zodiac Roles or Safe Delegate**. That makes "who can
repoint the canonical signing code" a multisig/role decision with on-chain history — the
publisher-key-governance requirement for a universal primitive. Upload target = our Hetzner
Bee (optionally + Swarmy for a second Swarm copy).

**What omnipin does NOT cover (stays ours):**
- Reproducible builds (so the pinned digest provably == audited source). MUST-build.
- The signing surface, isolation, capability layer, client-side verification (§4–6).
- Any L2 / sub-ENS pointer (omnipin is L1-only). Sub-ENS identity stays on Durin/Arbitrum.
- `ContentHashRegistry.sol` seam: keep for per-RP version pinning + monotonic version /
  min-acceptable-version (anti-rollback, T8) if richer than ENS contenthash alone.

**omnipin L2 support is NOT a WoCo need (verified 2026-06-16).** WoCo already writes sub-ENS
contenthash in-house via the custom **WoCoRegistrar** (`apps/server/src/lib/chain/sub-ens-contract.ts`):
`setContenthash(string label, bytes)` + `registerWithPermit(...)`, sponsor-gated. That is NOT the
canonical `setContenthash(bytes32 node, bytes)` resolver omnipin drives (omnipin also resolves the
resolver via the L1 ENS registry, where Durin sub-names don't exist). So omnipin cannot and need
not drive WoCo's L2 path. A generic omnipin L2 PR (`--chain` + `--resolver` for *standard* L2
resolvers, e.g. ENSv2/Basenames) is worthwhile as an ecosystem contribution + dev-relationship
move, but it is explicitly NOT a WoCo dependency and would not cover custom permissioned registrars.
Durin addrs (Arb Sepolia 421614): Registrar `0x206e5e…BEd3`, L2Registry `0x41Fb19…84807`.

## 8. Threat model

| ID | Threat | Mitigation |
|----|--------|-----------|
| T1 | Server/gateway swaps signing code (phish the signature) | Content-addressed bundle + SRI digest pinned by RP; enclave renders the prompt |
| T2 | Host-page XSS hooks signer / steals token | Cross-origin sandboxed iframe; signer key external (EOA/passkey); capability in enclave origin |
| T3 | Compromised publisher key repoints ENS to malicious bundle | omnipin Zodiac Roles / Safe Delegate multisig; on-chain history |
| T4 | Stolen capability replayed elsewhere | UCAN PoP: audience=origin, short TTL, signer-bound (not bearer) |
| T5 | Delegated session-key compromise | Scoped + expiring + revocable (existing revocation infra) |
| T6 | TOCTOU: verify hash then load different bytes | Fetch-by-hash; SRI enforced at execution; SW verifies all assets |
| T7 | Trust-root bootstrap (who names the good hash) | RP pins the SRI digest it audited; ENS/registry = discovery only |
| T8 | Rollback: serve old signed-but-vulnerable bundle | Registry monotonic version + RP pins min-acceptable version |
| T9 | Injected-EOA relay rewrites message | Wallet re-displays EIP-712; enclave text must match wallet text |

## 9. WoCo-first rollout

1. **Reproducible build** of a minimal enclave bundle (deterministic → stable SHA-384). Gate.
2. **Enclave v0**: sandboxed iframe, SIWE/CAIP-122 challenge rendered in-enclave, passkey +
   WalletConnect paths fully isolated; injected-EOA via relay + wallet re-display.
3. **SRI + CSP** wiring; service worker for full asset verification.
4. **UCAN capability** mint + PoP binding; store in enclave origin; offline verify.
5. **omnipin publish** under Zodiac Roles to the enclave's L1 ENS name (upload to Hetzner Bee).
   Decide registry vs plain contenthash for versioning.
6. Dogfood inside WoCo app + `<woco-tickets>` embed. Only then expose as a third-party
   `<woco-auth>` web component (same delivery shape as the existing IIFE embed).

## 10. Open decisions

- Reproducible-build toolchain (esbuild/rslib pinned + lockfile + SOURCE_DATE_EPOCH?).
- Registry vs ENS-contenthash-only for version pinning / anti-rollback.
- Dedicated ENS name for the enclave; who holds the governing Safe (signers).
- How hard to push per-RP pinning now vs stub (the "WoCo-hardened" vs "third-party-verifiable
  on day one" cost fork).
- Sub-ENS (Arbitrum) is the *identity* the enclave authenticates; the enclave *code* is
  anchored on L1 ENS (omnipin). Confirm that split is acceptable.
- Whether to float/build the generic omnipin L2 PR at all (ecosystem goodwill, NOT a WoCo
  need — our sub-ENS writes are already handled in-house via WoCoRegistrar).
