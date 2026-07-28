# AWS SES Production Access — case record

Record of what we told AWS, so a later follow-up can be answered consistently.
Everything here must stay TRUE against the code; if a limit changes, change it here.

Identity: `woco-net.com`, Easy DKIM (2048-bit), region **eu-west-2**, custom MAIL FROM
`bounce.woco-net.com`, DMARC `p=none` with aggregate reporting.

> Note: `send.woco-net.com` (MX → `feedback-smtp.eu-west-1.amazonses.com`) is **Resend's**
> return-path domain, not ours — Resend runs on SES. Do not confuse the two subdomains.

---

## What AWS asked (2026-07-27)

> Tell us how often you send email, how you maintain your recipient lists, and how you
> manage bounces, complaints, and unsubscribe requests. It is also helpful to provide
> examples of the email you plan to send.

---

## The numbers, as actually enforced

Quote these, not round approximations — AWS re-reads the case on later increase requests.

| Control | Value | Where |
|---|---|---|
| Recipients per broadcast request | 1,000 | `MAX_BROADCAST_RECIPIENTS`, `routes/marketing.ts` |
| Broadcasts per hour, per organiser | 2 | `BROADCAST_RATE_LIMIT` |
| Rolling 24h ceiling, per organiser | `max(2,000, organiser's stored list size)` | `send-cap.ts` `effectiveDailyCap()` |
| Contacts per organiser list | 20,000 | `MARKETING_MAX_LIST_EMAILS` |

The 24h floor tracks list size deliberately: a cap below an organiser's own audience is not
a reputation guard, it is a product defect.

**Do not claim we serve 100k-contact organisers.** Lists cap at 20,000 and the storage shape
(one sealed blob re-uploaded per change, gzipped) does not stretch to 100k without paging.
Raise the cap in code first, then update this file, then tell AWS.

---

## The reply (as sent)

**What we send.** WoCo is an event ticketing platform. Two categories: (1) transactional
ticket confirmations sent to a buyer immediately after they purchase or claim a ticket,
containing their ticket as an image attachment and a unique signed link to their ticket
page; (2) marketing broadcasts sent by event organisers to their own opted-in audiences,
typically announcing an event or a ticket release.

**How often.** Transactional email is trigger-based, one per purchase — currently low volume
as we are pre-launch, expected under 1,000/month initially and growing with organiser
adoption.

Marketing is rate-limited in code per organiser: a maximum of 1,000 recipients per
broadcast, no more than 2 broadcasts per hour, and a rolling 24-hour ceiling of the greater
of 2,000 recipients or that organiser's own stored contact list size. Contact lists are
themselves capped at 20,000 addresses per organiser. The 24-hour ceiling tracks list size
deliberately — a limit below an organiser's own audience would make announcing an event
impossible without improving deliverability. Exceeding any limit returns an explicit HTTP
429 rather than silently trimming the send.

We expect to remain well within 50,000 emails per day across the platform during our first
year, with typical days far lower.

**How we maintain recipient lists.** Transactional recipients are addresses the buyer typed
at checkout for their own ticket; there is no list. Marketing lists are uploaded by the
organiser through an import wizard requiring an explicit consent warranty that the contacts
opted in with them. Where the source export carries a consent column, rows marked as an
explicit negative are excluded at import and reported back to the organiser. We never
purchase, scrape, or share lists between organisers. An address cannot be sent to unless it
is present in that organiser's stored list — the broadcast endpoint hash-checks every
recipient against it before sending. Contact lists are encrypted client-side to the
organiser's key; our server stores only HMAC hashes of addresses, not plaintext.

Separately, organisers can email the attendees of one of their own events. That endpoint
verifies every recipient is an actual ticket holder for that event, by hash, before sending.

**How we manage unsubscribes.** Every marketing message carries RFC 8058 `List-Unsubscribe`
and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers, a visible unsubscribe link,
the name of the organiser who sent it and why the recipient is receiving it, and our
registered postal address — all inserted unconditionally by a single send function that no
caller can bypass. That function refuses to send at all if it cannot construct a working
unsubscribe link or has no postal address configured, because sending non-compliant mail is
worse than not sending.

Unsubscribe links never expire, deliberately — an expired opt-out link produces a spam
complaint. Unsubscribing writes to a server-side suppression list keyed by HMAC of the
address, checked per recipient on every subsequent non-transactional send. Because
suppression lives server-side and is keyed by hash, re-uploading a CSV containing that
address cannot resurrect it. Recipients may also opt out of all marketing from every
organiser on the platform in one click. Transactional ticket emails carry no marketing
content and no unsubscribe link, as required.

**How we manage bounces and complaints.** Our ESP delivers bounce and complaint events to a
signature-verified webhook endpoint. Verification is unconditional — unsigned or
unverifiable events are rejected — because an unauthenticated bounce endpoint would let an
attacker suppress arbitrary recipients. Verified bounces and complaints are written to the
global tier of the suppression list, removing that address from all future sends across
every organiser on the platform, not just the one who triggered it. Events are de-duplicated
by ID so retries are processed exactly once.

**Who may send.** Marketing sending is gated on the organiser completing Stripe Connect
identity verification. An organiser who has not verified cannot broadcast at all. This is
our anti-abuse control: it ties every sender on our shared reputation to a
identity-verified, KYC'd business rather than an anonymous signup.

**Example content.** A ticket confirmation contains the event name, date and venue, the
buyer's ticket as an attached image with a QR code for entry, and a link to a signed ticket
page for door scanning. A marketing broadcast is an event announcement — artwork, event
title, date, venue, the organiser's own message and a single "Get tickets" link to the event
page — followed by our compliance footer. Both HTML and plain-text alternative parts are
sent. Screenshots of both are attached.

**Identity.** Sending domain `woco-net.com` is verified in eu-west-2 via Easy DKIM
(2048-bit), with a custom MAIL FROM subdomain `bounce.woco-net.com` and a published DMARC
record (`p=none` with aggregate reporting while we establish a baseline).

---

## Known gaps — fix before these become claims

- **No background job queue for broadcasts.** Sends run inline in the HTTP request, 5
  concurrent. A 1,000-recipient broadcast is a long request behind Cloudflare's 100s origin
  timeout, and reaching a full 20,000-contact list takes ~10 hours at 2 broadcasts/hour.
  A launch announcement cannot dribble out over 10 hours.
- **No ESP batch API use.** `sendEmail` posts one message per call. Resend's limit is
  10 req/s per team (`docs/PRICING_AND_EMAIL.md` §4); `SEND_CHUNK = 5` in flight at ~200ms
  each is ~25 req/s, so a large broadcast will hit 429s — which are counted as `failed`,
  not retried. Move to a batch endpoint and add backoff.
- **No retry on transient send failures.** A 429 or 5xx from the ESP is counted as `failed`
  and the recipient is simply not mailed.
