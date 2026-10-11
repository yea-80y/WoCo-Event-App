# Organiser privacy notice - the rule, the comparison, the open points

Status: rule decided by the owner 2026-10-11 and enforced in code. Section 4 is a DRAFT for the
owner's approval - nothing in it is decided until the owner signs it off.

Background: PR #856 added the organiser's own privacy notice (UK GDPR Art. 13). The organiser is
the controller for attendee details and WoCo is their processor (DATA_INVENTORY §1, DPA §1-2).

---

## 1. The rule

**An organiser cannot sell tickets until they have confirmed their own privacy notice.** WoCo's
pre-filled draft is never shown to the public as the organiser's notice.

- "Confirmed" = a notice that validates for the organiser's account on their own signed feed
  `woco/legal/privacy-notice/{account}` (format `woco.privacy-notice.v1`). The editor writes it only
  on an explicit confirm.
- Enforced on the server, in lockstep with the UI, so an old client or a direct API call cannot get
  past it.

| Where | What happens without a confirmed notice |
|---|---|
| `POST /api/events/:id/series/:sid/reserve` | 409 `PRIVACY_NOTICE_REQUIRED` - no seat is held |
| `POST /api/stripe/create-checkout` | 409 `PRIVACY_NOTICE_REQUIRED` - refused before any order is held or card charged |
| `POST /api/agent/quote` and `/buy` (flag off) | same refusal, so turning the rail on cannot sell past it |
| Notice unreadable (Swarm fault) | 503 `PRIVACY_NOTICE_UNAVAILABLE` on every sale path - fails closed |
| Public notice page (`#/privacy-notice/...`, site footers) | shows only a confirmed notice; otherwise says it isn't confirmed and nothing is on sale. Browsing is never blocked |
| Organiser Home | "Confirm your privacy notice" is setup step 2, right after Stripe, and stays up until done |
| Publishing a paid event / deploying a site with events | asks first; the organiser can confirm in a new tab, re-check, or publish now and sell once confirmed |

How the server reads it (`apps/server/src/lib/legal/notice-gate.ts`):

- Under the same keys as the public notice page (`eventKeys`: the key ring's signer, else the #670
  record) - never the event feed's own fields. So "this event sells" and "an attendee sees a
  confirmed notice for it" cannot disagree. The public route reads through the same cache.
- Cached in memory. A confirmed notice is a memory hit for 10 min, then served while it is re-read
  in the background (one read per organiser, however many buyers). A re-read that cannot answer
  keeps the last confirmed notice for at most 1 h after it was read; past that, sales refuse until
  it can be read. "Not confirmed" is kept 30 s. The organiser's own confirm clears it at once.
- No new server state, nothing to back up.

Not gated, on purpose: `prepare-order` (no charge, the box is held in memory and unreadable to WoCo)
and fulfilment (money already taken - refusing there would be charge-then-refund).

---

## 2. How comparable platforms handle it

Sources below were found by web search on 2026-10-11. Direct page fetches were blocked from the
build environment, so each line rests on the cited page's search summary - check the page before
relying on it.

| Platform | Model | Must the organiser supply a notice? | Where it is shown | Notes |
|---|---|---|---|---|
| **Eventbrite** | Organiser = controller, Eventbrite = processor for attendee data, under an organiser DPA folded into the Terms of Service ([DPA for organizers](https://www.eventbrite.com/help/en-us/articles/429030/data-processing-addendum-for-organizers/), [EU data protection](https://www.eventbrite.co.uk/help/en-gb/articles/363929/eventbrite-eu-data-protection/)) | Not found as a hard requirement | Eventbrite's own policy tells attendees to read each organiser's policy ([privacy policy](https://www.eventbrite.com/help/en-us/articles/460838/eventbrite-privacy-policy/)) | Organiser is "solely responsible" for notifying attendees in some add-ons ([Solutions Addendum](https://www.eventbrite.com/help/en-us/articles/898904/solutions-addendum/)) |
| **Ticket Tailor** | Organiser = controller, Ticket Tailor processes on their behalf ([privacy policy](https://www.tickettailor.com/en-us/legal/privacy-policy)) | Optional field in Box office settings; a free generator for event organisers ([help](https://help.tickettailor.com/tutorials/box-office-management/how-to-add-a-privacy-policy-to-your-online-box-office)) | Linked on every box office page; hosted per organiser at `tickettailor.com/promoter/privacy-policy/link/{name}` ([example](https://www.tickettailor.com/promoter/privacy-policy/link/frenchcoffeebean)) | If left blank, default text tells buyers to contact the organiser. Closest to WoCo |
| **DICE** | DICE acts as a disclosed ticketing agent for "Event Partners" ([US policy](https://support.dice.fm/article/245-united-states-privacy-policy)) | For shared fan data (MIO Connect) each party must publish its own policy ([joint controllership agreement](https://support.dice.fm/article/987-dice-event-partner-joint-controllership-agreement-for-the-use-of-mio-connect)) | DICE's own policy at checkout | Platform-led model |
| **Skiddle** | Skiddle is controller of data collected through its ticketing ([privacy policy](https://www.skiddle.com/terms/privacy-policy/)) | Older promoter guidance: once data leaves Skiddle the promoter is responsible; Skiddle may end the data sharing agreement on a breach ([promoter GDPR FAQs](https://help.promotioncentre.co.uk/en/articles/9362916-gdpr-promoter-faqs)) | Skiddle's policy | Platform-led; guidance dates from 2018 |
| **Humanitix** | Own Privacy and Cookies Notice; says it does not own buyer data ([notice](https://static.humanitix.com/docs/privacy-and-cookies-notice-june-2025.html), [help](https://help.humanitix.com/en/articles/8905589-privacy-and-data-security)) | No organiser-notice mechanism found | Humanitix's notice | Hosts add their own checkout questions |
| **Tito** | Tito = controller for organisers, processor for attendee data; organiser = controller ([data protection](https://intercom.help/tito/guides/setup/data-protection), [GDPR](https://pro.tito.io/docs/security/gdpr)) | Not found as a requirement | Organisers' own sites link Tito's and their own policy | Clear "our role / your role" help page |
| **Luma** | Luma's policy says guest details are passed to the event host ([privacy](https://luma.com/privacy)) | Not found | Luma's policy | Host terms not found - low confidence |
| **See Tickets** | See Tickets UK states it is the data controller; joint controller with partners for partner-site sales ([data protection](https://www.seetickets.com/content/data-protection)) | Not found | See Tickets' policy | Platform-led |

What this shows: two models. Platform-led (DICE, Skiddle, See Tickets, Luma, Humanitix) put their
own notice at checkout. Processor platforms (Eventbrite, Ticket Tailor, Tito) leave the notice to
the organiser. **None found blocks sales until the organiser confirms a notice** - WoCo's rule is
stricter than the market, which is the safe side for a processor that cannot otherwise show the
controller's notice at the point of collection.

Worth copying:

- **Ticket Tailor's hosted per-organiser page and link on every page** - WoCo already does both.
- **Ticket Tailor's generator** - WoCo's pre-fill is the same idea, and better: it is generated from
  our own legal docs, so the platform facts cannot drift.
- **Tito's plain "our role, your role" page** - worth a short organiser help page that says the same
  thing in two paragraphs. Follow-up.
- **DICE's "each party publishes its own policy" clause** - matches ORGANISER_TERMS §4; nothing to add.

---

## 3. What existing organisers must do

Confirm their notice at Creator home → Privacy notice (or the Home card). Until they do, their
tickets are off sale. Nothing else: no republish is needed for the gate.

---

## 4. The #856 points - DRAFT ANSWERS FOR OWNER APPROVAL

Each answer is a draft. Mark it approved, or change it, before anything below is built or relied on.

**1. Showing a pre-filled notice in the organiser's name until they confirm.**
Draft answer: **No longer happens** (owner decision 1). The public page shows only a confirmed
notice and sales refuse until one exists. ORGANISER_TERMS §4 and DPA §2 are rewritten to match in
this PR. Nothing to approve beyond those two paragraphs.

**2. Contact-form messages on legitimate interests.**
Draft answer: **Keep legitimate interests (Art. 6(1)(f)).** Someone who writes to an organiser
expects a reply; replying is the interest, it is what they asked for, and the impact is low.
Consent would add nothing and could be withdrawn mid-conversation. Approve as written.
Open, for the owner: a site whose owner has not confirmed a notice still shows its contact form.
Recommendation: disable the form's submit until the notice is confirmed (follow-up, small).

**3. Automated decisions (Art. 13(2)(f)).**
Draft answer: **WoCo states "none" for its own part; the organiser's field stays for theirs.** WoCo
makes no decision about an attendee by purely automated means with legal or similarly significant
effect: seat holds and rate limits are temporary and do not decide anything about a person, and
card fraud screening is Stripe's, as a separate controller. Proposed sentence for the generator:
"WoCo's booking system makes no decisions about you by purely automated means that have legal or
similarly significant effects." Code change after approval.

**4. The organiser's privacy contact is not verified.**
Draft answer: **Acceptable at launch.** The organiser confirms the address as their own, and the
notice also offers privacy@woco-net.com to be passed on, so an attendee always reaches someone.
Verify the address by email link once SES lands (DATA_INVENTORY §8 item 9). Approve with that
follow-up.

**5a. The soft opt-in wording.**
Draft answer: keep the meaning, tighten to PECR reg. 22(3): "We may also email you about our
similar events if you bought a ticket from us, were given a simple way to say no when you did, and
have not said no since. Every email lets you unsubscribe." Code change after approval.

**5b. "Payment records: kept by Stripe and by us for 6 years".**
Draft answer: **Change it.** Six years is right for a company but not for every organiser (a sole
trader's HMRC period runs from the filing deadline). Proposed: "Payment records: kept by Stripe,
and by us for as long as tax and company law require (usually 6 years)." Code change after
approval.

**6. "It describes our platform accurately" (ORGANISER_TERMS §4).**
Draft answer: **Keep it, scoped.** WoCo writes the platform facts from its own policies and should
stand behind them, but only for the parts it writes and only while they are current. Proposed:
"The parts we write describe our platform accurately when you confirm them, and we update them
when our platform changes." That commits WoCo to keeping the generator in step with docs/legal,
which the code already enforces (the generator is the single source).

**7. Legacy (pre-#670) events cannot show a confirmed notice.**
Draft answer: **Moot.** A legacy event cannot sell at all - create-checkout refuses it with
`EVENT_NEEDS_REPUBLISH`, and the seat hold now refuses it too. Its notice page says it needs
publishing again. Nothing to approve.
