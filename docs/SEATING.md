# Allocated seating

Status: PLAN (2026-11-03). Nothing below is built yet. Seated events stay off behind
`seatedEventsAllowed` (`packages/shared/src/features.ts`, UI and server in lockstep) until every
slice in "Build order" has shipped.

The ledger is already live: `WoCoTicketLedger` (ledger2) on Arbitrum One records each ticket's seat
beside its slot (`registerSeatedEvent`, `batchClaimSeats[Bearer]`, `seatOf`, `seatWord`, organiser-signed
`reseatBearer` / `reseat`). Contract header "Seats" is the authority for what the chain guarantees.

## Decisions

Design consult 2026-11-03 (Fable, 59/59) on prototype v3.1, reconciled with Opus. Where they differed it says so.

1. **One seating plan = one seated series = one on-chain event.** Price bands are tiers INSIDE it, not
   separate series. One basket across bands; moving anyone to any seat is one signed move (never the
   `NO_SEAT` + new-mint road a band-per-event design needs). Supply registered = every seat on the plan,
   held and wheelchair seats included, gaps excluded, so releasing held seats never needs a new
   registration. Standing tickets stay ordinary series beside it.
2. **The seat set is committed, prices are not.** At publish the browser freezes the plan into a
   content-addressed blob; the seated series' manifest names it (`editionTemplate.seatPlan =
   { ref, digest, seats }`), so the on-chain `manifestRef` commits every seat and label. Labels are
   physical facts; prices are commercial terms and live in the event feed beside `series.payment`
   (band id -> price), same trust as today's price. A seat whose band is missing from the feed is
   unsellable.
3. **Holds and organiser holds are per seat.** The 10-minute hold names seat indices. Seats the
   organiser keeps back ("held") live in a per-event seat-state feed the organiser signs, not the event
   feed (the event feed has a second writer and a 10-minute server cache).
4. **The server never trusts the feed for the seat set.** At registration it re-derives the canonical
   seat list from the plan, refuses a mismatch, and pins `planDigest` + `seated: true` on the
   registration record. Reserve, mint and door read the plan from that pin (the #426 rule).
5. **Freed seats need the organiser's say-so before they sell again** (contract header: a picker "must
   not sell a seat an organiser-only move freed until the account confirms it"). DIFFERS from Fable:
   Fable put the confirmed seat nonces in a server `.data` file; Opus puts them in the organiser's
   seat-state feed (written by the dashboard under the organiser unlock, signed by the feed signer, a
   different key from the organiser key the header worries about). Same rule, no new server state, and
   the buyer map can apply it without our server. Goes to the S6 sign-off by name.
6. **The buyer map reads Swarm and the chain directly; our server adds only the live holds.** The plan is
   content-addressed (fetched by ref, checked against its digest), taken seats and `remaining()` come from
   the chain in one multicall (`seatWord` = 256 seats per word), as the app already reads Arbitrum from
   the browser (`lib/sub-ens/rpc.ts`). The server contributes the one thing only it knows - seats in a
   10-minute hold - plus the sale itself. With our server down the map draws in full and shows what is
   sold; it cannot sell. DIFFERS from Fable (server first, direct as fallback, over public-RPC rate
   limits): unverified whether those limits are per caller; if they bite, a read cache goes in front of
   the chain reads, not our server in front of the map. Note: the event page itself still reads
   `/api/events/:id`; making the whole page server-optional is separate work.

## Data

| What | Where | Signed by | Changes after publish |
|---|---|---|---|
| Plan library (layouts, band names, no prices) | `woco/seating/plans/{address}` + one doc per plan | organiser feed signer | yes, never touches live events |
| Event plan (items, bands, canonical seat list) | content-addressed blob, `woco.seatplan.v1` | committed by the manifest digest | never |
| Band prices | event feed, beside `series.payment` | organiser feed signer | no (fixed at publish, as today) |
| Held seats + confirmed seat nonces | `woco/event/{eventId}/seats`, `woco.seatstate.v1` | organiser feed signer | yes |
| Who holds which seat | ledger2 `seatOf` / `seatWord` | chain | by organiser-signed moves only |
| 10-minute holds | server reservation store | server | ephemeral |

Seat-list rules: canonical walk of the plan, versioned, golden vectors; label parts structured
(`{ section, row, seat, table }`), never a pre-rendered string; `accessible: false`, never `null`
(statement values refuse null); `seats` = manifest `totalSupply` = registered supply. Every reader
checks `digest` against the fetched bytes; a plan that reads absent on the money path fails closed.
The event copy keeps the library plan id (read-only) so an organiser can see where it came from.

## Selling a seat

- **Reserve** names seat indices (at most `RESERVATION_MAX_QTY`). Under the per-series lock, in order:
  index < registered supply; sellable in the pinned plan; not held; not in the server's own minted set
  (a fresh chain read can lag); seat nonce confirmed (decision 5); chain bit clear; not in a live hold;
  count <= remaining - held; the per-IP cap counts seats. A 409 returns the conflicting indices.
- **Checkout** prices per seat: one Stripe line item per band, one order-level cover fee, application
  fee on the subtotal (`cardOrderAmountsMulti` in `packages/shared/src/event/fees.ts`; rates stay in
  `PRICING_AND_EMAIL.md`). The hold is extended to the Stripe session's expiry (>= 30 min), and a new
  `checkout.session.expired` handler releases it early. Today a 10-minute hold can lapse while the buyer
  is still on Stripe's page.
- **Mint** `batchClaimSeatsBearer` from the server's reservation record only, never from Stripe
  metadata or the client. No fallback when the reservation is missing, expired or consumed: refund.
  `SeatTaken` and friends go through the existing failed-mint refund + email; never a substitute seat.
  `SeatAssigned` from the receipt fills the sale record and the ticket email.
- **Refunded seats** keep their chain bit set: unsellable until reissue exists (#983 step 5). The map
  shows them unavailable.
- **Door** pack carries `seats[]` beside `slotOwners` (from `seatOf`); the scanner refuses a seated
  ticket with no seat, or a seated series with no `seats` (old pack), and shows "Stalls, Row D, seat 7".
- **Map states**: free only if the bit is clear AND `remaining() > 0`; "Sold out" when remaining is 0
  with bits free; "Sales closed" when it is 0 for the cutoff or a cancellation, never "sold out".
- **Relay**: refuses a seat move into a held seat (per-seat holds, new), and refuses `setSupply` on a
  seated series (the dashboard hides the control). Held / release replaces capacity for seated events.

## Organiser experience

Two routes, chosen first (owner, 2026-11-03). Create event opens on the seating choice:
"General admission - standing or unreserved, you set how many" / "Allocated seats - buyers pick their
seat on a plan you draw". Both choices are drawn by the seat renderer, not icons.

- General admission: today's flow, untouched.
- Allocated seats: Details > Seating plan > Prices > Check and publish.
  - Seating plan: your plans / start from a layout (live thumbnails) / blank room, then the full-screen
    builder (prototype v3.1: free placement, palette, on-canvas handles, selection bar, paint step for
    bands / held / wheelchair / no seat), autosave, "Preview as a buyer", seat count always in view.
  - Prices: one row per band (seats, price, the existing fee preview); "Add standing tickets".
  - Check and publish: "412 seats (16 held, 4 wheelchair spaces). Seats can't be added once tickets are
    on sale."
- Switching route keeps both routes' work in the draft and hides the other; only publish discards it.
- The builder works on a phone (templates, tap-to-add, steppers), with a note that a larger screen is
  easier. Most incumbents' builders are desktop-only.
- After publish (dashboard): hold / release seats, change a buyer's seat (organiser-signed, relayed),
  "put back on sale" for a seat a move freed, seat on every order row. Copy names the event action,
  never chain words.

## Buyer experience

- The map is the page. Price bands are tone + texture (solid, grey, outline, hatch, dots, dashed); the
  one colour on the map means "your seats". Taken seats stay drawn, dimmed. Readable without colour.
- Phone: sections first ("Stalls  £22-28"), tap in for seats (28 px minimum targets); a bottom bar
  "2 seats  £44  Hold", pulled up for detail. Desktop: map left, order right.
- Tap seats, or "Find the best 2 seats", which says why ("Row D, centre, 4th from the stage"). Price and
  wheelchair filters. A lone-seat note advises, never blocks.
- Wheelchair spaces sell like seats after a confirm step; the organiser marks companion seats.
- Hold clock in the bar, a quiet warning at 2 minutes; on expiry the picks stay with "Hold again".
- Arrow keys walk a row; every seat has a full spoken label.
- Same renderer and picker in the app, on organisers' websites (themed from the site's tokens) and in the
  embed; on a phone the embed opens the map full screen. The renderer is its own lazily loaded chunk,
  outside the 51 KB embed bundle, with section-level drawing above a few thousand seats.

## Build order

Each slice is one PR. Fable signs off S2, S4, S5 and S6 (server, money path, door, signing).

1. **S1 shared**: seat-plan schema + validation, canonical walk + golden vectors, geometry, best seats,
   `woco.seatstate.v1`, `cardOrderAmountsMulti`, manifest `seatPlan` validation, topics, the flag.
2. **S2 builder + create**: renderer package, Svelte builder (port of the prototype), plan library feed,
   the route fork, Prices and publish check; server seated create (re-derive, pin, `registerSeatedEvent`,
   `seated` + `planDigest` on the registration record).
3. **S3 buyer map**: picker in the app, site runtime and embed; direct Swarm + chain reads; the live
   holds route.
4. **S4 money path**: per-seat holds, multi-band checkout, hold extension + expiry handler, seated mint,
   receipt parsing, revert decoding, seat in the sale record and email.
5. **S5 door + tickets**: door pack `seats[]`, scanner refusal + label, seat on the passport and ticket page.
6. **S6 dashboard**: held / release, seat moves through the relay, confirm freed seats, relay refusals.

Before the flag flips: scanner deploy, a site runtime release (organisers republish), the
`onchain-events.json` rollback note for the new fields, `docs/legal/DATA_INVENTORY.md` + privacy-notice
line (the seat is order data), CSP `connect-src` for the map's chain RPC.
