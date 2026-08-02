# Data Inventory — UK GDPR Article 30 Record of Processing Activities

**Status:** verified against source, 2026-07-26; citations re-verified and fee model corrected
2026-08-01. **Not** a draft from memory — every claim below cites the file that makes it true.
Re-verify before each material release.

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
| 1 | Main app checkout | `apps/web/src/lib/attendee/events/claim/OrderForm.svelte` | email, order-form fields | **Compliant** (since `8ed69ec`) — the `consent-block` above the action buttons carries `TRANSACTIONAL_EMAIL_NOTICE`, an unticked `MARKETING_CONSENT_NOTICE` opt-in, `CHECKOUT_PRIVACY_SUMMARY` and a Privacy Policy link. Wording is shared with the server via `packages/shared/src/legal/consent.ts` so the stored Art. 7(1) evidence cannot drift from what was shown |
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
| `marketing-consent.json` | **Yes** (pseudonymous) | Art. 7(1) evidence: email hash → `{ts, source, eventId, notice}`, where `notice` is the VERBATIM wording shown at collection. No plaintext — `consent-store.ts`. Losing it loses the lawful basis for every opt-in it records |
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
| `email-failures.json` | **Yes — plaintext, transactional only** | Ledger of email the platform failed to deliver — either after every retry, or because the provider accepted it and then hard-bounced it (`routes/ses-webhook.ts`). `transactional` entries store the buyer's plaintext address: it is the only copy on disk (the claimers feed stores `emailHash`) and exists solely to deliver the ticket already paid for — Art. 6(1)(b). `marketing` entries store the HMAC hash only. Mode 0600, 90-day retention. A 1,000-entry cap bounds the file, but UNRESOLVED transactional entries are exempt from it and bounded by retention alone — a size cap that discarded evidence of a paid-but-undelivered ticket would defeat the store's purpose. Disclosed under Art. 15 and redacted under Art. 17 by the §6 procedure. The stored provider diagnostic is scrubbed of email-shaped text before it is written or logged, so the address exists in exactly one field per entry — the one erasure knows how to remove — rather than in a second, unreachable copy inside the error string — `failure-ledger.ts` |
| `broadcast-jobs/{jobId}.json` | **Yes** (pseudonymous) | One file per background broadcast. HMAC `emailHash`es of everyone it delivered to, plus counters, subject and the organiser's own message body. **No plaintext addresses, ever.** Purpose: send-once accounting — it is what lets a broadcast killed by a restart be resumed without mailing anyone twice. Mode 0600. Retention **7 days** (the resume window), and at most 20 records per organiser. Disclosed under Art. 15 (`broadcastsContaining`, surfaced by the §6 procedure). **Deliberately NOT erased under Art. 17**: removing a hash would make a resumed broadcast mail the person who asked to be forgotten. Erasure is effective by the suppression mark instead, which the send path re-checks per recipient — so a request stops a *live* job immediately — and the record itself expires in 7 days. `broadcast-jobs.ts` |
| `broadcast-chunks/*.bin` | **Yes — plaintext, encrypted at rest** | The recipients of a broadcast that has not finished sending. Contact lists are ECIES-sealed to the organiser client-side, so the server cannot enumerate one; the client posting plaintext addresses is the only way a bulk send can happen at all, and a background job must hold them while it drains. **AES-256-GCM under a key generated at process start and never written to disk** — a backup, VM snapshot or disk image that captures these files captures ciphertext for which no key exists anywhere, including here. A restart therefore destroys them permanently, by design. Each chunk is deleted as it drains, not at job completion; a hard TTL (2× expected drain time, floored at 15 min, capped at 4 h) destroys the payload whether or not the job finished, and an abandoned half-uploaded job is destroyed after 15 minutes idle. Mode 0600. Basis: processor acting on the organiser's documented instruction — same data, same purpose as the former in-request handling, bounded in time (§6 of `docs/SES_MIGRATION_HANDOVER.md`). Art. 15/17: individual records inside a live chunk are not separately addressable; erasure takes effect through the suppression re-check at send time. `broadcast-jobs.ts` |

**Plaintext email addresses on disk — the complete list, verified by inspection:**

1. `email-failures.json` — the recipient of an undelivered *transactional* email, until remediated
   or 90 days, whichever is sooner. Readable at rest.
2. `broadcast-chunks/*.bin` — the recipients of an in-flight broadcast, **encrypted under a
   process-memory key**, deleted per chunk as it drains and destroyed by TTL regardless. Not
   readable at rest, and not recoverable after a restart.

There are no others.

**What changed, and why it is not the thing §2 of `PRICING_AND_EMAIL.md` rejected.** That section
refused Resend Broadcasts for "converting transient exposure into a durable **third-party** copy" of
the contact list. Item 2 is a **first-party** copy, held by the processor the organiser already
instructed, for the same purpose, for minutes rather than indefinitely, encrypted under a key that
does not survive the process. The distinction is the one the objection actually turned on. It is
recorded here because it is a real change to what the platform holds, and an inventory that still
claimed "no plaintext store but one" would be false on merge.

### 3.2 Transient (in memory, not persisted)

- **Plaintext attendee email.** Arrives in the claim request body or from Stripe, is used to (a) send
  the ticket via the active ESP and (b) compute `hashEmail()`. Not written to disk in plaintext,
  **except** when every delivery attempt fails — see `email-failures.json` (§3.1).
  `hashEmail()` = HMAC-SHA256 keyed on `EMAIL_HASH_SECRET` — `claim-service.ts:126`.
- **Plaintext marketing emails** transit `/api/marketing/import|check` bodies because the client
  cannot compute a server-secret HMAC. Hashed and discarded.
- **Broadcast recipients are NO LONGER transient.** They arrive at
  `/api/broadcasts/jobs/:id/chunk` and are held — encrypted — until the send drains. See
  `broadcast-chunks/*.bin` in §3.1. This is the one place the "hashed-and-discarded" description
  above stopped being true, and it is stated here rather than left to be inferred.

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
- `apps/server` imports **`sealJson` only** (`routes/stripe.ts:30`). It never imports `open` or
  `openJson`. Grep-verified.
- The only callers of the ECIES open functions are in the organiser's browser:
  `Dashboard.svelte:380,398` (orders, `openJson`), `AudienceScreen.svelte:95` (contact list,
  `openJsonAuto`) and `AttendeeImport.svelte:68` (imported attendee orders, `openJson`).
- The decryption key is derived from the organiser's POD seed, itself derived client-side from a
  wallet signature (`apps/web/src/lib/auth/pod-identity.ts`). The seed never leaves the browser.

**Precise wording that is true:** *"Order-form answers are encrypted in your browser to a key only
the event organiser holds. WoCo's servers store the encrypted result and have no ability to read it."*

**Two carve-outs that must not be glossed:**

1. **Stripe fallback path.** `routes/stripe.ts` (search `Fallback minimal seal`) — when no
   client-sealed order was pre-uploaded, the server seals a minimal record
   `{seriesId, claimerEmail, claimerAddress}` itself. The server therefore momentarily holds that
   email in memory (it came from Stripe) and performs the encryption. It still cannot re-open the
   result. Do **not** write "all data is encrypted before it reaches our servers" — it is not true
   on this path.
2. **Email delivery.** The attendee's email address is necessarily in plaintext to send the ticket.
   It is not part of the sealed blob's protection.
3. **Stripe holds the buyer's email regardless.** It is passed as `customer_email` (for the
   checkout prefill) and stamped into session metadata so the webhook can identify the buyer. That
   copy lives in Stripe under their retention, not ours, and no amount of client-side sealing
   changes it. Listed here because "encrypted to the organiser" is otherwise read as "nobody else
   has it".

**On the key:** the organiser's POD identity is **ed25519**; sealing uses the **X25519** keypair
derived from that same seed (`deriveEncryptionKeypairFromPodSeed`). ECIES is X25519 ECDH +
HKDF-SHA256 + AES-256-GCM. Saying "encrypted with the organiser's ed25519 key" is loose — the
signing key and the encryption key are different keys from one seed.

---

## 5. Third parties (sub-processors) — actually called, not aspirational

| Party | Purpose | Personal data shared | Location |
|---|---|---|---|
| **Stripe** | Card payments, organiser onboarding/KYC | Buyer email + card data (direct to Stripe, never via WoCo), organiser identity documents | US / IE |
| **Amazon SES (AWS)** | Transactional ticket email + marketing sends — the LIVE provider since 2026-07-31 | Recipient email, name, message content, and per-message tags (below) | EU (eu-west-2) |
| **Resend** | Same, but held only as the rollback lever (`EMAIL_PROVIDER=resend`); scheduled for deletion 2026-10-01 | Recipient email, name, message content | US |
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

**Per-message tags sent to SES.** Every outbound message carries a small set of
name/value tags (`lib/email/message-tags.ts`), which SES stores with the send and
echoes back on its delivery events. They are:

| Tag | Value | Why it leaves our systems |
|---|---|---|
| `woco_kind` | `transactional` or `marketing` | Tells an async bounce apart from a marketing one. Without it the ledger cannot honour the plaintext split in §3.1 and would have to guess |
| `woco_ctx_stripeSessionId` | Stripe Checkout Session id | Ties a bounce that arrives minutes after acceptance back to the order that paid. It is what makes an undelivered paid ticket findable |
| `woco_ctx_eventId` | Event UUID | Same |
| `woco_ctx_siteId`, `woco_ctx_organiser` | Site id / organiser wallet address | Same, for site and marketing sends |

These are pseudonymous identifiers of a natural person (the buyer's order, the
organiser's wallet) that previously stayed in our own ledger. No new controller or
processor is involved — SES already handles the recipient's address and the full
message body, which is strictly more — but it is a real change to what leaves the
platform, so it is recorded rather than assumed harmless. The builder **refuses** to
emit any value containing an `@` or shaped like an email hash, so no recipient
identifier can reach a tag; the ceiling is ten tags per message. Basis: Art. 6(1)(f)
— establishing that a paid-for ticket was not delivered.

### 5.1 Stripe charge model — CORRECTED

`apps/server/src/routes/stripe.ts:680` creates the Checkout Session with
`{ stripeAccount: organiserRecord.stripeAccountId }`, with `application_fee_amount` set and
**no `transfer_data`**. That is a Stripe **direct charge**, not a destination charge.

Consequences:
- The **organiser is the merchant of record**. Their business name appears at checkout and on the
  buyer's card statement.
- The **organiser bears chargeback and dispute liability**, not WoCo.
- WoCo is a **disclosed agent / platform intermediary**. Fee model (RESOLVED 2026-08-01,
  `lib/stripe/checkout-fees.ts` + `checkout-fees.test.ts`): the organiser chooses per series
  whether a booking fee (`buyerFeePercent`, default 10%, floor 4.5%) is added to the buyer's total
  or absorbed; `application_fee_amount` = **1.5% of the ticket subtotal** (`PLATFORM_FEE_BP`);
  Stripe's processing fee is charged to the connected account (`fees.payer = "account"`,
  `account-params.ts:40`). Confirmed against Stripe's direct-charge docs: connected account nets
  charge − processing fee − application fee. `ORGANISER_TERMS.md` §6 carries the worked example.
- Card data never touches WoCo infrastructure.

> ⚠️ **Two dated caveats.** (1) Between 2026-04-26 (`26394b8`) and 2026-08-01 the card path
> charged a flat 10% buyer fee regardless of the organiser's setting, with
> `application_fee = min(estimated Stripe cost, buyer fee)` — sales in that window followed those
> figures, not §6. (2) `stripe.ts:783` handles "legacy destination-charge sessions" — any orders
> created under that model had WoCo as merchant of record and carry different liability. Confirm
> whether any exist in production before relying on the agent model retrospectively.

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
- **On a manual schedule, only the platform can move funds.** Stripe confirmed in writing
  (2026-07-29, `PAYOUTS.md` §3.2) that the Express Dashboard cannot self-initiate payouts and
  schedule editing is a platform capability we have not enabled. The earlier "not a lock" caveat
  here is retired.

`TERMS_OF_SERVICE.md` §4 and `ORGANISER_TERMS.md` §6 are written to these limits.

> **Liability under Managed Risk (issue #90).** Accounts are created with controller properties
> and `controller.losses.payments = "stripe"` (`PAYOUTS.md` §4): a refund or dispute debits the
> organiser's connected balance first, and the unrecoverable remainder falls on **Stripe**, not
> WoCo. Delayed payouts still matter — they keep attendees refundable for sales within ~90 days
> of the event; for earlier sales the liability configuration is the only control.

---

## 6. Swarm — the hard problem

### What goes onto the public network

Written via `writeFeedPage` / `uploadToBytes`, stamped with a postage batch, replicated to
independent nodes worldwide:

| Item | Form | Personal data? |
|---|---|---|
| `ClaimerEntry.claimerAddress` | `wallet:{HMAC hash}` or `email:{HMAC hash}` — never a raw address since 2026-08-01. Wallet hashes are keyed (HKDF-separated from the email key) AND salted per series, so the same wallet is unlinkable across events (`hashWalletAddress`, `claim-service.ts`). Legacy entries hold bare lowercase addresses until test-data cleanup | **Yes** — pseudonymous. `packages/shared/src/event/types.ts:598` |
| `ClaimedTicket.ownerAddressHash` (ticket blobs via claims feed) | per-series keyed hash; raw `ownerAddress` only on pre-2026-08-01 blobs | **Yes** — pseudonymous |
| Pending-claims feed `claimerKey` + `claimerSealed` | same hashed handle; raw address rides only AES-256-GCM-sealed to the server (approve path needs it) | **Yes** — sealed/pseudonymous |
| `ClaimerEntry.orderRef` | Swarm ref → ECIES ciphertext of order answers | **Yes**, encrypted |
| `ClaimerEntry.secondaryEmailHash` | HMAC hash | **Yes** — pseudonymous |
| Ticket editions / claims feeds | edition number, timestamps, refs | Indirect |
| Profile feeds | display name, avatar, bio — organiser-published | **Yes**, and intentionally public |
| Marketing contact list blob | ECIES ciphertext, sealed to organiser | **Yes**, encrypted |

**Pseudonymised ≠ anonymous.** HMAC email hashes and wallet addresses are personal data under UK
GDPR because WoCo holds the key / can re-link them. The policy must treat them as personal data.

### Erasure — the mechanism we actually have

Swarm chunks are **immutable and cannot be individually deleted**.

> ⚠️ **CORRECTED 2026-08-01 after Fable review.** This section previously claimed crypto-erasure —
> "destroy or rotate the decryption key" — as mechanism 1. **That capability does not exist.** The
> order-sealing key is HKDF-derived from a POD seed derived client-side from the organiser's wallet
> signature (`packages/shared/src/crypto/keys.ts:71-87`,
> `apps/web/src/lib/auth/pod-identity.ts:36-59`). WoCo never holds it, no key-destruction code
> exists, and it is deterministically re-derivable on any device — so it cannot be destroyed at all.
> There is also only ONE static X25519 key per organiser, so it could never erase a single
> attendee's record. Do not reintroduce this claim anywhere.

1. **Removal from the platform (immediate).** The record stops being served or used — organiser
   dashboard, feeds, ticket lookups. This is what a data subject actually experiences on the day.
   Note this is removal from *use*, not from the network.
2. **Postage-batch expiry.** Swarm chunks persist only while a postage batch pays for them. Stop
   re-stamping a chunk and nodes garbage-collect it — protocol-defined: chunks with expired stamps
   cannot be used as proof in the redistribution game, so storers stop being rewarded and drop them.
   The hash manifest built for batch migration is the enumeration mechanism: migrate the hashes to
   keep, omit the hashes to erase, let the old batch die.

> ⚠️ **Mechanism 2 is NOT operable per-subject today.** One platform batch stamps attendee data AND
> tickets, profiles, site pointers and recovery data — letting it lapse destroys the platform, not
> one person's record. The separate attendee batch (§7, open item 4) is a prerequisite. Until it is
> built, no published document may describe per-subject storage expiry in the present tense.

**What we may honestly claim:** we cease to store the data, we render it permanently unreadable
immediately, and we stop paying for its persistence so it is garbage-collected from the network
within the stated window.

**What we must NOT claim:** that the data is provably destroyed everywhere. Swarm is a public
network; a third party may have retrieved, cached or pinned a chunk before erasure. Garbage
collection is best-effort and not verifiable by us. This limitation must be disclosed *at the point
of collection*, not buried.

### Servicing a request — the actual procedure

`apps/server/scripts/data-subject-request.ts`, run on the VM with the production
`EMAIL_HASH_SECRET` and cwd set to the server working directory (the stores are keyed by HMAC hash,
so the wrong secret reports "no data" for someone who has plenty).

    npx tsx scripts/data-subject-request.ts --email <addr>                      # Art. 15 report
    npx tsx scripts/data-subject-request.ts --email <addr> --erase              # Art. 17, all organisers
    npx tsx scripts/data-subject-request.ts --email <addr> --erase --organiser 0x…   # scoped to one controller

It is a script, not an admin HTTP route: there is no admin identity in this system, and inventing an
admin bearer token guarding bulk erasure would be a worse attack surface than the problem it solves.
SSH is already the admin boundary.

**Suppression marks are never erased.** Under Art. 17(3)(b) the record of an objection is precisely
what lets the controller keep honouring it — deleting it would re-expose the person to the
organiser's next contact upload. The script therefore records a suppression mark *before* erasing
anything, so a crash between the two steps over-suppresses rather than under-protects.

**Three things the script cannot reach**, and which must be relayed to the subject:

1. The organiser's **sealed contact blob** on Swarm is encrypted to them; only they can rewrite it.
   They are the controller for their own list — forward the request. Removing the member from
   WoCo's list index makes them unsendable immediately (`/api/marketing/broadcast` rejects any
   recipient not in the index), and the suppression mark holds even if the organiser re-uploads.
2. **Ticket records on Swarm** — removal from the platform, plus batch expiry once the separate
   attendee batch exists. See the two warnings above.
3. **Stripe** holds its own payment records under its own retention obligations.

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
- Erasure on request: removed from the platform immediately (access ends same-day), hash omitted
  from the next migration, chunk garbage-collected **within 30 days**.

### Stated erasure window: 90 days (owner decision, 2026-07-26)

UK GDPR Art. 12(3) requires a *response* without undue delay and within one month; it does not
require the technical erasure to complete in that window, provided the response explains the
timeline. **We state 90 days**, matching Eventbrite. Rationale: a shorter public commitment buys no
commercial advantage and removes operational headroom on a batch-migration mechanism that has
already failed once in testing. Removal from the platform happens immediately regardless, which is
the part a data subject actually feels.

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
| 1 | ~~Correct `CLAUDE.md` + `stripe.ts:5` — charges are **direct**, not destination~~ **Done 2026-08-01** — both now say direct charges | Claude |
| 2 | Confirm whether legacy destination-charge orders exist in production | user |
| 3 | **Configure** log rotation to match the 30-day period now STATED in PRIVACY_POLICY §10. Stating a period does not create one: Docker's `json-file` driver rotates on nothing unless `max-size`/`max-file` are set in compose, and Cloudflare's retention depends on the plan — check it rather than assume. A policy claiming 30 days over infrastructure that keeps logs forever is worse than the placeholder was | user |
| 4 | Decide + implement the separate attendee postage batch and manifest-driven erasure | Fable |
| 5 | Solicitor sign-off on the Swarm international-transfer position (§6) | user |
| 6 | ICO registration (data protection fee) before processing begins | user |
| 7 | Point-of-collection notices on all four surfaces (§2) | Claude |
| 8 | Generated organiser sites need a privacy policy page | Claude |
| 9 | **Organiser privacy contact.** `privacy@woco-net.com` is WoCo's contact *as controller* and stays WoCo's — it is not an organiser-facing setting. But §3 tells the attendee their order-form rights are exercised against the ORGANISER, and today the only identification of that organiser is their display name at checkout. They need a reachable contact of their own. Deliberately not built yet: it wants a verified address, which is the same problem SES domain verification solves (PRICING_AND_EMAIL §6 forbids onboarding organiser domains on Resend). Slot it in as an organiser-profile field once SES lands — the point-of-collection notice and the generated-site policy page (item 8) both read it | Claude, after SES |
