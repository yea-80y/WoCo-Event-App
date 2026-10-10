# Architecture

How WoCo is put together, what each layer is trusted for, and how a request moves through it.

**Read §1 first.** It is the whole system in about five minutes, and everything after it is
detail you can come back for.

Companions: [IDENTITY_AND_KEYS.md](./IDENTITY_AND_KEYS.md) (keys and signing),
[SWARM_DATA_MODEL.md](./SWARM_DATA_MODEL.md) (storage), [TICKETING.md](./TICKETING.md)
(the ticket lifecycle), [CONTRIBUTING.md](./CONTRIBUTING.md) (running it).

**Verified against `main` (94364b56) on 2026-10-05.** Where this document states an address, a
constant or a flag, the file it came from is named - check there rather than trusting this copy.

---

## 1. The mental model

### 1.1 The one paragraph

WoCo is an event platform where **the user is the author of their own data**. The browser holds
the keys and signs everything the user is the author of: their profile, their events, their
websites, their likes, and the credentials an organiser issues. Those signed objects are stored
as **chunks on Swarm**, addressed by a hash anyone can compute, so *anyone* can verify them
without asking us. Tickets settle **on chain**, because "who owns seat 12" needs a ledger with a
single answer. The server exists to do the things a browser cannot: **verify and pay** for
storage, **hold secrets** (Stripe, email, the sponsor wallet), **write to chain** for people who
have no wallet, and **tell a reader which signer owns a given event's chunk**.

Be precise about the last one, because it is where the honest limit of the design sits. The
server cannot **forge** a signed object — it holds no user key. But it does tell you *whose
signature to expect*, through platform-signed carriers (the directory entry, the site events
index), and most reads in the app go **through** the API rather than around it. So the accurate
claim is not "the server is untrusted"; it is **"the server cannot author, but it can
misdirect."** §1.3 spells out exactly where that line falls.

### 1.2 The five layers

Read top to bottom. Each layer only depends on the ones below it.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 5  PRESENTATION    the platform app · deployed organiser sites ·         │
│                    the embed widget · the door scanner                   │
│                    Four builds, one source tree (apps/web + packages)    │
├──────────────────────────────────────────────────────────────────────────┤
│ 4  SETTLEMENT      what needs one agreed answer, so it goes on chain:    │
│                    ticket slots · sub-ENS names · smart accounts         │
├──────────────────────────────────────────────────────────────────────────┤
│ 3  STORAGE         Swarm chunks, addressed by hash. Mutable "feeds" are  │
│                    built from immutable chunks by versioning the         │
│                    address. Anyone can read; only the owner can write.   │
├──────────────────────────────────────────────────────────────────────────┤
│ 2  AUTHORSHIP      frozen wire formats + one signature discipline.       │
│                    An object is trustworthy because of who signed it,    │
│                    never because of where it was found.                  │
├──────────────────────────────────────────────────────────────────────────┤
│ 1  IDENTITY        a parent wallet, and keys derived from it — one per   │
│                    ROLE, never one key reused across roles               │
└──────────────────────────────────────────────────────────────────────────┘

                    the API server sits BESIDE this stack, not inside it:
                    it verifies (2), pays for (3) and transacts on (4) —
                    and is authoritative for none of them
```

If you remember one sentence from this document: **trust in WoCo comes from signatures, not from
servers.** Almost every design decision in the codebase follows from that, including the awkward
ones.

### 1.3 Who trusts what

This table is the fastest route to understanding why the code looks the way it does.

| Thing | Trusted for | Explicitly *not* trusted for | What would happen if you trusted it anyway |
|---|---|---|---|
| **The API server** | Verifying signatures, paying for storage, holding secrets, sending chain transactions — **and pointing you at which signer owns an event's chunk** | *Authoring* user content: it holds no user key, so it cannot produce a valid signature | A compromised server cannot forge a signed object, but it **can re-point a reader at a different author** by serving a different `creatorFeedSigner`. Detecting that needs an out-of-band check of who the signer should be |
| **A Swarm chunk's address** | Locating bytes | Making those bytes authentic | Anyone can upload anything; only the signature over it means something |
| **A chunk's signature** | Proving *who wrote it* | Proving it is *current*, or that it is the object the chain registered | You would accept an old version, or a manifest the organiser never registered |
| **The chain** | Who owns a ticket slot; who owns a name; what a manifest digest was at registration | Anything about content or display | The chain stores hashes and owners, nothing readable |
| **The event feed at mint time** | Display fields — a title, a series name | *Which* on-chain event to mint against | An organiser could re-sign their own feed after checkout and re-point the mint, money already taken (this was a real defect) |
| **A gateway 403** | "This chunk is not whitelisted" — but **only** when it carries our own tag | Any other 403 | A Cloudflare or proxy 403 means "couldn't ask", and caching that as "does not exist" has caused live incidents twice ([why](./SWARM_DATA_MODEL.md#6-reading-the-gateway-and-the-whitelist-that-is-not-a-cache)) |
| **`.data/*.json` on the server** | Operational state | Being reconstructible — most are, a few are **not** | Losing `onchain-events.json` stops every sale, silently |
| **Anything in a request body** | Nothing at all | Identity, especially | The server always acts on the parent address it *verified*, never one it was told |

### 1.4 One ticket, all the way through

Every layer, in one example. This is the shortest complete tour of the system.

```
 ORGANISER                                              LAYER
 ─────────────────────────────────────────────────────  ─────
 fills the form — no wallet popup yet                     5
 on publish, derives an ISSUING key from their seed       1
 builds N edition bodies, Merkle-roots them,
   signs ONE manifest over the root                       2
 server verifies a proof-of-possession and pins
   parent → issuer, then hands the assembled feed BACK    2
 the CLIENT signs that feed and uploads it as its own
   chunk — the server has no key for it                   3
 a SEPARATE call per series registers on chain; the
   manifest digest becomes `manifestRef`                   4
                                                          │
 BUYER                                                    │
 ─────────────────────────────────────────────────────    │
 the browser seals the order form to the organiser's
   X-Wing key; the server HOLDS the box until paid         2
 pays by card. Stripe charges the ORGANISER's account      │
 webhook fires:                                            │
   · a throwaway BURNER keypair is generated               1
   · batchClaimFor() mints the slot to that burner         4
   · the burner signs ONE message, then is DISCARDED       2
   · the paid box is stored; its ref is onchain            3,4
   · ticket emailed: an image and a static-page link,
     the ticket in the URL fragment                        5
                                                          │
 AT THE DOOR                                              │
 ─────────────────────────────────────────────────────    │
 scanner reads the QR                                      5
 recovers the signature → compares against the             2,4
   on-chain slot owner
 verdict: valid · unverified (chain unreachable) · invalid
   · refunded (the door pack lists voided slots)
 admits it ONCE across every scanner                       5
```

Four things that example is designed to make obvious:

1. **The organiser signs once for a whole series.** No per-ticket signature exists.
2. **The buyer never needs a wallet.** The platform mints to a burner whose key lives for
   milliseconds. The on-chain slot owner is the trust root.
3. **The order data is unreadable to us.** It is sealed to the organiser's key before it leaves
   the browser, and the platform never holds the matching private key. Only when a browser sent
   no box does the server seal a minimal record itself (ticket type, and the buyer's email or
   account address, which it already has). The box goes on Swarm only once paid, so it can be erased (#546).
4. **Verification does not need our server.** It needs the message, the signature and the
   onchain slot owner. Admission is different: a ticket gets in once across every scanner, so a
   shared door asks the server to claim it, and only a pass bound to one phone admits offline
   (#641).

### 1.5 What each package is *for*

| Package | Its job, in one line |
|---|---|
| `packages/shared` | **Everything both sides must agree on byte-for-byte.** Formats, crypto, topic derivation, addresses, flags. |
| `apps/web` | Holds the keys, signs, renders. Four different builds. |
| `apps/server` | Verifies, pays, transacts, and holds secrets. |
| `packages/embed` | Two dependency-free bundles for pages we do not control. |
| `apps/registry` | A separate small app for on-chain content-hash verification. |
| `contracts/` | A **separate repository**. See [CONTRIBUTING.md](./CONTRIBUTING.md#4-contracts-is-a-different-repository). |

`packages/shared` is the one to understand first. If a constant appears in two places with no
compiler relationship between them, that is a bug waiting — the sub-ENS registrar address drifted
between client and server for months exactly that way, and the fix was a single exported
constant.

---

## 2. The runtime picture

```
        ┌──────────────────────────────────────────────────────────────┐
        │  BROWSER (apps/web)                                          │
        │  Svelte 5 · signs everything the user is the author of       │
        │    · session delegation + per-request signatures             │
        │    · content chunks (profile, event, site, likes)            │
        │    · issuance manifests (organiser side)                     │
        │    · sealed order envelopes (attendee side)                  │
        └───────┬──────────────────────────────────────┬───────────────┘
                │ signed writes, authenticated reads   │ reads by
                │                                      │ computed
                ▼                                      │ chunk address
        ┌──────────────────────────┐                   │
        │  API (apps/server)       │                   │
        │  Hono · ~36 routers      │                   │
        │   · verifies signatures  │                   │
        │   · pays for storage     │                   │
        │   · holds the secrets    │                   │
        │   · writes to chain      │                   │
        └──┬──────────┬────────┬───┘                   │
           │          │        │                       │
           ▼          ▼        ▼                       ▼
     ┌─────────┐ ┌────────┐ ┌──────┐        ┌──────────────────┐
     │ Stripe  │ │ Chains │ │ SES  │        │  Swarm (Bee)     │
     │ Connect │ │ (§3)   │ │ mail │        │  via bee-proxy   │
     └─────────┘ └────────┘ └──────┘        └──────────────────┘
```

Note the two arrows out of the browser — but read the asymmetry carefully, because it is
narrower than it looks.

**Writes always go through the server**, because storage has to be paid for with a postage batch
the server stamps with: WoCo's own, Etherna's platform batch, or the account's own Etherna batch
(`apps/server/src/lib/etherna/batch-router.ts`). An account with no ticket, Stripe verification or
confirmed invite cannot make the platform pay: likes, follows, names, profiles, raw uploads and
issuer statements answer `ticket_required` until it unlocks (#753, #757).

**Reads are split, and the split is not "content goes direct".** Gateway-direct today: profiles
when the caller already holds the signer, social statements, and recovery envelopes — all
addressed by computed chunk address. Through the API: the **global event directory**, the
**per-creator catalogue**, and **event detail pages**, where the server acts as a relay that
resolves the creator's chunk on the caller's behalf (`GET /api/events/:id`, optionally with a
`?signer=` carrier to skip a directory scan). Events are the most-read data in the app, so in
practice most reads are relayed.

What the direct-read path buys is not everyday performance — it is that the data **remains
verifiable and reachable without us**. A third party holding a signer address and a topic can
reconstruct any chunk address and check the signature themselves. That property is what the
design protects; it is not a claim that the running app avoids the server.

### The four builds from one source tree

| Output | Entry | Runs where |
|---|---|---|
| `dist/` | `index.html`, `verify.html`, `ticket.html` | The platform app, at `woco.eth.limo`. The same collection carries the standalone verification page and the static ticket page (`vite.ticket.config.ts`: one file, script inlined, `connect-src 'none'`). |
| `dist-multisite/` | `multi-site.html` | Each **deployed organiser site** — a standalone Swarm collection with `window.SITE_CONFIG` injected at deploy time. No server at page load. |
| `dist-scanner/` | `scanner.html` | The **door-scanner PWA**. Deliberately has no auth stack and no Swarm reads - provisioned entirely by a door-pass URL. Whether it admits offline depends on the pass's door mode ([TICKETING.md §5](./TICKETING.md#5-at-the-door)). |
| `dist-site/` | `site.html` | Each published **single-event page**. The event-page builder (`apps/server/src/routes/site.ts`) bakes this bundle in, so - as with multisite - a change reaches nobody until each page is re-published. |

`packages/embed` builds separately: two IIFE bundles that third-party pages load directly. The
server serves `woco-embed.js` off its own filesystem at `GET /embed/woco-embed.js` and builds it
inside its Docker image, so **the embed ships with a normal server deploy and has no deploy step
of its own**.

---

## 3. The chains, and which one does what

This is the most common source of confusion. WoCo touches three chains and they do different
jobs.

| Chain | What lives there | Defined in |
|---|---|---|
| **Arbitrum One** (`42161`) | Sub-ENS v2.2 registry + registrar (`*.woco.eth` names as ERC-721), ZeroDev **Kernel** smart accounts for passkey and email logins, their paymaster, the guardian recovery hook. A copy of `WoCoTicketLedger` is deployed here too (2026-09-25) but the server does not mint on it yet. | `packages/shared/src/sub-ens/addresses.ts`, `packages/shared/src/kernel/{chain,recovery-contracts}.ts` |
| **Arbitrum Sepolia** (`421614`) | The **live ticket ledger** - `WoCoTicketLedger`, which stamps the real organiser as owner of record. Registrations made earlier on `WoCoEventV2` still verify, because each record names its own contract (#563). Tickets are still on testnet, and this chain is selected by **env, not by code default** - see the warning below. | `apps/server/src/lib/chain/event-contract.ts` + `WOCO_EVENT_CHAIN_ID` |
| **Ethereum mainnet** (`1`) | `woco.eth` itself, and the `L1Resolver` (v2) that answers for every subname by EIP-3668 CCIP-Read | the contracts repo, `deployments/1-l1resolver.json` |

So a live name is real mainnet ENS resolution, backed by a mainnet resolver that calls out to our
gateway, which reads an Arbitrum One registry — while the tickets those names point at are minted
on a testnet. That asymmetry is deliberate for pre-launch; moving the server onto the Arbitrum One
ledger is a launch-day item.

> **The ticket contract is env-selected, and the code default is something else.** Production
> selects the ledger on `421614` through `WOCO_EVENT_CHAIN_ID` and `WOCO_EVENT_VERSION_421614`, and
> because `DEPLOYED_LEDGER` in `event-contract.ts` is still an empty map, its address comes from
> `WOCO_EVENT_ADDRESS_LEDGER_421614` as well. With nothing set the server falls back to chain
> **`84532` (Base Sepolia)** and contract version **`v1`** - the old `WoCoEvent`. **None of these
> variables appears in `.env.example`**, so a fresh local server silently registers events on a
> different contract on a different chain than production. Set them before touching anything
> ticket-shaped.

**Addresses are deliberately not listed here.** They have exactly one owner each, so a stale
copy cannot appear in two places: sub-ENS registry / registrar / L1Resolver →
[SUBENS_IDENTITY.md § Where it lives](./SUBENS_IDENTITY.md#where-it-lives); ticket contracts →
[DEPLOYMENTS.md](./DEPLOYMENTS.md). The deployment records in the contracts repository
(`deployments/*.json`) are the source of truth for all of them.

Two constants have to stay equal — `KERNEL_CHAIN_ID` and `SUB_ENS_DEFAULT_CHAIN_ID` — because a
name holder must answer ERC-1271 on the same chain the registry asks on. They are separate
constants with separate jobs, and `packages/shared/test/kernel/chain.test.ts` is what keeps them
in agreement.

### ENS resolution, end to end

1. A browser resolves `nabil.woco.eth` and reaches the mainnet `L1Resolver`.
2. The resolver reverts `OffchainLookup` (EIP-3668) pointing at
   `https://events-api.woco-net.com/api/ens-gateway/v1/{sender}/{data}`.
3. Our gateway (`apps/server/src/lib/ens-gateway/`) reads the pinned Arbitrum One registry and
   signs the answer with the key the resolver's `signer()` names.
4. The resolver accepts anything that signature verifies. **There is no second opinion** — which
   is why every refusal in `ccip.ts` is a security control, not input validation: nothing is
   signed until the request is proved to be about a name this gateway may answer for, and the
   answer has come from the registry rather than from the request.

In a browser a name is reached through eth.limo. Since 2026-09-28 eth.limo holds wildcard
certificates for `*.woco.eth.limo` and `*.woco.eth.link`, so a new name no longer waits for a
per-name certificate.

Full detail: [SUBENS_IDENTITY.md](./SUBENS_IDENTITY.md).

---

## 4. What the server is for

The server is not the source of truth for user content, and it is also not optional. It holds
exactly four kinds of responsibility.

**(a) It verifies, then stamps.** Users sign their own content chunks. The server independently
re-derives the chunk address from the submitted bytes, checks the signature recovers to the
claimed owner, then pays for the storage with a postage batch (§2) and uploads
(`POST /api/swarm/soc` → `apps/server/src/lib/swarm/soc-upload.ts`). It cannot forge user
content. It does relay many reads (§2), but cannot alter what a signature covers.

**(b) It holds what a browser cannot.** Stripe secret keys, the SES credentials, the email HMAC
secret, the payment-quote HMAC secret, the postage batches, the ticket sponsor wallet's private
key, the separate names sponsor key, the attendee-batch stamper key, the ENS gateway signing key.
This is the honest reason a server exists at all in a "decentralised" app.

**(c) It writes to chain on a user's behalf.** Event registration and ticket minting go through a
platform **sponsor wallet** (`WOCO_SPONSOR_PRIVATE_KEY`), so a card buyer who never touches a
wallet still gets an on-chain ticket. The contract gates those calls behind an
`authorisedSponsors` allow-list, which is checked before a checkout is allowed to charge: an
unauthorised sponsor would make every paid claim revert `NotAuthorised` *after* the money was
taken. The ledger also caps each sponsor's mints per hour (`sponsorMintAllowance`), and checkout
refuses a sale the cap cannot mint (#662, #665). Note that the deployment records name the
`initialSponsor` at deploy time, not the current allow-list - that only chain can answer.
Sub-ENS names are minted by a different sponsor key; the server refuses to boot if the two match.

**(d) It keeps a small amount of durable local state.** About forty JSON files under `.data/`,
written through `writeJsonAtomic` (0600 by construction, enforced by
`apps/server/test/data-store-modes.test.ts`).

### Which of those stores are cache and which are truth

Most are caches or dedupe sets and can be dropped. A minority cannot, and knowing which is which
is operationally load-bearing:

| Store | Why it cannot be rebuilt |
|---|---|
| `onchain-events.json` | eventId+seriesId → the on-chain event **this server** registered, and (#563) the contract it lives on. Checkout refuses to charge a series with no record, and the chain-log walk cannot reconstruct the mapping. **Losing it stops all sales.** Never wipe it at a contract cutover. |
| `event-attendees.json` | eventId → attendee email hashes. The only server-visible proof a broadcast recipient holds a ticket. The plaintext address is never stored anywhere it could be re-derived from. |
| `marketing-suppression.json` | Unsubscribes. Losing it means emailing people who opted out — a legal breach, not a bug. |
| `kernel-deployed.json` | Which Kernels have been seen with an on-chain owner, which owner, at which block and on which chain. Losing it reopens a window where a lagging RPC replica can roll an owner back to a retired key. |
| `pending-refunds.json` | Refunds Stripe refused to create. Losing it means a buyer charged with no ticket, no refund and no alarm. |
| `profile-names.json` | Which sub-ENS name is an account's *profile* name, plus its rename clock. A registry says who **holds** a name, never what it is **for**. Fails open by design. |
| `revoked-sessions.json` | Session revocation. Losing it un-revokes. |
| `event-feed-signers.json` | eventId → the organiser's feed signer, pinned at create (#670). The money path's only carrier for an unlisted event. Fails closed. |
| `ticket-sales.json` | Each sale's payment intent and minted slots. Refunds and chargebacks void tickets through it; losing it lets refunded tickets in at the door again. |
| `event-cancellations.json` | Cancelled events and the refund owed on each sale (#644). Losing it lets a cancelled event sell again. |
| `held-orders/` · `attendee-slots.json` | Paid order boxes not yet on Swarm, and which batch slot holds each stored order - the only way to erase one (#546). |
| `device-grants.json` | Each account's added passkeys and every nonce used (#746). Losing it signs added devices out. |

The full annotated list, with the reasoning for each, is in `CLAUDE.md` under
`.data` FILES THAT MUST SURVIVE RESTARTS. `.data/broadcast-chunks/` is the deliberate opposite
case: its contents are encrypted under a key held only in the running process, so a restart makes
them unreadable and the boot sweep deletes them.

`GET /api/health` is the operational surface for all of it — payout sweep, pending refunds,
undelivered ticket emails, broadcast jobs, evidence publisher, the deployed commit.

---

## 5. How a request is authenticated

Two independent layers, and **nothing is signed at login** — login only connects.

1. **A session delegation**, signed once per 30 days by the parent wallet (EIP-712), handing
   authority to a generated session key.
2. **A per-request signature** by that session key (EIP-191) over a canonical challenge that
   includes the method, path, timestamp, nonce and a hash of the **raw body bytes**.

The server always acts on the parent address it **verified**, never one from a request body.

Mechanism, headers, the raw-bytes rule and revocation:
**[IDENTITY_AND_KEYS.md § API authentication](./IDENTITY_AND_KEYS.md#9-api-authentication)**.

---

## 6. Data flow: creating and selling an event

The layered version is in §1.4. This is the same path with implementation names attached, so you
can find each step in the code.

```
ORGANISER PUBLISHES
  1. Fill the whole form. No wallet popup yet ("build first, sign later").
     The organiser area opens only for a passkey account (#768).
  2. On publish:
     · auth.ensureAccountSetup({ identity: true }) → whatever this device
                              still lacks: the session delegation, the seed
     · ensureIssuingKey()   → derive the secp256k1 issuing key (fails LOUD, never
                              silently falls back to another signer)
     · derive the X-Wing order key from the seed; send only its PUBLIC half
     · build one edition body per ticket, Merkle-root them, sign ONE manifest
     · sign an issuer-binding proof-of-possession over the parent address
  3. POST /api/events  (streams progress; RETURNS the assembled feed)
     · verifies the issuer binding, pins parent → issuer in issuer-bindings.json
     · publishes the order public key as its own chunk; the feed carries its ref
     · pins the event's feed signer in event-feed-signers.json (#670)
     · returns `eventFeed` — it does NOT write it. "The server has no key"
       (routes/events.ts). The CLIENT signs that exact feed and uploads it as
       its own SOC; a failure there fails the publish. A paid event defers
       that write and signs once, after registration
     · `creatorFeedSigner` is OPTIONAL here. Omit it and the event feed is
       written PLATFORM-signed instead (the legacy path; every live login kind
       except the disabled Coinbase one sends a signer)
  3b. POST /api/events/:id/register-on-chain — a SEPARATE authenticated call,
      made once PER SERIES by the publish button
     · sends registerEvent from the sponsor wallet, records the result AND the
       contract it landed on in onchain-events.json (see §4 — truth, not
       cache), and returns the updated feed for the OWNER to re-sign, so
       onChainEventId lands inside the client-signed SOC
  4. Directory: a debounced rebuild groups on-chain registrations, resolves each
     one's creator-signed content, and publishes an immutable snapshot blob
     behind a platform-signed pointer feed. The snapshot is a CACHE — a missed
     rebuild costs freshness, never integrity.

ATTENDEE BUYS
  5. POST /api/events/:id/series/:sid/reserve   → holds a seat for 10 minutes
  6. POST /api/stripe/prepare-order → the box the browser sealed to the
     organiser's X-Wing key is HELD, not stored; returns its ref + a token
  7. POST /api/stripe/create-checkout → Stripe Checkout, a direct charge on the
     organiser's connected account. Refused if the sponsor's hourly mint cap
     cannot cover it, or the event is cancelled
  8. Stripe webhook → fulfilment, only for a session whose provenance and
     integrity tag verify (lib/stripe/checkout-provenance.ts):
     · mark the held box paid; with none, the server seals a minimal order
     · generate one ephemeral BURNER keypair per ticket
     · batchClaimFor(eventId, burnerAddresses, orderRef) as the sponsor
     · each burner signs its own ticket message, then the key is DISCARDED
     · store the paid box on the attendee batch (#546)
     · email the ticket (composite PNG + a /ticket.html#… link)
  9. Any failure after the charge triggers an automatic refund; refunds Stripe
     refuses go to pending-refunds.json and raise a /api/health alarm.
 10. A refund, a chargeback or a cancelled event voids the sale's tickets at
     the door (ticket-sales.json, event-cancellations.json).
```

Full lifecycle, including what makes a ticket genuine and what happens at the door:
**[TICKETING.md](./TICKETING.md)**. Stripe mechanics: **[PAYMENTS_INTEGRATION.md](./PAYMENTS_INTEGRATION.md)**.

---

## 7. The subsystems, and where each one is documented

This section is deliberately a **map, not a description**. Each subsystem owns its own document;
the paragraph here exists to tell you whether that is the document you want.

### Identity, accounts and recovery
Three live login methods — passkey, email and wallet — of which the first two are ZeroDev Kernel
smart accounts on Arbitrum One. Each account derives one key per **role** rather than reusing
one. Organising needs a passkey account (#768), and every passkey on an account is an equal
co-owner (#770, #771). Email accounts can keep a guardian escrow the server can neither open nor
forge; a passkey account's way back is its synced passkey and the devices it has linked.
→ **[IDENTITY_AND_KEYS.md](./IDENTITY_AND_KEYS.md)** ·
[PASSKEY_SMART_WALLET.md](./PASSKEY_SMART_WALLET.md) ·
[PASSKEY_RECOVERY_PLAN.md](./PASSKEY_RECOVERY_PLAN.md)

### Storage
Swarm chunks addressed by hash; mutable feeds built from immutable chunks by versioning the
address; topics derived by HMAC for statements and by path for content. The gateway's whitelist
is data-plane state, not a cache — which is the single most important operational fact in the
system.
→ **[SWARM_DATA_MODEL.md](./SWARM_DATA_MODEL.md)** ·
[CLIENT_FEED_SIGNER_HANDOVER.md](./CLIENT_FEED_SIGNER_HANDOVER.md)

### Ticketing and credentials
One signed manifest per series committing to a Merkle root over every edition; no per-ticket
signature. Sale is Stripe-only, the mint goes to an ephemeral burner, and verification is a
signature recovery compared against the on-chain slot owner. A ticket is admitted once across
every scanner, and refunds, chargebacks and cancellations void it at the door. The same machinery
can issue badges and certificates; both are off for launch.
→ **[TICKETING.md](./TICKETING.md)** · [V1_RETIREMENT_HANDOVER.md](./V1_RETIREMENT_HANDOVER.md)

### Payments, payouts and pricing
Stripe Connect direct charges on the organiser's own account. Payouts are manual and released
after the event. Every fee rate has exactly one home.
→ [PAYMENTS_INTEGRATION.md](./PAYMENTS_INTEGRATION.md) ·
**[PAYOUTS.md](./PAYOUTS.md)** (authoritative on payouts) ·
**[PRICING_AND_EMAIL.md](./PRICING_AND_EMAIL.md)** (authoritative on all fee arithmetic — never
restate a rate elsewhere)

### Names
`*.woco.eth` as ERC-721 tokens in an Arbitrum One registry, resolved from Ethereum mainnet by
EIP-3668 CCIP-Read through a gateway we run. A name is a display and routing primitive; anything
that must survive a name changing hands keys off the account address instead.
→ **[SUBENS_IDENTITY.md](./SUBENS_IDENTITY.md)**

### Sites
Organisers publish multi-page websites as standalone Swarm collections that need no server at
page load. The runtime bundle is baked in at publish time, which is why a runtime change reaches
nobody until each site is re-published.
→ **[SITE_BUILDER.md](./SITE_BUILDER.md)** · [SEO_PLAN.md](./SEO_PLAN.md) (authoritative on SEO
and custom domains)

### Social
Likes and follows are chain-free Swarm statements written to the user's own feed. Counting is
left to indexers reading public feeds, which is a design choice rather than a gap: a Swarm feed
has exactly one owner-signer, so there is no shared state to write a count into. Retraction is a
written `value: false`, never a deletion. Writing one needs the unlock a name needs - a ticket,
Stripe verification or a confirmed invite (#753).
→ **[SWARM_SOCIAL_PLAN.md](./SWARM_SOCIAL_PLAN.md)** (authoritative) ·
[COASTER_CREDITS_PLAN.md](./COASTER_CREDITS_PLAN.md) (the credits rail, and the design record for
the frozen statement discipline)

The predecessor — EAS attestations on Arbitrum plus a Stylus aggregator for trending — is gone,
not merely superseded: the likes half was deleted in #475 and the referral half, the last EAS user
in the tree, in #476. `packages/shared/test/no-eas.test.ts` keeps it out.

### Email
Amazon SES, in two independent lanes with different reputations and different rules:
transactional ticket delivery, and marketing broadcasts with consent capture, suppression and
RFC 8058 one-click unsubscribe. Broadcasts are resumable queued jobs, and a deploy ends the
in-flight ones **by design** — recipient lists are held encrypted in process memory only.
→ **[EMAIL_NEXT_HANDOVER.md](./EMAIL_NEXT_HANDOVER.md)** (start here) ·
**[MARKETING_COMPLIANCE.md](./MARKETING_COMPLIANCE.md)** (authoritative on the rules)

### The embed widget
Two dependency-free IIFE bundles for pages we do not control. `<woco-tickets>` is **card-only by
decision**: guest Stripe checkout, no wallet, no passkey, no account — the v2 rail mints at
payment, so the widget's only job is to start a checkout honestly.
→ [packages/embed/README.md](../packages/embed/README.md)

---

## 8. Runtime topology

Public shape only; the operational runbook is deliberately **not in this repository**.

- **Backend** — a Docker Compose stack on one VM: `bee` (Swarm node) + `bee-proxy` + `server`.
  Deploys are a scripted rsync plus a compose rebuild, and the script stamps the verified commit
  so `/api/health` reports what is actually running.
- **Frontend** — built, uploaded to Swarm as a collection, and pointed at by a feed. Reachable
  through `gateway.woco-net.com/bzz/<manifest>/` and, via ENS contenthash, at `woco.eth.limo`.
- **API** — `events-api.woco-net.com`, fronted by Cloudflare.

Two gateway facts that are easy to get wrong:

1. `Vite base` must be `'./'`. Absolute paths break under Swarm `/bzz/` URLs.
2. **The bee-proxy whitelist is data-plane state, not a cache.** The proxy serves only addresses
   it has been told about, and a *tagged* refusal is treated by the client as "this chunk does
   not exist" — so a **lost** whitelist entry makes real data read as absent. The mechanism, the
   trust rule and the latency it bought are documented once, in
   [SWARM_DATA_MODEL.md § Reading: the gateway](./SWARM_DATA_MODEL.md#6-reading-the-gateway-and-the-whitelist-that-is-not-a-cache).

---

## 9. Where to go next

| Question | Doc |
|---|---|
| Which key signs what? | [IDENTITY_AND_KEYS.md](./IDENTITY_AND_KEYS.md) |
| How is a mutable feed built from immutable chunks? | [SWARM_DATA_MODEL.md](./SWARM_DATA_MODEL.md) |
| What makes a ticket genuine? | [TICKETING.md](./TICKETING.md) |
| How do organiser websites work? | [SITE_BUILDER.md](./SITE_BUILDER.md) |
| What are the names for? | [SUBENS_IDENTITY.md](./SUBENS_IDENTITY.md) |
| How do I run this and land a change? | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Everything else | [README.md](./README.md) |
