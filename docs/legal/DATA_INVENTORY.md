# Data Inventory — UK GDPR Article 30 Record of Processing Activities

**Status:** verified against source, 2026-07-26. **Not** a draft from memory — every claim below
cites the file that makes it true. Re-verify before each material release.

This is the evidence base. The Privacy Policy, DPA and Organiser Terms all derive from it and must
never claim more (or less) than this document supports.

> **Verification rule:** if you change a data path, change this file in the same commit. A privacy
> policy that describes an architecture we do not have is a misrepresentation to data subjects and
> to the ICO, and is worse than having no policy.

---

## 1. Controller / processor determination

WoCo is **not** a single role. Claiming "we hold no data" across the board would be false and would
not survive scrutiny. The accurate split:

| Processing activity | WoCo's role | Basis |
|---|---|---|
| Attendee order-form answers (name, phone, dietary, custom fields) | **Processor** for the organiser | Organiser defines the fields (`OrderField[]`, set at event creation) and is the only party able to read them. WoCo cannot decrypt — see §4. |
| Attendee email address for ticket delivery | **Processor** for the organiser | Organiser's event, organiser's attendee relationship. WoCo transmits and does not persist plaintext — see §3.2. |
| Organiser's own account data (wallet address, Stripe account link, sub-ENS name, sites) | **Controller** | WoCo determines purposes: operating the platform, billing, abuse prevention. |
| Marketing suppression list (`marketing-suppression.json`) | **Controller** (independent) | WoCo determines it must exist and enforces it *against* organisers. This is deliberate: it is the guarantee that an unsubscribe survives an organiser re-uploading a CSV. |
| Server logs, rate-limit counters, IP addresses | **Controller** | Security and abuse prevention, WoCo's own legitimate interest. |
| Likes / social graph (`likes-index.json` + on-chain EAS) | **Controller** | WoCo's platform feature; attestation is public on Arbitrum. |
| Card payment data | **Neither** — never touches WoCo | Direct charges on the organiser's Stripe account; card data goes buyer → Stripe. See §5.1. |

**Consequence:** WoCo needs a Privacy Policy (controller-facing), *and* a DPA offered to organisers
(processor-facing). Both. One does not substitute for the other.

### How the incumbents split it

| Platform | Posture |
|---|---|
| **Eventbrite** | Organiser is controller for attendee data, Eventbrite is processor; Eventbrite is controller for organiser accounts and platform analytics. Explicit dual role. |
| **Fatsoma** | Promoter is controller (expressly so for imported lists), Fatsoma is processor for those; "may act as either… depending on the circumstances". Also runs an attendee-first line: *"an attendee's privacy and right to not be spammed will always take priority over an organiser's promotions."* |
| **Skiddle** | **Different model** — Skiddle Ltd is the controller. Buyer data reaches the promoter only on opt-in, and remains "jointly owned by Skiddle Ltd at all times". |

**WoCo follows the Eventbrite/Fatsoma model, not Skiddle's.** Skiddle's posture requires the
platform to read and own the data, which we architecturally cannot do and do not want to.

Our position is *stronger* than all three: they assert a processor role contractually while retaining
technical ability to read everything. We cannot read it (§4). That is a real differentiator and it
should be stated plainly — but only for order-form data, never as a blanket claim.

---

## 2. Collection surfaces — all four

Personal data enters WoCo through **four** distinct front ends. Each needs its own point-of-collection
notice; a policy link in the main app does not cover the other three.

| # | Surface | Code | Collects | Notice status (2026-07-26) |
|---|---|---|---|---|
| 1 | Main app checkout | `apps/web/src/lib/attendee/events/claim/OrderForm.svelte` | email, order-form fields | Partial — one line, "Your info is encrypted", only shown when an order form exists; no policy link, no consent control |
| 2 | Embed widget on organiser's own domain | `packages/embed/src/components/woco-tickets.ts` | email | **None** |
| 3 | Organiser site deployed via WoCo | `apps/web/src/MultiSiteApp.svelte`, `contactForm` section (`packages/shared/src/site/types.ts:192`) | name, email, message | **None**, and the generated site has no privacy policy page at all |
| 4 | Direct event page link | routes into surface 1 | as surface 1 | as surface 1 |

Surface 3 is the sharpest risk: WoCo generates a website that collects personal data and ships it
with no privacy notice, on the organiser's own domain. The organiser is the controller for that
data and is very unlikely to realise they have an obligation.

---

## 3. What WoCo's server actually holds

### 3.1 Persisted stores (`.data/*.json`, on the VM)

Enumerated from source, not assumed:

| File | Personal data? | Content |
|---|---|---|
| `marketing-suppression.json` | **Yes** (pseudonymous) | HMAC-SHA256 email hashes + timestamp + source. Never plaintext — `suppression-store.ts` |
| `marketing-lists.json` | **Yes** (pseudonymous) | `emailHashes: string[]` only — `list-store.ts:17` |
| `marketing-domains.json`, `marketing-send-log.json` | Indirect | Organiser sending domains; send counts for rate caps |
| `stripe-accounts.json` | **Yes** | Organiser wallet address ↔ Stripe account id |
| `stripe-payout-ledger.json` | **Yes** | Organiser wallet address + Stripe account/session/PaymentIntent ids, event id, sale and net amounts, release dates. Financial record of the organiser, not the buyer — no attendee identifier. Retained as accounting evidence (§5.2, `payout-ledger.ts`) |
| `attendee-gate-bindings.json` | **Yes** (pseudonymous) | Ticket ↔ attendee binding |
| `likes-index.json` | **Yes** | Wallet address ↔ liked subject. Cache of public on-chain attestations |
| `sub-ens-owners.json` | **Yes** | Wallet address ↔ ENS label |
| `reservations.json` | **Yes** (pseudonymous) | `X-Client-Key` browser identifier, IP-derived counters, ~10min TTL |
| `referrals.json`, `badges-index.json` | **Yes** | Wallet addresses |
| `storage-ledger.json` | Indirect | Bytes uploaded per owner address |
| `revoked-sessions.json`, `consumed-*.json` | Indirect | Session nonces, tx hashes, Stripe session ids, Resend event ids — replay prevention |
| `event-listing-state.json`, `etherna-batches.json`, `onchain-events.json`, `pending-registrations.json`, `domains.json`, `manifest.json`, `shop-*.json` | Mostly not | Operational state; shop stores contain wallet addresses |

**Notably absent: any store of plaintext email addresses.** Verified by inspection of every store above.

### 3.2 Transient (in memory, not persisted)

- **Plaintext attendee email.** Arrives in the claim request body or from Stripe, is used to (a) send
  the ticket via Resend and (b) compute `hashEmail()`. Not written to disk in plaintext.
  `hashEmail()` = HMAC-SHA256 keyed on `EMAIL_HASH_SECRET` — `claim-service.ts:126`.
- **Plaintext marketing emails** transit `/api/marketing/import|check|broadcast` bodies because the
  client cannot compute a server-secret HMAC. Hashed and discarded.

### 3.3 IP addresses

Read for rate limiting and abuse prevention in `reservations.ts`, `campaign.ts`, `likes.ts`,
`events.ts`, `claims.ts`, `agent.ts`, `shops.ts` (all via a local `clientIp()` helper reading
`x-forwarded-for` / `cf-connecting-ip`). Held in in-memory counters, not persisted to `.data/`.
Also present in Cloudflare and Docker/host logs — **retention there is currently undefined and needs
a stated policy** (see §8).

---

## 4. Client-side encryption — what we can and cannot claim

**Verified claim:** WoCo's server can encrypt order data but has no code path to decrypt it.

- Sealing and opening live in `packages/shared/src/crypto/ecies.ts` (X25519 ECDH + AES-256-GCM):
  `seal`, `open`, `sealJson`, `openJson`.
- `apps/server` imports **`sealJson` only** (`routes/stripe.ts:23`). It never imports `open` or
  `openJson`. Grep-verified.
- The only callers of `openJson` are in the organiser's browser:
  `Dashboard.svelte:380,398` (orders) and `AudienceScreen.svelte:74` (contact list).
- The decryption key is derived from the organiser's POD seed, itself derived client-side from a
  wallet signature (`apps/web/src/lib/auth/pod-identity.ts`). The seed never leaves the browser.

**Precise wording that is true:** *"Order-form answers are encrypted in your browser to a key only
the event organiser holds. WoCo's servers store the encrypted result and have no ability to read it."*

**Two carve-outs that must not be glossed:**

1. **Stripe fallback path.** `routes/stripe.ts:928` — when no client-sealed order was pre-uploaded,
   the server seals a minimal record `{seriesId, claimerEmail, claimerAddress}` itself. The server
   therefore momentarily holds that email in memory (it came from Stripe) and performs the encryption.
   It still cannot re-open the result. Do **not** write "all data is encrypted before it reaches our
   servers" — it is not true on this path.
2. **Email delivery.** The attendee's email address is necessarily in plaintext to send the ticket.
   It is not part of the sealed blob's protection.

---

## 5. Third parties (sub-processors) — actually called, not aspirational

| Party | Purpose | Personal data shared | Location |
|---|---|---|---|
| **Stripe** | Card payments, organiser onboarding/KYC | Buyer email + card data (direct to Stripe, never via WoCo), organiser identity documents | US / IE |
| **Resend** | Transactional ticket email + marketing sends | Recipient email, name, message content | US |
| **Cloudflare** | CDN / tunnel for `events-api.woco-net.com` and `gateway.woco-net.com` | IP address, request metadata | Global |
| **Hetzner** | VM hosting (server + bee node) | Everything in §3 at rest | Germany (EU) |
| **Swarm network** | Decentralised storage | See §6 | **Global, uncontrolled** |
| **Etherna** | Alternative Swarm gateway/batch routing | As Swarm | IT / EU |
| **Photon (Komoot)** | Address geocoding at event creation | Organiser IP + typed venue address | DE |
| **Web3Auth** | Social/email login → wallet | Email, OAuth identifiers | US |
| **ZeroDev** | Account-abstraction bundler/paymaster for passkey wallets | Wallet address, operation data | US |
| **Arbitrum / EAS** | On-chain likes, event registration | Wallet address, attestation subject — **public, permanent** | Global |
| **exchangerate-api.com**, **CoinGecko** | FX and ETH pricing | None (no user data) | US |

Crypto payment rails are **off** at launch (`FEATURES.cryptoPaymentsAllowed`), so on-chain payment
processing is not currently live — but EAS likes and event registration on Arbitrum **are**.

### 5.1 Stripe charge model — CORRECTED

`apps/server/src/routes/stripe.ts:624` creates the Checkout Session with
`{ stripeAccount: organiserRecord.stripeAccountId }`, with `application_fee_amount` set and
**no `transfer_data`**. That is a Stripe **direct charge**, not a destination charge.

Consequences:
- The **organiser is the merchant of record**. Their business name appears at checkout and on the
  buyer's card statement.
- The **organiser bears chargeback and dispute liability**, not WoCo.
- WoCo is a **disclosed agent / platform intermediary** taking a 1.5% application fee.
- Card data never touches WoCo infrastructure.

> ⚠️ **`CLAUDE.md` and the header comment at `stripe.ts:5` both still say "destination charges".
> They are stale and must be corrected.** `stripe.ts:662` also refers to "legacy destination-charge
> sessions" — any orders created under that model had WoCo as merchant of record and carry
> different liability. Confirm whether any exist in production before relying on the agent model
> retrospectively.

### 5.2 Payout timing — a control, not a custody arrangement

Connected accounts are created on a **manual payout schedule** and each event's takings are
released after the event by a server-side job. Mechanism, constants and Stripe's own limits:
`docs/PAYOUTS.md`.

What matters for the legal documents:

- **WoCo never holds organiser funds.** They settle into the organiser's own Stripe balance. We
  control the timing of release and nothing else. Stripe is explicit that this is not escrow —
  *"Escrow has a precise legal definition, and Stripe doesn't provide escrow services or support
  escrow accounts."* No document may describe it as escrow, a client account, or funds we hold.
- **The hold cannot be promised unconditionally.** Stripe requires payout within 90 days of the
  charge for UK businesses (10 days Thailand, 2 years US), measured **per sale, not per event**, so
  tickets sold more than ~90 days ahead are released to the organiser before their event.
- **A manual schedule is not a lock.** Stripe's platform-controls documentation states connected
  accounts can still initiate their own payouts; blocking that needs a support request we have not
  yet been granted. Until then no attendee-facing statement may imply funds cannot move.

`TERMS_OF_SERVICE.md` §4 and `ORGANISER_TERMS.md` §6 are written to these three limits. If the
Stripe configuration changes — in particular a move to Managed Risk, which shifts negative-balance
liability from WoCo to Stripe — both sections and §5.1's liability statement need re-reading.

> ⚠️ **Liability caveat that survives all of the above.** Under our current configuration
> (`controller.losses.payments = "application"`, the Express default) **WoCo absorbs unrecoverable
> negative balances** on connected accounts. Delayed payouts reduce that exposure for sales close to
> the event and do nothing for sales made long before it.

---

## 6. Swarm — the hard problem

### What goes onto the public network

Written via `writeFeedPage` / `uploadToBytes`, stamped with a postage batch, replicated to
independent nodes worldwide:

| Item | Form | Personal data? |
|---|---|---|
| `ClaimerEntry.claimerAddress` | lowercase wallet address, **or** `email:{HMAC hash}` | **Yes** — pseudonymous. `packages/shared/src/event/types.ts:582` |
| `ClaimerEntry.orderRef` | Swarm ref → ECIES ciphertext of order answers | **Yes**, encrypted |
| `ClaimerEntry.secondaryEmailHash` | HMAC hash | **Yes** — pseudonymous |
| Ticket editions / claims feeds | edition number, timestamps, refs | Indirect |
| Profile feeds | display name, avatar, bio — organiser-published | **Yes**, and intentionally public |
| Marketing contact list blob | ECIES ciphertext, sealed to organiser | **Yes**, encrypted |

**Pseudonymised ≠ anonymous.** HMAC email hashes and wallet addresses are personal data under UK
GDPR because WoCo holds the key / can re-link them. The policy must treat them as personal data.

### Erasure — the mechanism we actually have

Swarm chunks are **immutable and cannot be individually deleted**. Two mechanisms combine to give a
genuine, defensible erasure story:

1. **Crypto-erasure (immediate).** Destroy or rotate the decryption key and the ciphertext becomes
   permanently unreadable. Effective from the moment of the request. This is the ICO-recognised
   approach where deletion of the ciphertext is not technically possible.
2. **Postage-batch expiry (within the retention window).** Swarm chunks persist only while a postage
   batch pays for them. Stop re-stamping a chunk and nodes garbage-collect it. The hash manifest
   already built for batch migration is the enumeration mechanism: migrate the hashes to keep, omit
   the hashes to erase, let the old batch die.

**What we may honestly claim:** we cease to store the data, we render it permanently unreadable
immediately, and we stop paying for its persistence so it is garbage-collected from the network
within the stated window.

**What we must NOT claim:** that the data is provably destroyed everywhere. Swarm is a public
network; a third party may have retrieved, cached or pinned a chunk before erasure. Garbage
collection is best-effort and not verifiable by us. This limitation must be disclosed *at the point
of collection*, not buried.

### International transfers

Swarm nodes are worldwide with no controllable location. This is a restricted transfer under UK GDPR
Chapter V with **no adequacy decision and no possibility of Standard Contractual Clauses** — there is
no counterparty to contract with. The mitigating argument is that all sensitive payload is encrypted
client-side to a key held only in the EU/UK-based organiser's browser, so what leaves the jurisdiction
is ciphertext plus pseudonymous identifiers. **This position needs solicitor sign-off — it is the
single most novel legal question in the platform.**

---

## 7. Retention — proposal requiring a decision

Nothing in the code currently expires attendee data. A stated retention policy is mandatory
(Art. 13(2)(a)) and cannot be "indefinite".

### Recommended: separate postage batch for attendee data

Attendee personal data must sit on a **different batch** from frontend assets, site content and
profiles. Reasons:

1. **Different retention needs.** App bundles and site content should be long-lived. Attendee data
   must be expirable. One batch cannot do both.
2. **Blast radius.** The platform batch already stamps recovery data, tickets, profiles and site
   pointers (`project_woco_batch_blast_radius`). Putting a short TTL on that is catastrophic — a
   missed top-up destroys the platform, not just old orders. There is already precedent: an expired
   batch killed `forkmate.co.uk`'s feed manifest.
3. **Legal.** "We can delete attendee data on request" is only true if attendee data sits on
   something that can be allowed to expire independently.

### On the 14-day TTL idea

A 14-day TTL with continuous top-ups gives a ≤14-day erasure window — comfortably inside 30 days —
but it is **operationally dangerous**. One failed top-up and every live ticket dies. Recommend:

- **TTL floor of ~60 days** on the attendee batch, re-stamped on a rolling basis. Erasure is driven
  by **omitting a hash from the migration manifest**, not by the batch TTL being short. The TTL is
  the safety margin; the manifest is the delete mechanism.
- Retention clock tied to **event date**, not claim date. A ticket must survive until the event plus
  a dispute window. Proposal: **event date + 90 days**, then the hash drops out of the manifest.
- Erasure on request: key destroyed immediately (access ends same-day), hash omitted from the next
  migration, chunk garbage-collected **within 30 days**.

### Stated erasure window: 90 days (owner decision, 2026-07-26)

UK GDPR Art. 12(3) requires a *response* without undue delay and within one month; it does not
require the technical erasure to complete in that window, provided the response explains the
timeline. **We state 90 days**, matching Eventbrite. Rationale: a shorter public commitment buys no
commercial advantage and removes operational headroom on a batch-migration mechanism that has
already failed once in testing. Access ends immediately via crypto-erasure regardless, which is the
part a data subject actually feels.

Publishing 90 does not stop the practical window being shorter — it usually will be.

### Tickets are the holder's own record — a separate retention class

Attendee data splits into two things that must not share a retention rule:

| | Organiser's attendee record | Holder's ticket / POD |
|---|---|---|
| What | Order-form answers, contact details, purchase history | The signed ticket itself — proof of attendance |
| Whose purpose | The organiser's | **The holder's own** |
| Retention | Event date + 90 days, then dropped from the manifest | **Indefinite by default** — it is the holder's digital record |
| Erasure | On request, or automatically at the retention limit | Only on the holder's own request |

Storage limitation (Art. 5(1)(e)) constrains a controller keeping data for *its* purposes. A ticket
retained for the holder's benefit, at the holder's choice, is a different case — the same reason a
bank does not delete your statements on a storage-limitation theory. Indefinite retention is
defensible here **provided** it is disclosed and the holder can still erase on request.

This also resolves cleanly once per-user postage batches land: the holder's tickets move onto the
holder's own batch, and they control renewal directly. At that point WoCo is not the retainer at
all. Until then they sit on the platform batch and WoCo must honour erasure on request.

### Retention floor — cannot be deleted on request

Transaction records must be kept **6 years** (Companies Act 2006 s.388; HMRC VAT record-keeping).
This is an Art. 17(3)(b) exemption. Those records live in Stripe, which is correct — they are the
organiser's and Stripe's obligation, not something WoCo needs to hold separately.

---

## 8. Open items before launch

| # | Item | Owner |
|---|---|---|
| 1 | Correct `CLAUDE.md` + `stripe.ts:5` — charges are **direct**, not destination | Claude |
| 2 | Confirm whether legacy destination-charge orders exist in production | user |
| 3 | Define + implement log retention for Cloudflare and host logs (currently undefined) | user |
| 4 | Decide + implement the separate attendee postage batch and manifest-driven erasure | Fable |
| 5 | Solicitor sign-off on the Swarm international-transfer position (§6) | user |
| 6 | ICO registration (data protection fee) before processing begins | user |
| 7 | Point-of-collection notices on all four surfaces (§2) | Claude |
| 8 | Generated organiser sites need a privacy policy page | Claude |
