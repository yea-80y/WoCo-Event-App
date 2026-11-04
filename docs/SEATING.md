# Allocated seating

Status (2026-11-04): S1 to S5 built, S6 planned. Seated events stay off behind
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
| Layout library (`woco.seatlayout.v1`, band names, no prices) | `woco/seating/layouts/{address}` index + `woco/seating/layout/{address}/{id}` | organiser feed signer | yes, never touches live events |
| Event plan (items, bands, canonical seat list) | content-addressed blob, `woco.seatplan.v1` | committed by the manifest digest | never |
| Band prices | event feed, beside `series.payment` | organiser feed signer | no (fixed at publish, as today) |
| Held seats + confirmed seat nonces | `woco/event/{eventId}/seats`, `woco.seatstate.v1` | organiser feed signer | yes |
| Who holds which seat | ledger2 `seatOf` / `seatWord` | chain | by organiser-signed moves only |
| 10-minute holds | server reservation store | server | ephemeral |

Code: `packages/shared/src/seating/` (import `@woco/shared/seating/index`): layout.ts, plan.ts (the walk,
freeze, bytes, digest, parse), template.ts (manifest link), state.ts, geometry.ts, best.ts, topics.ts,
templates.ts (starting layouts). Every number is an integer, so all three formats are statement-safe JSON.
Ceilings: 200,000 seats a plan (structural, not a product limit), 8 bands, 12 MiB a plan blob (a 200,000-seat
plan measures 8.5 MB).

Decided before the format freezes (Fable sign-off, 2026-11-03): numbering is consecutive or in twos
(`numberStep: 2`, odd or even sides of a house); 8 price bands per plan, one fill each (more would need
hue, which the map does not use for meaning); labels that print alike are the same label (NFC, case and
spacing ignored; no outer spaces or invisible characters). A plan is stored ONCE, on the event's batch
(no Etherna + WoCo double copy, owner 2026-10-21): an Etherna event's map can take a few minutes to
reach our gateway.

Seat-list rules: canonical walk of the plan, versioned, golden vectors; label parts structured
(`{ section, row, seat, table }`), never a pre-rendered string; `accessible: false`, never `null`
(statement values refuse null); `seats` = manifest `totalSupply` = registered supply. Every reader
checks `digest` against the fetched bytes; a plan that reads absent on the money path fails closed.
The event copy keeps the library plan id (read-only) so an organiser can see where it came from.

## Selling a seat

As built (S4, Fable consult 2026-11-04, 61/61). Code: `server/lib/seating/{seated-reserve,seat-check,
seat-reads,seated-checkout}.ts`, the seated half of `lib/event/reservation-store.ts`, `fulfilment.ts`.

- **Reserve** `{ seats, planDigest }` for a series registered seated; refused for a plan other than the
  pin. The plan is found through the manifest's `seatPlan.ref` and trusted only for the pinned digest.
  ONE chain read (event views, the seats' words and nonces), then the buyer map's own rules plus our
  minted seats (`ticket-sales.json`, a lagging replica's cover); under the series lock, no other live
  hold and no seat paid for in the last 10 min (a mint not yet visible, or unresolved), `count <=
  remaining - held`, the per-IP cap by seats. A 409 lists the conflicting seats. The hold pins each
  seat's label, band and price, and the fee settings; its reply (`SeatedHold`) is the only price a page
  shows. The same browser asking for the same seats gets its hold back unchanged while checkout would
  take it (prices and fees current, under the session cap); otherwise a fresh hold.
- **One payable session per hold.** Checkout prices from the hold (refused if the feed's band prices or
  fee settings differ): one Stripe line per band, the cover fee one order line, our fee on the subtotal
  (`cardOrderAmountsMulti`; rates stay in `PRICING_AND_EMAIL.md`). The session gets Stripe's floor
  (30 min + 2 min skew); the hold runs to its `expires_at` + 5 min. A hold with an open session is never
  released without closing that session at Stripe first (a new checkout, a new hold from the same
  browser, the release route): `complete` = a sale, kept; Stripe unreachable = 503, nothing released.
  At most 3 sessions per hold. `checkout.session.expired` ends the hold bound to that session id,
  unless checkout closed that session itself to open the next. A refusal that ends a hold's use
  (`SEAT_HOLD_LOST_CODES`) takes every page back to "Hold again", the seats still chosen.
- **Mint** from the hold record only: fulfilment claims it synchronously before its first await (bound
  to this session, pinned plan, count = paid quantity) and keeps it in force while it mints (bounded,
  20 min). A lapsed hold still mints if nobody else held or bought its seats. Anything else refunds in
  full, never a substitute seat. One `batchClaimSeatsBearer`, all or nothing; each slot's seat is the
  one asked beside its owner, checked against `SeatAssigned` when the receipt is in hand. Then the hold
  is settled: minted, unresolved (kept off sale, #994), or not minted (seats back at once).
- **Sale record** `seats[]` beside `slots` is the seat AT MINT; where a ticket sits now is `seatOf`.
- **Health** `reservations`: hold file unreadable (seated sales paused), seated holds running out with
  no expiry event seen, a seat recorded differently from the one asked.
- **Refunded seats** keep their chain bit set: unsellable until reissue exists (#983 step 5). The map
  shows them unavailable.
- **Door** and tickets: see "Door + tickets (S5)".
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

Each slice is one PR. Fable signs off S2 to S6 (server, CSP and cross-origin messages, money path, door, signing).

1. **S1 shared** (built): layout + plan schemas and validation, the walk + golden vectors, geometry, best
   seats, `woco.seatstate.v1`, manifest `seatPlan` link, topics, starting layouts, the flag.
2. **S2 builder + create** (built): `@woco/seatmap` renderer, the builder (`apps/web/src/lib/creator/seating/`),
   the route fork (`AdmissionChoice` in `EventEditor`, so the site builder and `/create` both have it), the
   seating section (prices, fee, name on tickets); plan upload (`POST /api/seating/plans`); seated create and
   registration (seatedness from the manifest, `registerSeatedEvent`, `seated` + `planDigest` on the
   registration record); compact `editionCommon` with a 200,000-editions-per-event ceiling.
   The LAYOUT LIBRARY moved out to its own slice: a saved layout is a multi-chunk feed, and a large venue's
   would meet the SOC relay's per-account limits. Until then reuse = templates, plus (next) "start from an
   earlier event's plan", which needs no new storage: those plans are already content-addressed.
3. **S3 buyer map** (built; design consult 2026-11-03, Fable 68/68): see "The buyer map (S3)" below.
4. **S4 money path** (built): see "Selling a seat". Hosts: `SeatedSeries` holds, the host page's
   ClaimButton pays (`hold` prop); the embed widget holds from its frame and runs its own checkout.
5. **S5 door + tickets** (built): see "Door + tickets (S5)".
6. **S6 dashboard**: held / release, seat moves through the relay, confirm freed seats, relay refusals.

Carried into later slices from the S1+S2 sign-off: S6 sizes seat-state writes against the SOC relay's
per-account limits (a 200,000-seat state is ~50 KB). (Done in S4: a recovered registration is recorded
only if `isSeated` agrees; reserve reads words and nonces in one multicall.)

Before the flag flips: scanner deploy, a site runtime release (organisers republish), a server deploy
(embed `?v=25`), the `onchain-events.json` rollback note for the new fields,
`docs/legal/DATA_INVENTORY.md` + privacy-notice line (the seat is order data: holds, sale records,
ticket email). The app's CSP already allows the map's RPC (`arb1.arbitrum.io`). Done:
`checkout.session.expired` on the live connected-accounts webhook endpoint (2026-11-04; health
`reservations` goes red without it).

## The buyer map (S3)

One picker for every host: `@woco/seatmap` (`buyer.ts` model, `view.ts` camera, `picker.ts` SVG,
`load.ts` reads, `svelte/SeatPicker.svelte` the full-screen view). The app and websites mount it from a
seated ticket type's card (`apps/web/src/lib/components/seating/SeatedSeries.svelte`); routes
`#/event/:id/seats/:seriesId` (app) and `#/events/:id/seats/:seriesId` (websites). Seat rules are
`@woco/shared/seating/availability.ts`, shared with the server.

- **What the map checks** before drawing: the manifest body's digest (recomputed, never the blob's own)
  equals the ledger's `manifestRef`, `isSeated` is true, the plan's bytes hash to the digest the manifest
  names, and the plan validates in full (in a Worker above 20,000 seats). Otherwise it refuses to draw.
  Chain unreadable: the plan draws, nothing can be picked. Our server down: holds unknown, the map still
  draws. Plans come from our gateway only.
- **Chain reads**: a hand-written Multicall3 `aggregate3` (`shared/chain/multicall.ts`, byte-identical to
  viem, tested in `apps/web/test`); every batch carries ArbSys `arbBlockNumber` and every value keeps the
  highest block it was read at, so a lagging replica never un-sells a seat. A picked seat's `seatNonces`
  is read in the same batch as its word. Refresh: the words on screen + picks every ~20 s while visible,
  a full read every ~2 min, back-off on 429. Measured on the public RPC (2026-11-03): one 256-word batch
  in ~380 ms; 40 refreshes back to back from one address, none limited.
- **Live holds**: `GET .../held` lists `seats` for a series registered seated: active holds plus seats paid
  in the last 10 minutes (a replica may not show the mint yet). Indices only, the same for every caller,
  `Cache-Control: public, max-age=5`.
- **Freed seats**: the map does not read every seat's nonce (no bulk view); the reserve check (S4) is the
  gate, and a refused seat comes back in the 409 and is marked.
- **Embed**: the widget opens a full-screen frame on our API origin, `/embed/seatmap/:eventId/:seriesId`
  (own CSP: our API, our gateway, the Arbitrum RPC; worker-src 'self'), running the same SeatPicker
  (`woco-seatmap.js`, a separate build). The widget keeps holds and checkout; they talk through
  `packages/embed/src/seatmap-bridge.ts` (exact origins both ways, versioned, shape-checked). Inside the
  iframe embed the map opens in the app instead.
- **Accessibility**: every seat is a button with its reason spoken ("sold"); one roving tab stop, arrows
  walk a row, a live region for every change, Escape closes. A tap on a seat too small for a finger zooms
  in instead of picking.
- **Scale**: above 2,500 seats the map shows sections until seats are both visible (7 px) and few enough
  on screen (4,000); only on-screen blocks are drawn. On a mid phone (4x CPU throttle, 20,000 seats):
  sections in ~3 s, a section's seats ~0.6 s, best seats ~1 s.

Departures from the consult, all accepted at the S3 sign-off (Fable 73/73, 2026-11-03, changes applied):
seat nodes stay ~3 per seat (the 4,000-seat draw budget bounds the DOM; a tap rebuilds only the block it
changed, ~0.4 s on a 4x-throttled phone at 1,250 seats); the organiser's seat-state feed is read from S6 (its
storage layout is decided there; until then the plan's held flags); the picker reports taps and the host owns
picks (`canPick` from the host serves S6's dashboard). Open: #1087 (the parse Worker is cross-origin on
woco.eth.limo, so plans above 20,000 seats parse on the main thread there).

S4 met each of these (see "Selling a seat"): holds by seat on the pin, deduped by seat set; the seated
refusal lifted behind the flag (`seated-sale.ts` is now the flag-off refusal, and the agent rail's);
SeatPicker's `onhold` + `checkout`; the widget's `canHold: true` and `hold` / `refused`; the hold extended
to the session and released on `checkout.session.expired`; no eager hold for a seated series.

Departures from the S4 consult, for the S4 sign-off by name: D1 the fulfilment pin is bounded (20 min, so a
process that dies mid-sale cannot hold seats for good); D2 no resale `rail` marker in checkout metadata yet
(absent = primary works the same when #13 lands); D3 no per-band minimum-fee check at publish
(`MIN_TICKET_PRICE` 1.00 already gives 2p of fee per seat); D4 the seat on the #983 resend copy moved to S5.
The sign-off (Fable, 2026-11-04) accepted all four and E1-E11; its fixes are in: one off-sale rule for the
map and the hold check, a session checkout closed itself not ending its hold, the fee settings pinned
like the prices, the hold re-read before a new session, and no hold handed back that checkout refuses.

## Door + tickets (S5)

Incumbent look first (wallet passes, Ticketmaster, AXS, Humanitix, UK theatre systems), then a design consult
(Fable 67/67, 2026-11-04). A seat is shown as PARTS - Section / Row / Seat, or Table / Seat - never one
sentence (`@woco/shared/seating/ticket-seat`: `TicketSeat`, `ticketSeatFields`, `isTicketSeat`; the one
sentence, `ticketSeatText`, is for email text and screen readers). "Wheelchair space" / "Companion seat"
print as a note, as incumbents print them in the ticket type. Code: server `lib/checkin/{slot-owners,
slot-state,pack-series}.ts`, `lib/seating/ticket-seats.ts`; scanner `scanner/verify.ts` (`doorSeat`).

- **Door pack, version 2** (`CHECKIN_PACK_VERSION`). Per seated series: `seated: true`, `seats[]` per slot
  (seat index, `NO_SEAT_INDEX` -1, or `null` = not read) and `seatLabels[]` (display only, from the pinned
  plan). The seat decides admission; a missing label never refuses ("Seat not shown"). Owners are
  `null` where not read too, so an RPC failure is "couldn't confirm", never "no ticket" (it used to be: a
  failed read and an unclaimed slot both came out "", which the scanner turned red).
- **One slot cache** for every contract (`cachedSlots`): fresh for 30 s after a full read, new slots
  always read, a failed slot keeps what it last read for up to 10 minutes after that read and is read
  again on every pack (an RPC blip does not stop the door; past the bound it is "couldn't confirm", so a
  long outage never admits on an owner or seat since moved), highest block wins. Ledger2 reads owner + seat per slot in one
  Multicall3 batch (512 slots) with ArbSys `arbBlockNumber`; older contracts keep one call per slot.
- **Seated or not at the door** = the registration record AND the ledger's `isSeated` (read once, fixed
  at registration). They disagree (an older build dropped the record's seating fields, or a record is
  missing): the series goes out seated with no seats, the scanner refuses its tickets as "list out of
  date", and `/api/health` `doorSeats` is red. Never the manifest or the feed.
- **Old scanners**: a scanner sends `X-Scanner-Pack: 2`. Without it, `/pack` for an event with a seated
  series, and `/claim` for a seated series (or with the registrations unreadable), answer
  `outdated-client`, which scanners since #641 turn into a self-update. `/sync` is never refused.
- **Scanner**: order is owner + signature, then refunded, then seat: `-1` = NO SEAT (red, no check-in
  recorded, like a refund), `null` or no seats = "couldn't confirm" after one refresh, never red. The
  roster's manual check-in applies the same rule (`doorSeat`) and lists each attendee's seat. CHECKED IN
  and ALREADY IN lead with the seat as large labelled fields; a seated card stays 4 s.
- **Tickets carry the seat they were issued in**, as display data like the title: the email rows, each
  card image (a seat band above the tear line; a seated card's photo is shorter so the QR keeps its
  size), and each ticket link (`sa`/`sr`/`sn` + `st`/`sw`/`sc` flags, validated on read, dropped just
  before the title when the link runs long). The static page prints the seat as real text and in Save
  image. Fulfilment takes the parts from the hold (`SeatedHoldSeat.ticketSeat`, pinned at reserve).
- **Where a ticket sits NOW** (`currentTicketSeats`: `seatOf` + the pinned plan, all or nothing) is what
  the #983 resend prints (refused 409 if the ticket has no seat now, 503 if unreadable - never the seat at
  mint) and what the organiser's undelivered list shows. No new sealed format: the seat is public (chain
  + plan), the sealed copy exists only because the QR exists nowhere else.
- **Passport** (Profile tab tickets, Home "Next up"): `/attendee-gate/status` marks a binding `seated`
  from the registry (zero I/O, it answers on every app load); the passport then asks `GET
  /attendee-gate/seats` (current seat, null when none or unreadable) only with a session already on the
  device. The stub's tear-off end shows "Seat 7", the main column "Stalls, Row D". Only the bound ticket
  of a group order is shown (friends bind their own).
- A move (S6) leaves printed seats stale by design: the door reads the live seat, and S6's move sends the
  buyer the ticket again with the new seat (same QR). Nothing printed hedges the seat.

Departures from the S5 consult, for the S5 sign-off by name: D1 a failed slot read keeps its last value
for up to 10 minutes (`STALE_MAX_MS`) instead of reading `null` at once, so an RPC blip mid-event does
not stop the door (an automated security review flagged the first, unbounded version; the bound is its
fix); D2 general-admission series on older contracts keep the per-slot reader but
take the `null` = not read fix now (it was live for GA); ledger2 GA series already use the batch reader
(needed for the `isSeated` agreement); D3 no `reason` variant on `sendTicketEmail` yet - S6 adds it with
its caller; D4 `isSeated` is remembered once read (fixed at registration) rather than read per pack; D5 a
seated record on a contract with no seats is treated as a disagreement (refused). Seam recorded: refunds
(`voidSlots`) are keyed per slot, so when #983 step 5 reissues a refunded seated slot to a new buyer the
new ticket would read REFUNDED - a void needs the sale's slot epoch then. `TicketSuccess.svelte` (an
in-app ticket download) has no importer: left over from the v1 claim rail, not changed.
