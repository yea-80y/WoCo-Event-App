# Data Processing Addendum

**Last updated:** [DATE OF PUBLICATION]
**Version:** 1.0

> **⚠️ PRE-LAUNCH DRAFT — NOT YET IN FORCE.** Complete `[PLACEHOLDERS]` and have a UK solicitor
> review. This is the Article 28 contract; its content is largely prescribed by statute, so
> deviations should be deliberate.

This Addendum forms part of the [Organiser Terms](./ORGANISER_TERMS.md) between
[COMPANY LEGAL NAME] ("**Processor**", "we") and the organiser ("**Controller**", "you").
It applies whenever we process personal data on your behalf.

It is incorporated automatically when you create an event — you do not need to sign anything. If
your organisation requires a countersigned copy, contact [PRIVACY EMAIL].

---

## 1. Roles

You are the **controller**. We are your **processor**.

We are an **independent controller** for the matters listed in section 3 of our
[Privacy Policy](./PRIVACY_POLICY.md) — platform accounts, security, and suppression records. This
Addendum does not apply to those.

---

## 2. Subject matter and details of processing

**Subject matter:** provision of ticketing, event hosting, attendee communication and audience tools.

**Duration:** for as long as you use the services, plus the retention periods in section 8.

**Nature and purpose:** collecting attendee orders; issuing and delivering tickets; storing encrypted
attendee data for your retrieval; check-in; sending transactional and (where permitted) marketing
email on your instruction; hosting sites you publish.

**Types of personal data:**

- attendee email addresses
- attendee name and any other fields **you choose to include** in your order form
- ticket, attendance and check-in records
- wallet addresses or pseudonymous identifiers
- contact lists you upload
- messages submitted through contact forms on sites you publish

**Categories of data subject:** your attendees, ticket buyers, contacts and site visitors.

**Special category data:** not processed, unless you choose to collect it through a custom order-form
field. If you do, you are responsible for identifying an Article 9 condition. We would advise against
it.

---

## 3. Our obligations

We will:

1. Process personal data **only on your documented instructions**, which are these terms plus your
   configuration of the service, unless legally required otherwise (we will tell you if so, unless
   the law forbids it).
2. Ensure personnel with access are under **confidentiality obligations**.
3. Implement the **security measures** in section 6.
4. Respect the conditions in section 4 for engaging sub-processors.
5. **Assist you** — taking account of the nature of processing — in responding to data subject
   requests, using the tools we make available.
6. **Assist you** with your obligations on security, breach notification, impact assessments and
   prior consultation.
7. **Delete or return** personal data at the end of the services, subject to the limits in section 8.
8. Make available the information needed to demonstrate compliance, and **allow and contribute to
   audits** — see section 9.
9. **Tell you immediately** if we consider an instruction infringes data protection law.

---

## 4. Sub-processors

You give **general authorisation** for us to engage the sub-processors in **Annex 1**.

We will give at least **30 days' notice** before adding or replacing one, by email or in-app notice.
You may object on reasonable data protection grounds. If we cannot resolve your objection, you may
terminate the affected services without penalty; that is your exclusive remedy.

We impose data protection obligations on each sub-processor no less protective than these, and we
remain fully liable to you for their performance.

---

## 5. Decentralised storage — specific acknowledgements

**This section departs from a standard DPA because the underlying technology does.** Please read it
before you collect attendee data.

You acknowledge and instruct us that:

1. **Attendee data is stored on Swarm**, a public decentralised storage network operated by
   independent third parties worldwide. It is not a conventional hosted database.
2. **Data is split into chunks and replicated** across nodes we do not operate and cannot identify.
3. **Individual records cannot be deleted mid-cycle.** Erasure is achieved by (a) removing the record
   from the platform immediately, so it is no longer shown or used, and (b) ceasing to renew its
   storage, after which the network's garbage collection drops it. **There is no decryption key we
   can destroy on your behalf** — the key that seals your attendee data is derived from your own
   credentials, exists only in your browser, and is re-derivable by you on any device. It is also a
   single key per organiser, so it could not be used to erase one attendee's record in any event.
4. **We cannot guarantee destruction of every copy.** A third party may have retrieved or retained
   data before erasure. We cannot verify network-wide garbage collection.
5. **Order-form data and contact lists are encrypted client-side to your key.** We cannot read them.
   This means we **cannot** retrieve, correct, export or inspect that content on your behalf — you
   must do so through your dashboard. **If you lose your credentials, the data is unrecoverable.**
6. **Correction is by supersession, not overwrite.** A corrected record is published as a new version
   and is what the platform uses from then on. The earlier version remains retrievable from the
   network until its storage lapses.
7. **Attendee identifiers are not encrypted at network level.** Ticket records carry a wallet address
   or a keyed hash of an email address as plain text on a public network. Order-form content is
   encrypted; these identifiers are not.
8. **This constitutes a restricted international transfer** for which no adequacy decision exists and
   standard contractual clauses are not achievable, there being no identifiable counterparty. The
   safeguard relied upon is **technical**: client-side encryption before data leaves the browser, so
   what is transferred is ciphertext and pseudonymous identifiers.
9. **On-chain records are permanent** and cannot be erased by anyone.

**You are responsible for informing your data subjects** of points 1–4, 6, 7 and 9 in your own privacy
notice. Our checkout displays a summary, but where you collect data through your own website, embed
widget or other channel, that disclosure is yours to make.

If this model is not compatible with your obligations, do not use the platform to collect attendee
data.

---

## 6. Security

We implement appropriate technical and organisational measures, including:

- **Client-side encryption** of order data and contact lists (X25519 key agreement, AES-256-GCM) to a
  key derived from your credentials. Our servers have no code path to decrypt.
- **Email addresses stored as keyed HMAC-SHA256 hashes** rather than plaintext.
- **Per-request cryptographic authentication** of API calls; session delegation with expiry and
  revocation.
- **TLS** for all data in transit.
- Access controls, least privilege, and logging on production systems.
- Replay prevention on payment and webhook paths.

We review these measures periodically and may update them, provided protection is not reduced.

---

## 7. Personal data breaches

We will notify you **without undue delay, and in any event within 24 hours**, of becoming aware of a
personal data breach affecting your data, with the information available to us: nature of the breach,
categories and approximate numbers affected, likely consequences, and measures taken.

You are responsible for notifying the ICO and affected data subjects where required — you are the
controller and hold the relationship.

---

## 8. Deletion and return

On termination, or on your written request, we will delete personal data processed on your behalf,
subject to section 5 (what deletion means on decentralised storage) and except where retention is
legally required.

**We will retain:** suppression records (deleting them would defeat their purpose and breach PECR);
records needed for tax, accounting and legal claims; and data on public networks or blockchains that
cannot be deleted.

You may export your attendee data from your dashboard at any time. **Do this before you close your
account** — we cannot export encrypted data for you.

---

## 9. Audit

We will make available information reasonably necessary to demonstrate compliance with Article 28.

You may audit no more than **once in any 12 months** (unless required by a supervisory authority or
following a breach), on at least 30 days' notice, during business hours, without unreasonable
disruption, subject to confidentiality, and at your cost. We may satisfy an audit request by
providing a current third-party report or completed security questionnaire.

---

## 10. Liability

Liability under this Addendum is subject to the limitations in the Organiser Terms, except where
those limits cannot lawfully apply — in particular in respect of claims by data subjects or
regulatory fines under Article 82.

---

## Annex 1 — Sub-processors

| Sub-processor | Purpose | Location | Transfer mechanism |
|---|---|---|---|
| **Stripe** | Payment processing, organiser onboarding | US / Ireland | UK IDTA / adequacy |
| **Resend** | Transactional and marketing email delivery | US | UK IDTA |
| **Cloudflare** | CDN, DNS, DDoS protection, tunnelling | Global | UK IDTA |
| **Hetzner** | Server and node hosting | Germany | UK adequacy |
| **Swarm network** | Decentralised storage | Global, uncontrolled | Technical safeguard — see §5 |
| **Etherna** | Alternative Swarm gateway and storage routing | Italy | UK adequacy |
| **Photon (Komoot)** | Geocoding at event creation | Germany | UK adequacy |
| **Web3Auth** | Social and email sign-in | US | UK IDTA |
| **ZeroDev** | Passkey smart-account infrastructure | US | UK IDTA |
| **Arbitrum / EAS** | On-chain attestations — public and permanent | Global | Technical safeguard — see §5 |

Current as at [DATE]. The live list is maintained at [SUB-PROCESSOR PAGE URL].

---

## Annex 2 — Technical and organisational measures

As set out in section 6 above, and in our [Security Posture](../SECURITY_POSTURE.md).
