# Ticketing

A ticket's whole life: how an organiser issues a series, how a buyer gets one, what makes it
genuine, and what happens at the door.

Stripe mechanics live in [PAYMENTS_INTEGRATION.md](./PAYMENTS_INTEGRATION.md); fee arithmetic
**only** in [PRICING_AND_EMAIL.md](./PRICING_AND_EMAIL.md) §7 / §15–§17; payout policy **only**
in [PAYOUTS.md](./PAYOUTS.md). This document is the lifecycle and the cryptography.

**Verified against `main` on 2026-09-08.**

---

## 1. The vocabulary

| Term | What it is |
|---|---|
| **Event** | An organiser's event. Content lives in a client-signed Swarm chunk; identity on chain is a `bytes32` event id from `registerEvent`. |
| **Series** | A ticket type within an event — supply, price, metadata, image. |
| **Edition** | One individual ticket: `woco.edition.v1`. 1-indexed, `1..totalSupply`. |
| **Manifest** | `woco.manifest.v2` — one signed object per series, committing to a Merkle root over every edition. |
| **Slot** | The on-chain record of one sold ticket: `slotOwner[eventId][edition-1]`. |
| **Burner** | A single-use keypair generated at fulfilment. Its address becomes the slot owner. |

The naming is deliberately narrower than it used to be: "edition" replaced "POD"/"ticket" as the
body noun, because **one shape now serves both** the ticket rail and standalone badge or
collectible issuance.

---

## 2. Issuance: one signature for a whole series

The single most counter-intuitive fact about WoCo tickets: **nothing signs an individual
ticket.**

```
for each edition 1..N:
    body_n  = { format: "woco.edition.v1", seriesId, edition: n, metadata, issuer }
    leaf_n  = keccak256( 0x00 || u32be(n) || dagCbor(body_n) )

tree        = OZ SimpleMerkleTree over the leaves, sortLeaves: false
                (leaves verbatim; internal nodes keccak256(sort(L, R)))
root        = tree.root

manifest    = { format: "woco.manifest.v2", totalSupply: N, issuer,
                metadataRoot: root, encoding: "cbor-v1", treeScheme: "oz-simple-v1" }
digest      = keccak256( dagCbor(manifest) )
signature   = personal_sign( "woco-manifest-v2\n0x" + hex(digest) )   ← ISSUING key
```

A ticket's authenticity therefore comes from **the manifest signature plus a Merkle membership
proof**, not from a per-ticket signature. Every constant above is pinned by golden vectors in
`packages/shared/test/edition/`; changing any of them is a format version bump.

Four details each defend against a specific attack or defect:

- **`sortLeaves: false`** keeps leaf index mapping 1:1 to `edition - 1`, so a proof's position is
  meaningful.
- **`u32be(edition)` inside the leaf** is the edition-swap / second-preimage defence: two
  editions with identical metadata still hash differently.
- **The `0x00` domain byte** separates leaves from OpenZeppelin's internal nodes.
- **`buildEditionTree` asserts `edition === index + 1` before anything is signed.** Defence in
  depth, before the signature rather than after.

`signManifestV2` **refuses** a key whose address is not `body.issuer`. A manifest signed by the
wrong key of a multi-key organiser verifies against nothing — and would be discovered at a door,
which is the worst possible place. Refuse at signing time.

`eventId` is deliberately **absent** from both body shapes. It never matched the on-chain event
id, could not join a manifest to its registration, and had zero production readers. The chain
binding is `manifestRef` alone.

### The verifier's contract

```ts
verifyManifestV2(value)                        // schema → digest → recover → compare issuer
verifyEditionInclusion(body, proof, root)      // recompute leaf → walk proof → check root
```

Both return `false` on any failure and never throw. Both **dispatch-refuse** the v1 formats:
schema validation runs first and a `woco.manifest.v1` or `woco.ticket.v2` object fails it whole,
before any cryptography runs. There is no compatibility branch — the v1 formats are deleted, and
pre-launch there is nothing to migrate.

And the rule that is easy to miss: **a valid signature does not prove this is the manifest the
organiser registered.** A trust-bearing path must *also* compare `manifestV2Digest(body)` against
the chain's `manifestRef`.

---

## 3. Sale and mint

Card is the only live rail (`cryptoPaymentsAllowed = false`, `freeEventsAllowed = false`).

```
 1. RESERVE   POST /api/events/:id/series/:sid/reserve
              An atomic hold. `available` is physical remaining; /reserve
              subtracts held seats when it allocates.

 2. CHECKOUT  Stripe Checkout — a DIRECT charge on the organiser's connected
              account. The server stamps eventId, seriesId and the VALIDATED
              on-chain event id into the session metadata. The organiser cannot
              write session metadata (dashboard type "none"), so that metadata
              is as trustworthy as the decision it records.

 3. WEBHOOK   Stripe → fulfilment (apps/server/src/lib/stripe/fulfilment.ts):
              a. seal the order data to the organiser's X25519 key, upload to
                 Swarm, keep the 32-byte ref
              b. one ephemeral BURNER keypair per ticket
              c. batchClaimFor(onChainEventId, burnerAddresses, orderRef)
                 as the platform sponsor, chunked
              d. each burner signs its own ticket message — then the key is
                 DISCARDED. It never touches disk or any store.
              e. email the ticket: a composite PNG plus a /t/… link
```

**Which on-chain event to mint against comes from server state only, never from the event feed.**
That used to be re-read from the feed at mint time — and for a client-signed event, that feed is
the *creator's* chunk. So every check performed at checkout held at charge time and not at mint:
re-signing the chunk in between re-pointed the mint, with the money already taken. The mint
target is now the id validated into the Stripe session at checkout, falling back to this server's
own registration record — and **if both exist and disagree, the sale is refunded rather than
minted against either.** The validated id is a registration the server no longer stands behind;
the record may have moved under an in-flight session and could drain the wrong event's supply.
Refund is the only outcome that does neither (`fulfilment.ts`, the #426 tripwire).

Two more properties of that path:

- **The event feed is fenced.** A Swarm hiccup while fulfilling degrades the ticket *email* — a
  title, a series name — not the sale. It used to degrade to "no v2 path" and refund.
- **Any failure after the charge triggers an automatic refund.** Refunds Stripe refuses to create
  land in `.data/pending-refunds.json` and raise a `/api/health` alarm, because the alternative
  is a buyer charged with no ticket and no alarm.

`registerEvent` is **not idempotent** — it derives the event id from a sponsor-nonce counter, not
from the manifest — so registering the same series twice creates two events. That is why
`register-once.ts` and `.data/onchain-events.json` exist, and why losing that file stops sales.

### Why a burner, and not the buyer's address

Because most buyers do not have one. A card buyer who never touches a wallet still needs an
on-chain ticket, so the platform mints to a fresh address whose private key exists just long
enough to sign one message.

The consequences are worth being explicit about. The **on-chain slot owner is the trust root**
— it is the thing a verifier compares against, and it is public. The burner key is not custody:
it signs once and is gone, so there is nothing to steal and nothing to lose. Transferability and
resale are therefore *not* a property of the burner; they belong to the attendee-gate binding
layer ([ATTENDEE_GATE_RESALE_PLAN.md](./ATTENDEE_GATE_RESALE_PLAN.md)).

---

## 4. What makes a ticket genuine

Every ticket reduces to one canonical message — **locked format**, in
`packages/shared/src/ticket/canonical.ts`:

```
woco-ticket-v1\n
{onChainEventId}\n     lowercase 0x-prefixed bytes32
{seriesId}\n           verbatim
{edition}\n            decimal, unpadded, 1-indexed (slot + 1)
```

Signed EIP-191, so a verifier must use `verifyMessage` / `recoverAddress` **with** the
personal-sign prefix — not raw keccak256. Verification is one comparison:

> `ecrecover(ticketSig, canonicalMessage) == slotOwner[onChainEventId][edition - 1]`

`GET /t/:eventId/:seriesId/:edition/:sig` renders the ticket page, and appending `.json` returns
a downloadable artifact carrying the QR payload, the signature and an explicit verdict:

- `valid` — recovered to the on-chain slot owner;
- `unverified` — the chain was unreachable. **Distinct from invalid**, deliberately: "couldn't
  ask" is not "no".
- an invalid signature is a 403 and never renders.

The download format keeps `claimed` and `original` as `null`. On-chain tickets have no
intermediate credential objects — the contract *is* the ledger — and the fields stay so the shape
is stable.

There was once a `woco-claimed-owner-v2` owner-binding attestation. It was **deleted**: an audit
found it was produced by nothing and verified by nothing, and an unverified signature field
sitting in a public blob invites someone to trust it later without noticing that nothing ever
checked it. Ownership that is actually enforced lives on chain and in the gate binding store.

---

## 5. At the door

The scanner is a standalone PWA (`dist-scanner/`, built from the same `apps/web` source) with no
auth stack, no external fonts and no Swarm reads. It is provisioned entirely by a **door-pass
URL** and works fully offline once provisioned.

```
Organiser (session-authed):
  POST /api/events/:id/door-pass       issue or rotate the event's door pass
  POST /api/events/:id/checkin-roster  store AES-GCM roster CIPHERTEXT — the key
                                       is never sent to the server
  GET  /api/events/:id/checkin-status  live counts for the dashboard

Scanner (X-Door-Pass header):
  GET  /api/checkin/:eventId/pack      offline verification pack
  POST /api/checkin/:eventId/sync      merge this device's check-ins, get all
```

The pack holds only public or derivable data — on-chain slot owners, claim-ledger hashes — plus
the roster ciphertext. The roster **key lives in the pass URL fragment**, so it never reaches the
server: a leaked pass token exposes no attendee plaintext.

Check-ins are **merged**, not overwritten, so several scanner devices can work the same door
offline and reconcile on sync.

---

## 6. Certificates and badges

The same issuance machinery serves awarded credentials: `woco.cert.v1` plus
`woco.cert-challenge.v1`.

The two rails disagree about exactly one thing — how many bodies the Merkle root covers. On the
ticket rail a body is an **edition**, one per claimable slot, and the contract sells each one. On
the certificate rail a certificate **names its holder**, so there is one template body and
`totalSupply` is a declared cap no chain enforces. Everything downstream of that disagreement is
identical, which is what guarantees the two rails cannot drift into signing bytes that differ
from the bytes a verifier checks.

The certificate rail keeps **two** signing prefixes, because two different keys sign two
different objects: the issuer signs the certificate, the holder signs the possession challenge
that answers for it. One shared prefix would let a certificate's bytes be replayed as a challenge
answer, or the reverse.

The holder side is still **ed25519** — see
[IDENTITY_AND_KEYS.md](./IDENTITY_AND_KEYS.md#4-what-changed-in-the-issuer-curve-migration-443).

**Scope note:** the certificate rail is built and merged but sits **outside launch scope**, and
its supervised end-to-end sequence has not been run against a real holder.

---

## 7. The attendee gate

Creating a profile, claiming a sub-ENS name or acting socially requires passing a gate. Either
condition passes (`apps/server/src/lib/gate/check.ts`):

1. a **ticket binding** exists — the parent proved rightful possession of a purchased ticket; or
2. the parent is an **organiser** — has a creator events directory. Brands claim names and
   publish profiles without buying tickets.

`ATTENDEE_GATE_DISABLED=1` is a rollout kill-switch; status is still reported so the UI can be
exercised with the gate off.

---

## 8. What has been removed — don't reintroduce it from older docs

| Gone | Why |
|---|---|
| **The v1 claim rail** | `POST /claim` allocated an edition by scanning a Swarm editions feed. The editions feed was retired first, so the route could not mint for anything created afterwards. Deleted; `WoCoEventV2` is the only ticket ledger. `claims.ts` now holds only `claim-status`. |
| **The organiser approval flow** | Routes, flags and UI all deleted with the v1 rail. Tracked for return on the v2 contract rail (#202). |
| **Any free-ticket path** | An accepted consequence of the above: there is no v2 mint path for a free ticket yet. `freeEventsAllowed = false`, so nothing live changes. |
| **`woco.manifest.v1` / `woco.ticket.v2` / `woco.pod-cert.v1`** | Deleted and dispatch-refused by every verifier. |

> **Which contract you are on is env-selected.** Production sets `WOCO_EVENT_CHAIN_ID=421614`
> and `WOCO_EVENT_VERSION_421614=v2`. Unset, the server defaults to chain `84532` (Base Sepolia)
> and version `v1` — a different contract entirely. Neither variable is in `.env.example`.

`WoCoTicketLedger` — a successor contract that stamps the **real organiser** as owner of record
rather than `msg.sender` — is written, reviewed and merged in the contracts repo, and is **not
deployed**. `DEPLOYED_LEDGER` is an empty map on purpose: setting
`WOCO_EVENT_VERSION_{chainId}=ledger` before it is deployed makes every caller throw
"No WoCoEvent contract deployed", which is the correct loud failure.
