# Contact Management — attendees, marketing, and the one identity between them

Design note, 2026-07-27. Written after the CSV-import work (PR #78) raised the
question: how does a ticket buyer become a marketing contact without duplicating
people or breaking consent?

> **CORRECTED 2026-07-27, later the same day.** Two of the three findings below
> were acted on and one was WRONG. Read this box before the rest of the note.
>
> - The broadcast hole is **FIXED** — `/api/events/:id/broadcast` now requires
>   every recipient to hold a ticket (`lib/event/attendee-emails.ts`).
> - "There is no marketing opt-in at purchase" was **incorrect**. The field is
>   `marketingConsent`, not `marketingOptIn`; the original grep was for a name
>   that never existed. The opt-in control, the versioned wording
>   (`packages/shared/src/legal/consent.ts`) and the evidence store
>   (`.data/marketing-consent.json`) all shipped in #75. What was genuinely
>   broken is narrower and worse: `OrderForm` rendered the checkbox on the
>   Stripe path and the answer was **silently dropped** — no grant recorded, and
>   no refusal written to suppression either. Now wired through session metadata
>   and recorded in the webhook.
> - The audience UI now shows the three consent states and lets a contact be
>   edited (`ConsentLedger`, `ContactDetail`).
>
> Still open: the drain itself (step 3 below), the provenance-ranked merge rule,
> the single Art. 17 deletion path, and the `MARKETING_MAX_LIST_EMAILS` ceiling.

Compliance posture is unchanged: **organiser = data controller, WoCo = processor.**
Send-path guarantees live in `MARKETING_COMPLIANCE.md` — this note is about the
contact records those sends draw from.

---

## What exists today (verified in code, not assumed)

Two contact worlds that never touch:

**1. Attendees** — encrypted claim data on Swarm, per event. Every claim seals
`claimerEmail` to the organiser's X25519 key at claim time. The organiser's browser
decrypts them (`Dashboard.svelte`, `decryptedOrders`) and `getEmailRecipients()`
builds a recipient list client-side. `POST /api/events/:id/broadcast` then takes
that list **from the request body**. Scoped to one event, 5/hr x 500, deliberately
not Stripe-gated, does not consume the marketing daily cap.

**2. Marketing list** — the sealed blob (`AudienceScreen`, `MarketingListPayload`).
CSV import is currently the ONLY way in.

### Three findings

- ~~**There is no marketing opt-in at purchase.**~~ **WRONG — see the box at the
  top.** It exists under the name `marketingConsent` and has since #75. The real
  defect was that the Stripe path collected the answer and threw it away.
- ~~**`/api/events/:id/broadcast` does not verify recipients are attendees.**~~
  **FIXED.** Kept below because the reasoning is what justifies the two
  exemptions the endpoint still enjoys. It
  validates email *format* and organiser ownership, then sends. It never checks the
  addresses against the event's claims. `/api/marketing/broadcast` hash-checks every
  recipient against the stored list; this endpoint has no equivalent. So the
  "attendee-relationship mail" reasoning used to leave it Stripe-ungated does not
  actually hold — an organiser can post arbitrary addresses to it and reach them
  outside the marketing consent warranty entirely. Suppression still applies (it is
  enforced inside `sendMarketingBatch`), so unsubscribers stay protected, but the
  consent gate does not. **Fix this before wiring the two worlds together**, or the
  join inherits the hole.
- `OrderFieldType` already includes `checkbox`, so an organiser may ALREADY be
  collecting a "marketing opt-in" custom field. That data sits in sealed order data
  with no structured path anywhere and no record of the wording consented to.

---

## The model: one identity, several independent permissions

The instinct that email is the master key is right — it is already the de-facto key
everywhere (`hashEmail` HMAC, suppression, dedupe, `normaliseEmail` lowercasing).

The thing to get right is that **a contact is not one record with a consent flag.**
It is one identity carrying separate, independently-granted permissions:

| permission | basis | example mail |
|---|---|---|
| transactional | contract | your ticket, your receipt |
| event-relationship | legitimate interest | doors moved, event cancelled |
| marketing | consent | our next show is on sale |

Why this matters, and why "merge the records and keep a flag" is the wrong shape:

- Someone who bought a ticket and did **not** tick marketing is an attendee contact
  but not a marketing contact. A merge must never silently promote them.
- Someone who unsubscribed from marketing must **still** get "your event is
  cancelled". Suppression is scoped to non-transactional mail for exactly this
  reason; a single merged flag would either over-block or under-block.
- Consent is per-purpose and per-controller and must be *demonstrable*
  (GDPR Art 7(1)) — so it needs its own evidence record, not a boolean.

## Merging on re-import — the accuracy question

Art 5(1)(d) does want personal data kept up to date, so refreshing a stale name is
correct in principle. But blanket **"newest wins" is wrong**, for two reasons:

1. **Provenance differs in reliability.** A name typed by the attendee at checkout
   is first-party and high-trust. A name in a third-party CSV is unverified and may
   be stale, mis-keyed, or a different human on a shared household inbox.
   Newest-by-timestamp lets a bad CSV overwrite good self-reported data.
2. **Absence is not an update.** A later import that omits a field must not blank a
   field an earlier one filled.

Proposed rule — **provenance rank, then recency**:

```
self-reported at checkout  >  organiser edit  >  CSV import
```

Within a rank, newer wins. A non-empty value never loses to an empty one. Keep
`source` and `addedAt` per contact (both already exist) and add `updatedAt`. When a
higher-trust value replaces a lower-trust one, that is a silent improvement; when a
CSV would overwrite self-reported data, prefer the existing value.

Consent is **exempt from all of this** — it never merges by rule. A new grant is a
new evidence record; an existing refusal or unsubscribe is never overwritten by an
import claiming otherwise. Suppression already survives re-upload and must continue
to (`MARKETING_COMPLIANCE.md`).

## Where the opt-in should live

Architectural tension worth stating plainly: the marketing list is sealed to the
organiser's key **in their browser**. A checkbox ticked at checkout is processed
**server-side** (Stripe webhook). The server cannot write into the sealed blob — it
has no key, and giving it one would collapse the whole trust model.

Recommended: **the opt-in rides in the already-sealed claim data.** Claims are
already sealed to the organiser's X25519 key at claim time, and the Dashboard
already decrypts them. So:

1. ✅ **BUILT.** Checkout collects a structured marketing opt-in — unticked by
   default (pre-ticked boxes are not valid consent; CJEU *Planet49*), with the
   exact wording and a version tag captured alongside it.
2. ✅ **BUILT.** The buyer's email is already sealed into the claim payload, and
   the answer travels with the claim on every path.
3. ⬜ **STILL OPEN — the actual remaining work.** The Audience screen decrypts
   claims (same mechanism as `Dashboard`) and offers "N attendees opted in — add
   to your audience", deduped on lowercased email against the existing list.
   Note the shape this has to take: the consent store holds HASHES, so the
   server can never hand back an address. The organiser's browser decrypts the
   claim data it already has access to, and `/api/marketing/check` tells it
   which of those addresses carry a consent record (`consented`, already
   shipped). Nothing new needs to cross the trust boundary.
4. ✅ **BUILT.** The server records `hashEmail` + eventId + timestamp + the
   verbatim notice — no plaintext — as the demonstrability record
   (`consent-store.ts`). Same shape as the suppression store. Organiser holds
   the usable data; platform holds the proof.

This adds no new server-side plaintext, reuses the existing seal, and keeps the
client-first architecture intact.

## Open questions

- Is the audience per-organiser (current) or should attendee contacts stay
  event-scoped with marketing as the only cross-event pool? Current shape says the
  former; worth confirming before wiring.
- Erasure (Art 17) currently has to hit the sealed blob AND the claim data AND
  preserve the suppression hash. Needs a single deletion path before this grows.
- Does raising `MARKETING_MAX_LIST_EMAILS` above 20k make sense now that gzip put
  the storage ceiling near 175k? Browser memory, not storage, is the new limit.
