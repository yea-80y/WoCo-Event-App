# Organiser Terms

**Last updated:** [DATE OF PUBLICATION]
**Version:** 1.0

> **⚠️ PRE-LAUNCH DRAFT — NOT YET IN FORCE.** Complete `[PLACEHOLDERS]` and have a UK solicitor
> review. Section 6 (chargeback liability) is the commercially critical clause — see
> `docs/legal/DATA_INVENTORY.md` §5.1 for why.

These terms apply if you use WoCo to **sell tickets, run events, publish a site, or contact an
audience**. They are in addition to the [Terms of Service](./TERMS_OF_SERVICE.md).

By creating an event you confirm you have authority to bind the organisation you represent.

---

## 1. Your relationship with us, and with your attendees

**You sell the ticket. We provide the platform.**

- The contract for the event is between **you and your attendee**. We are not a party to it.
- We act as your **disclosed agent** in presenting and processing orders.
- Payments are taken on **your own connected payment account**. You are the merchant of record;
  your business name appears on the attendee's card statement.
- You set prices, capacity, entry conditions and your refund policy.

You are responsible for delivering the event you advertised, and for everything that follows from it.

---

## 2. Your legal responsibilities

You are responsible for complying with every law that applies to running your event, including:

- **Licensing** — premises, alcohol, entertainment, and any local authority requirements
- **Health and safety** — capacity limits, fire safety, crowd management, risk assessment
- **Accessibility** — Equality Act 2010 duties to make reasonable adjustments
- **Consumer law** — honest pricing, clear terms, honouring refunds you have promised
- **Data protection** — see section 4
- **Tax** — VAT and income/corporation tax on your sales are yours to account for. We do not
  withhold or remit tax for you. Where fees are subject to VAT we will invoice accordingly.

**We do not check any of this.** Listing an event on WoCo is not approval or endorsement.

---

## 3. Content and conduct

You must not use WoCo to sell tickets for, or promote, anything unlawful, fraudulent, hateful, or
that we reasonably consider harmful to attendees or to the platform.

We may remove an event, suspend a site, or close an account that breaches these terms. Where money
has been taken from attendees, we will act to protect them first — including releasing information
to them and to payment providers.

---

## 4. Data protection — this section matters

**You are the data controller for your attendee data. We are your processor.**

That is not a formality. It means you carry legal obligations that we cannot discharge for you, and
that we are architecturally unable to discharge — we cannot read the encrypted order data your
attendees submit.

### What you must do

1. **Have a privacy policy** and make it available to your attendees. If you do not have one, you are
   in breach of UK GDPR from the moment you collect your first attendee's details.
2. **Only ask for what you need.** Every field you add to an order form is data you are responsible
   for. Do not collect special category data (health, religion, ethnicity, sexuality) unless you have
   a lawful basis and have thought carefully about it.
3. **Honour data subject rights.** Your attendees' access, correction and erasure requests come to
   you. You must respond within one month.
4. **Only send marketing where you are permitted to.** See section 5.
5. **Keep your decryption credentials safe.** If you lose them, the attendee data sealed to you is
   permanently unrecoverable. We cannot recover it — that is the point of the design.
6. **Tell us within 24 hours** if you become aware of a personal data breach affecting attendee data,
   so we can meet our own notification duties.

### What we do

We process attendee data only on your instructions, as set out in our
[Data Processing Addendum](./DATA_PROCESSING_ADDENDUM.md), which forms part of these terms.

**Understand the storage model before you collect anything.** Attendee records are stored on a public
decentralised network. Records cannot be individually deleted; erasure works by removing the record
from the platform immediately and then letting its storage on the network expire. The full mechanism and its limits are in the
[Privacy Policy](./PRIVACY_POLICY.md) section 8. **You are responsible for telling your attendees
this** where you collect data outside our checkout — for example on your own website.

### If you use our site builder or embed widget

Sites you publish through WoCo, and the embed widget on your own domain, collect personal data
**under your control, on your behalf**. You must ensure a privacy notice is available on those
surfaces. We provide the tools; using them is your responsibility.

---

## 5. Marketing your events

You may only send marketing to people who have **consented**, or who fall within the PECR "soft
opt-in" — they bought a ticket from you, you offered them an opt-out at that point, and you are
promoting similar events.

**When you upload a contact list, you warrant that you have a lawful basis for every address on it.**
We take that warranty at face value; if it is wrong, the liability is yours.

Our platform enforces some things regardless of what you do:

- **A suppression list you cannot bypass.** Anyone who unsubscribes is blocked at send time, on our
  servers. Re-uploading an old list does not resurrect them. This protects your reputation as much
  as theirs.
- **Unsubscribe links and headers** are added to every marketing message automatically and cannot
  be removed.
- **Sending caps** apply per organiser to protect deliverability for everyone.

Ticket confirmations and event updates are transactional and are not subject to the above.

Deliberately circumventing these controls is a material breach and will result in immediate
suspension.

---

## 6. Payments, fees, refunds and chargebacks

**Read this section carefully — it is where your financial exposure sits.**

- **You choose whether to add a booking fee.** When you create a ticket you decide whether a
  booking fee — your chosen percentage, 10% by default, minimum 4.5% — is added on top of your
  ticket price and paid by the buyer, or whether the buyer pays your ticket price alone. Either
  way the buyer sees the full total before paying.
- **Our platform fee is 1.5% of your ticket price** (the booking fee is not fee'd), collected
  automatically from each sale.
- **Card processing fees are charged to your connected account** by the payment provider, at the
  provider's published rates for the card used.
- **Whatever remains of the booking fee after those deductions is yours**, on top of your ticket
  price.

**Worked example** — £20 ticket, 10% booking fee, standard UK consumer card: the buyer pays
£22.00; our platform fee is £0.30 (1.5% of £20); card processing is £0.53 (1.5% + 20p on £22.00);
you receive **£21.17**. With the booking fee switched off, the buyer pays £20.00 and you receive
**£19.20**. Processing rates vary by card type — the example uses the provider's standard UK
consumer-card rate at the time of writing.

We will give reasonable notice before changing this structure.

### When you get paid

**Your ticket sales are paid out after your event has taken place, not when the ticket sells.**

- Your sales settle into **your own account with our payment provider**. We do not hold your
  money and this is not an escrow arrangement — we control the timing of the release, and
  nothing else.
- Your account is set to a manual payout schedule. We release each event's takings
  **2 days after that event ends**, and you can see what is held and when it is
  due to release in your dashboard at any time.
- **Exception — sales more than 90 days before your event.** Our payment
  provider does not permit funds to be held indefinitely: money must be paid out within
  90 days of the sale, wherever your event falls. Where you sell earlier than
  that — early-bird or festival on-sales — those takings are released to you **before** your
  event. Your refund obligation below is unchanged, so if you sell far in advance you must be
  able to refund from your own funds.
- Where we reasonably consider the risk warrants it we may hold a reserve against future
  sales, or limit how far in advance you may sell.

We will tell you the applicable schedule before you sell.

### Refunds and chargebacks

**You are responsible for refunds.** If you cancel, reschedule or fail to deliver an event, you must
refund your attendees.

**If we cannot issue a ticket after a buyer has paid** — because of a failure on our side, not
yours — we refund the buyer automatically for the tickets we could not issue, and we return our
platform fee on the refunded amount to you at the same time. The payment provider may retain its
card-processing fee on the original payment; that is the provider's policy, not ours, and we do
not reimburse it. A refund that a buyer asks you for is your decision and is not covered by this.

**You are responsible for chargebacks on your sales**, including the disputed amount and any fee.
Chargebacks are taken from your payment account balance in the first instance.

**You indemnify us** against any loss we suffer arising from: chargebacks or refunds on your sales
that your balance does not cover; your breach of these terms; your breach of data protection or
marketing law; and any claim brought by an attendee in relation to your event.

**This is a real risk, not boilerplate.** If you cancel an event after payout, the chargebacks still
arrive. We may recover those amounts from you, and we may hold a reserve against future sales where
we reasonably consider the risk warrants it. This risk is highest on sales made long before the
event, because those funds must be released to you before it takes place (see "When you get paid").

If you have any doubt about your ability to deliver an event, do not sell tickets for it.

---

## 7. Storage and hosting

Publishing events, sites and images consumes decentralised storage that we pay for.

- Free hosting is offered subject to a **[QUOTA]** limit and to eligibility checks, and is a
  time-limited launch offer we may withdraw.
- Storage is paid for in fixed periods and must be renewed. **If storage expires, published content
  can become permanently unavailable.** We will give reasonable notice before expiry, but keeping
  your content live is ultimately your responsibility.
- Content published to a public network may persist even after you delete it from your dashboard.

---

## 8. Suspension and termination

You may stop using WoCo at any time. **Tickets already sold remain valid and you remain responsible
for those events.**

We may suspend or terminate your account for breach, for legal reasons, or where we reasonably
believe attendees are at risk. Where we do, we will act to protect attendees who have already paid.

Termination does not end your obligations for events already sold, refunds owed, or the indemnity in
section 6.

---

## 9. Liability

Nothing limits liability for death or personal injury caused by negligence, fraud, or anything else
that cannot lawfully be limited.

Subject to that, and because you are contracting with us as a business rather than a consumer:

- We are not liable for indirect or consequential loss, loss of profit, revenue, goodwill or data.
- We are not liable for loss caused by decentralised networks outside our control, by storage
  expiry where notice was given, or by your loss of your own keys.
- Our total liability to you in any 12-month period is limited to the platform fees we received
  from you in that period.

---

## 10. Changes, law, and contact

We may update these terms on reasonable notice. Material changes will be notified before they take
effect.

Governed by the law of **England and Wales**; the courts of England and Wales have exclusive
jurisdiction.

[COMPANY LEGAL NAME] · [REGISTERED OFFICE ADDRESS] · [SUPPORT EMAIL]
