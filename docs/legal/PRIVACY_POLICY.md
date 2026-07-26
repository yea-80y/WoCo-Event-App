# Privacy Policy

**Last updated:** [DATE OF PUBLICATION]
**Version:** 1.0

> **⚠️ PRE-LAUNCH DRAFT — NOT YET IN FORCE.**
> Placeholders in `[SQUARE BRACKETS]` must be completed, and this document must be reviewed by a
> UK data protection solicitor, before publication. Every factual claim below is traceable to
> `docs/legal/DATA_INVENTORY.md`, which cites the source files. Do not add claims to this policy
> that the inventory does not support.

---

## 1. In short

WoCo is a ticketing and event platform built on decentralised infrastructure. That makes our privacy
position genuinely different from a conventional ticketing site, in two ways that matter to you:

- **We usually cannot read your data.** When you fill in an order form, your answers are encrypted
  in your browser to a key only the event organiser holds. Our servers store the encrypted result
  and have no technical ability to open it.
- **Some records cannot be individually deleted.** Ticket records live on a public decentralised
  storage network. We can make them permanently unreadable and stop paying to keep them alive, but
  we cannot reach into that network and remove a specific item. We explain this fully in section 8.

The event organiser — not WoCo — is responsible for your attendee data. We handle it on their
instructions. For some things, such as security and our unsubscribe records, we are responsible in
our own right. Section 3 sets out exactly which is which.

---

## 2. Who we are

[COMPANY LEGAL NAME] ("WoCo", "we", "us") is a company registered in England and Wales,
company number [NUMBER], registered office [REGISTERED OFFICE ADDRESS].

We are registered with the Information Commissioner's Office, registration number
[ICO REGISTRATION NUMBER].

**Privacy contact:** [PRIVACY EMAIL]

If we ever appoint a Data Protection Officer we will name them here. We are not currently required
to appoint one.

---

## 3. Who is responsible for your data

We are not in a single role. Being straight about this matters more than sounding simple.

### Where the event organiser is responsible (we act on their instructions)

The organiser decides what to ask you and why. They are the **controller**; we are their
**processor**. This covers:

- your answers to the event's order form (name, phone, dietary requirements, and any custom
  questions the organiser chose to ask)
- your email address, used to deliver your ticket and event updates
- your attendance and check-in record for their event

**Your rights over this data are exercised against the organiser.** Their identity is shown at
checkout and on your ticket. If you contact us instead, we will help you reach them, but we cannot
decide these requests for them — and for order-form answers, we cannot even read the data in
question.

### Where WoCo is responsible

We are the **controller** in our own right for:

- **your WoCo account** — wallet address, login method, profile information you publish, sub-ENS
  name, and any sites or events you create as an organiser
- **our unsubscribe and suppression records** — see section 6, which explains why we hold these
  ourselves rather than leaving them to organisers
- **security, fraud and abuse prevention** — IP addresses, rate-limit counters, session records
- **likes and follows** — these are public on-chain attestations you choose to create
- **payment administration records** — the link between an organiser and their Stripe account

### Where we are not involved at all

**Card payments.** Card details go directly from you to Stripe and never pass through WoCo systems.
Payments are taken by the **organiser** on their own Stripe account — the organiser is the merchant
of record and their name appears on your statement. Stripe is a separate controller for that data.
See [Stripe's privacy policy](https://stripe.com/privacy).

---

## 4. What we collect

| Category | Examples | Where it comes from |
|---|---|---|
| Contact | Email address | You, at checkout or signup |
| Order form | Whatever the organiser asks | You, at checkout — **encrypted in your browser** |
| Identity | Wallet address, passkey identifier, sub-ENS name | Created when you sign in or create an account |
| Ticket | Ticket ID, edition number, event, timestamp, check-in status | Generated when you claim |
| Technical | IP address, browser type, request timestamps | Automatically, when you use the service |
| Marketing preference | Whether you opted in, when, and the exact wording shown | You, at checkout |
| Social | Likes and follows | You, when you use those features |
| Organiser (if you run events) | Business details, Stripe account link, payout records, sites published | You and Stripe |

**We do not collect:** card or bank details, government ID (Stripe collects this from organisers
directly), location beyond the country level, or special category data — unless an organiser adds a
question that asks for it, which is their decision and their responsibility.

**Children.** WoCo is not intended for under-16s. We do not knowingly collect their data. Contact us
if you believe we have.

---

## 5. Why we use it, and our legal basis

| What we do | Legal basis |
|---|---|
| Deliver your ticket and event updates | Contract — you asked us to |
| Store your encrypted order answers for the organiser | Processing on the organiser's behalf; their basis, usually contract |
| Send you marketing about an organiser's future events | Consent, or the PECR "soft opt-in" where you bought a ticket and were offered a clear opt-out |
| Keep our unsubscribe and suppression records | Legal obligation (PECR) and legitimate interests — we cannot honour your opt-out without remembering it |
| Prevent fraud, abuse and spam | Legitimate interests — protecting the platform and its users |
| Operate and improve the service | Legitimate interests — running a functioning platform |
| Meet accounting and tax obligations | Legal obligation |

Where we rely on legitimate interests, we have considered whether our interest is overridden by your
rights. You can object at any time — see section 9.

---

## 6. Marketing, and why we keep the unsubscribe list ourselves

If you opt in at checkout, the organiser can email you about their future events. **The opt-in box is
never pre-ticked**, and you can decline without affecting your ticket.

Every marketing email carries a one-click unsubscribe link and the standard one-click headers your
email client can act on directly.

**When you unsubscribe, we record it on our own servers — not the organiser's.** This is deliberate.
Because our systems transmit the email, we — not just the organiser — are answerable for messages
sent to people who opted out. Holding the record ourselves means:

- your unsubscribe survives an organiser re-uploading an old contact list
- the one-click link works without depending on the organiser doing anything
- bounces and spam complaints are acted on automatically

We store these records as a keyed one-way hash of your email address, never the address itself. It
is a do-not-contact list, not a mailing list. **We cannot delete a suppression record on request** —
doing so would mean forgetting that you asked not to be contacted.

Ticket confirmations, event updates and other service messages are not marketing and have no
unsubscribe link. You cannot opt out of those while you hold a ticket.

---

## 7. Who we share with

| Who | What for | Where |
|---|---|---|
| **The event organiser** | Your attendee data — this is the point of buying a ticket | Wherever they are |
| **Stripe** | Card payment and organiser onboarding | US / Ireland |
| **Resend** | Sending ticket and marketing email | US |
| **Cloudflare** | Content delivery and DDoS protection | Global |
| **Hetzner** | Server hosting | Germany |
| **Swarm network** | Decentralised storage — see section 8 | Global |
| **Etherna** | Alternative decentralised storage gateway | Italy |
| **Photon / Komoot** | Address lookup when an organiser creates an event | Germany |
| **Web3Auth** | Social and email sign-in | US |
| **ZeroDev** | Passkey wallet infrastructure | US |
| **Arbitrum / EAS** | On-chain likes and event registration — **public and permanent** | Global |

We do not sell your personal data. We never have and we do not intend to.

We may disclose data where legally required, or to establish or defend legal claims.

---

## 8. Decentralised storage — please read this part

This is the section most unlike a conventional privacy policy, and the one we would most want you to
read before you buy a ticket.

**What goes onto the public network.** Ticket records are stored on Swarm, a public decentralised
storage network. For each ticket this includes an edition number, timestamps, and an identifier for
the holder — either a wallet address, or a keyed one-way hash of an email address. Where an order
form was used, it also includes the encrypted answers.

**What this means in practice:**

- **It is public infrastructure.** Data is split into chunks and replicated across independent
  computers worldwide. We do not operate most of them and cannot control where they are.
- **Sensitive content is encrypted before it leaves your browser.** Order-form answers are encrypted
  to a key only the organiser holds. What reaches the network is unreadable ciphertext plus
  pseudonymous identifiers.
- **We cannot delete an individual item.** No one can. The network is designed that way.

**So how does deletion work?** Two mechanisms together:

1. **We destroy the key.** The encrypted data becomes permanently unreadable, immediately. This takes
   effect on the day we action your request, not at the end of any window.
2. **We stop paying for storage.** Data persists on Swarm only while storage is paid for. We stop
   renewing it and it is garbage-collected by the network — within **90 days**.

**What we cannot honestly promise.** We cannot guarantee that every copy everywhere is destroyed.
Swarm is public; someone could have retrieved or kept a copy before erasure, and we have no way to
verify garbage collection network-wide. What we can commit to is that we stop storing it, we make it
permanently unreadable, and we stop paying to keep it alive.

**On-chain records are permanent and cannot be erased at all.** If you use likes or follows, or
register an event on-chain, that record is public and permanent by design. Please treat anything you
put on-chain as public forever.

**International transfers.** Because Swarm nodes are worldwide, personal data is transferred outside
the UK to countries without a UK adequacy decision, and standard contractual clauses are not possible
— there is no counterparty to sign them. Our safeguard is technical rather than contractual: sensitive
content is encrypted client-side before it leaves your device, so what crosses borders is ciphertext
and pseudonymous identifiers. **We are telling you this plainly because you should be able to decide
with the facts in front of you.**

For our conventional suppliers (Stripe, Resend, Cloudflare, Hetzner and others in section 7),
transfers rely on the UK International Data Transfer Addendum or an adequacy decision.

---

## 9. Your rights

Under UK GDPR you have the right to: **access** your data; have it **corrected**; have it **erased**;
**restrict** or **object** to processing; **portability**; and to **withdraw consent** at any time.

**Exercise them by emailing [PRIVACY EMAIL].** We respond within one month.

Three honest caveats:

1. **For attendee data, the organiser decides.** They are the controller. We will pass your request on
   and help, but we cannot grant it for them — and for encrypted order data, we cannot read it.
2. **Erasure works as described in section 8.** Immediate crypto-erasure, storage expiry within 90
   days, no guarantee of destruction of every copy on a public network.
3. **Some records we must keep.** Suppression records (forgetting them would defeat their purpose)
   and transaction records required for six years by tax and company law.

**You can complain to the ICO** at [ico.org.uk](https://ico.org.uk/make-a-complaint/) or 0303 123 1113.
We would rather you came to us first, but it is your right either way.

---

## 10. How long we keep things

| Data | Retention |
|---|---|
| Your ticket / attendance record | **Indefinitely** — it is your record of having been there, yours to keep or erase |
| Organiser's copy of attendee data | Event date + 90 days, then removed |
| Account data | While your account is open, plus 90 days |
| Suppression records | Indefinitely — required to honour your opt-out |
| Transaction records | 6 years (Companies Act 2006, HMRC) |
| Security logs and IP records | [LOG RETENTION PERIOD — TO BE SET] |
| On-chain records | Permanent — cannot be deleted |

Your ticket is deliberately long-lived. It is intended as a lasting record of what you attended,
under your control. If you want it erased, ask and we will action it.

---

## 11. Security

Order-form answers and contact lists are encrypted in the browser using X25519 key agreement with
AES-256-GCM, to a key derived from the organiser's own credentials. Our servers can create these
encrypted records but have no code path to open them.

Email addresses are stored as keyed HMAC-SHA256 hashes rather than plaintext. Requests are
authenticated with per-request signatures. All traffic uses TLS.

No system is perfectly secure. We will notify you and the ICO of a qualifying breach within the
required timeframes.

---

## 12. Cookies and local storage

WoCo uses **no advertising or tracking cookies and no third-party analytics.**

We use browser local storage for things the app cannot work without: your session, cached event data
for speed, and your preferences. Because these are strictly necessary, no consent banner is required.

Third parties you interact with directly — Stripe at checkout, your wallet provider, Web3Auth if you
use social login — set their own cookies under their own policies.

See our [Cookie Notice](./COOKIE_NOTICE.md) for the itemised list.

---

## 13. Changes

We will update this policy as the platform changes. Material changes will be notified by email or
in-app notice before they take effect. The version and date are at the top.

---

## 14. Contact

[COMPANY LEGAL NAME]
[REGISTERED OFFICE ADDRESS]
[PRIVACY EMAIL]
