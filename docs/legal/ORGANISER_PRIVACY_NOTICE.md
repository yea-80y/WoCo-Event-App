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
  `woco/legal/privacy-notice/{account}` (format `woco.privacy-notice.v2` since 2026-10-13; v1 notices are
  refused, so their organisers publish again). The editor writes it only
  on an explicit confirm.
- Enforced on the server, in lockstep with the UI, so an old client or a direct API call cannot get
  past it.

| Where | What happens without a confirmed notice |
|---|---|
| `POST /api/events/:id/series/:sid/reserve` | 409 `PRIVACY_NOTICE_REQUIRED` - no seat is held |
| `POST /api/stripe/create-checkout` | 409 `PRIVACY_NOTICE_REQUIRED` - refused before any order is held or card charged |
| `POST /api/agent/quote` and `/buy` (flag off) | same refusal, so turning the rail on cannot sell past it |
| Buyer's form (main app and embed) | closes on `PRIVACY_NOTICE_REQUIRED` or `EVENT_NEEDS_REPUBLISH` and shows the server's reason, so nobody keeps typing details for a sale that cannot happen |
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
  it can be read. "Not confirmed" is kept 30 s. The organiser's own confirm clears it at once, and
  for 10 s after it a "not confirmed" read (a feed cache not yet caught up) is answered but never kept.
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

**3. Automated decisions (Art. 13(2)(f)).** SETTLED 2026-10-13 (§5): stated for every organiser, not asked.
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

**5a. The soft opt-in wording.** SUPERSEDED 2026-10-13 (§5): the declaration box is gone, because the
checkout offers an opt-in only and a soft opt-in needs an opt-out at the point of sale. BUILT
2026-10-14 (§6): the checkout now offers that opt-out, and the notice states it.
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

---

## 5. Choices, not free text (owner, 2026-10-13)

The editor asked organisers to write legal answers in empty boxes. It now offers the answer nearly
every organiser gives, already picked, and they change it if it is not theirs:

| Was (v1, free text) | Now (v2) |
|---|---|
| Why you ask your order-form questions | Stated: "to run the event you booked, for example for seating, catering or access" on our contract with them. Optional "anything else" box ends our sentence |
| Who else you share with | Categories (Art. 13(1)(e) allows them), all ticked: own team/staff/volunteers, venue, door and security, co-promoters and partners. Optional "anyone else". Always adds "we never sell your details, and no one we share them with may use them for their own marketing" |
| How long you keep details | 6 (default) or 12 months after the event. Pick-only, because the retention sweep carries it out (#547). No 3: a card dispute can arrive ~120 days after a sale |
| Automated decisions | Stated for everyone: neither the organiser nor WoCo decides about attendees purely by computer with a legal or similar effect; Stripe screens payments under its own policy |
| Soft opt-in declaration | Removed (see 5a). Replaced 2026-10-14 by one question, "Do you only email people about your own events?" (§6) |
| (new) Tailored mailing list | Default on: what is kept on the mailing list (their area, say) chooses which events members hear about. The booking's own answers are deleted on schedule for everyone |
| (new) Per question: "Keep on mailing list" | Pre-ticked from the label for names, area, postcode and town; copied onto the contact when the buyer joins the list; the notice names each kept question |
| (new) Per question: health | Pre-set from the label (allergies, dietary, access needs...): always optional, a consent line at the question, never kept on a list; the notice adds a purpose + Art. 9 basis sentence |

Every choice is the organiser's instruction to WoCo as processor. Locking one would make WoCo decide
purposes or retention, which is a controller's call. The editor drops the "not legal advice" and
"earlier versions stay retrievable" warnings: both are in ORGANISER_TERMS §4, where they belong.

**Depends on the retention sweep.** The notice says order-form answers are deleted N months after the
event. The sweep is built (#547) but ships as `dry-run`: nothing is deleted until
`ORDER_RETENTION_SWEEP=live`, so switch it live before this notice reaches production.

First live run:
1. Set `ORDER_RETENTION_SWEEP=live` and `ORDER_RETENTION_LIMIT=1` together. The ops run endpoint runs
   in the configured mode, and the boot timer fires about 7 minutes after start - live with the
   default limit (500) would erase everything due on that first pass.
2. Check the one erased order: the dashboard shows it erased, its record carries `erasedBy` and the
   rule, and nothing is left burning.
3. Remove the limit.

**Deploy order.** The frontend deploy follows the server deploy straight away: the server refuses v1
notices, so existing organisers cannot sell until they publish a v2 notice from the new editor.

---

## 6. Soft opt-in checkout (owner, 2026-10-14)

PECR reg. 22(3) lets an organiser email buyers about their own similar events if the buyer was given
a simple way to say no at the sale. The editor asks one plain question, "Do you only email people
about your own events?":

- **Yes** (a new draft's default) stores `marketingBasis: "own-events"`. The checkout shows "We'll
  email you about similar events from {organiser}. You can unsubscribe from any email." and an
  unticked "Don't email me about similar events". The notice says: "To email you about our similar
  events, unless you tick 'Don't email me' at checkout. This is the 'soft opt-in' in the UK's
  electronic marketing rules: you bought from us, you could say no when you did, and every email has a
  one-click unsubscribe. Our basis for using your details this way is our legitimate interest in
  telling customers about similar events. You can object at any time and we will stop."
- **No** (venues and promoters who market other people's events) stores nothing: absent = consent
  mode, today's unticked "Email me" and today's sentence. Code never moves a confirmed notice between
  modes.

The server reads the mode from the CONFIRMED notice; the page echoes it and create-checkout refuses a
mismatch (an untouched box means yes in one mode and no in the other). Each record keeps the basis it
was made under (`consent` or `soft-opt-in`), so a change of answer needs no re-permissioning. A soft
opt-in never lifts a decline or an unsubscribe and never replaces a consent record. Retention (#547)
is the same for both. Follow-ups, not built: a legitimate-interests assessment template for
organisers; the charity soft opt-in (reg. 22(3A)), which "similar events" does not fit.
