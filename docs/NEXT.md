# NEXT — the working order

The single ordered list. GitHub issues are the *what*; this is the *when*. If a plan only
exists in a chat message, it does not exist. Update this file when the order changes.

Last updated: 2026-08-04 (security workstream added — #139/#140 merged, recovery lockdown next).

> **Model routing (token efficiency):** the Owner column now names the cheapest model that
> can safely own the item. **Fable** = architecture, money paths, irreversible Swarm/batch
> writes, security. **Opus** = well-specified server/infra builds against a locked design.
> **Sonnet** = UI, mechanical fixes, ops chores. Rule of thumb: Opus/Sonnet build, Fable
> reviews the diff before merge on anything touching money or feeds.

> **2026-07-15 verify note (#46):** server confirmed running the expiry fix (container
> rebuilt 07-14). The affected site is `forkmate.co.uk` (siteId `mpir97al-8j1kx4g`):
> from OUR bee the content hash still serves (200, local cache — not durable) but the
> **feed manifest is 404** (died with the owner's expired user batch). Owner must
> re-publish from the builder; the re-deploy free-hosts onto the Etherna platform
> batch — which itself needs the 7b top-up decision first, or the re-publish dies
> again in days.

---

## #172 BANDING — open items (2026-08-19, branch `feat/credit-head-lookup`)

Two Fable sign-off rounds done. Round 2 verdict: merge after changes; those changes have
landed. Green: shared 196, web 403, server 735; server typechecks. NOT merged, NOT pushed.

**A claim in an earlier commit message was WRONG and is corrected here.** `b4a7faa` said the
root cause of the rollover defect was "also closed" by surfacing `bandClean`. It was not:
`bandClean` covered the BAND WALK only, while `readVersionedContentFeed` still dropped the
in-band scan's `clean` on its found path. So a clean band walk plus a dirty version scan could
still land a stale snapshot at the real latest version — VERIFIED, with every subject added
since erased. Now genuinely closed: `scanClean` is threaded onto found reads and `bandClean`
means the whole resolution.

**Two more erasure paths found in round 2, both fixed:** `removeFromSubjectIndex` (credits)
and `addToSubjectIndex` (social) were read-modify-writes with no dirty-resolution check — the
same class the branch had just closed in `upsertSubjectBand`, left open in its siblings.

**The `recordRide` question is RESOLVED as a non-defect** (option 4). A lap is an
EXACT-ADDRESS write, so any staleness targets an address that already exists: Bee dedupes,
the read-back reports `superseded`, and the retry rail handles it. A mis-banded lap is never
written, and the not-writing is detected. Refusing the tap would fail the product's core
moment to defend a harm that is already converted into detect-and-retry. The rule is recorded
at `attemptRide`: **exact-address writes may proceed on an inconclusive read because the
read-back guards them; read-modify-write snapshot writes must refuse.**

| # | Item | Owner | State |
|---|---|---|---|
| 1 | ~~Finding 5 — scan-first resolution~~ **DONE, signed off** | — | Built with TWO measured deviations from the spec, both confirmed sound on review. (a) A last-slot probe on WALK-UP iterations only: the spec as written rescanned every full band on the climb, costing 542 probes against 256 on a cold six-band feed. (b) A `maxVersion` ceiling on banded scans — versions above the last slot cannot exist by construction, so probing them was two guaranteed missing-chunk searches per full-band scan. Result: warm reads probe ZERO openers; cold six-band is 80 probes / 2 misses vs walk-first's 13 / 2 — **misses equal**, extra cost is cheap hits paid once per device. Pressure valve if the browser re-run says the cold band-0 scan is material: apply the last-slot probe to the first band too when entry is provably cold (`hintBand === 0`, no stored hint). Recorded, not built. |
| 2 | **`BANDED_FORMATS` fails OPEN against undercounts** | Opus | A new banded format added to `INDEXABLE_FORMATS` but forgotten in `BANDED_FORMATS` reads as pinned — a silent 64-write tally cap, no hang, no failing test. Needs an exhaustiveness assertion tying every indexable format to an explicit banded/pinned declaration. |
| 3 | **`indexSubject`'s default reader is never exercised** | Opus | Every test injects `readFeed`. This is the same fixture-hides-the-real-reader shape that let the non-terminating walk ship. |
| 4 | ~~Browser re-run of the measurement~~ **DONE 2026-08-20 — ACCEPTANCE FAILS** | — | Full numbers in COASTER_CREDITS_PLAN. Cold-read misses **14 → 26 → 36** at 3 / 109 / 147 laps where the model said flat at ≤6; warm-read misses 14–17 against ≤3. The write path is FINE (tap on a loaded card = `735ms · 0 probes`); all of it is the read. Two causes, both filed: **#329** the gateway 403s absent addresses so the `404` short-circuit never fires and every absent probe pays a dead ~2-3s server call; **#332** whitelisting FAILS under concurrent writes and is swallowed, so freshly-written chunks 403 until a slow read repairs each one — which is why it was invisible. Stayed BLOCKING for launch, and now has numbers behind it. |
| 5 | ~~Gateway whitelisting + absent-probe cost~~ **DONE 2026-08-20 — cold read 15.2s → 3.4s** | — | ✅ #332 (whitelist calls were being rate-limited by a broken IPv4-mapped-IPv6 check) and #329 (slow, untrusted 403) both fixed and deployed. Full numbers in COASTER_CREDITS_PLAN. Residual is the in-band walk, which is lever 3 and not urgent. Original note kept below. |
| 5b | Detail retained from item 5 (now done) — read for the reasoning, not as open work | — | ⚠️ It is ALREADY synchronous: `soc-upload.ts:231` awaits it before write-accept. The defect is that it is UNGUARANTEED — failures are swallowed at `:233` and it fails under concurrent writes (**#332**, measured). Fable ruling: do NOT simply make it fatal-after-upload, that mints an orphan chunk whose retry double-counts a lap; whitelist the address BEFORE upload (it is computable from `calculateSocAddress` without uploading). A 403 may only be trusted as absent once the proxy TAGS its whitelist denial distinguishably — a raw status cannot tell a whitelist 403 from a WAF 403 — and `whitelist.json` then becomes data-plane state whose loss reads every chunk as a clean absent: add it to the must-survive list. Original note follows. Whitelist-lag false-absents read as CLEAN, so they bypass every `clean`-based guard in this branch. `hintInvalidated` is the tripwire — confirm before tuning. **Two additions from the finding-5 review:** (a) the scan ceiling changes an overshoot from transient to PERMANENT — a version above the last slot is now invisible to every banded reader rather than merely unrolled-over. The creation paths are closed, but `writeContentFeed`'s internal resolve is still unbounded; completing this means threading the ceiling into banded probing WRITES as a refusal. (b) An absent banded feed now costs 2 misses where the walk cost 1, because the first window probes v0 and v1 together — this runs on every `liveVisibility` for the partition that does not exist, i.e. most riders pre-publish. One-line fix: probe v0 alone when starting from 0 with no validated hint. |
| 6 | Declare banded-vs-pinned per format in `packages/shared` | Opus | A third-party indexer builds from shared and cannot see `BANDED_FORMATS`, which lives in `apps/server`. Non-blocking. |
| 7 | Gate B (emblem rail) implementation | — | Designed in SWARM_SOCIAL_PLAN; nothing frozen is needed for it. Not started. |

**Still open on the server:** `readBandedContentFeedJsonResult` got the scan CEILING but not
scan-first — it still walks openers before scanning. Lower stakes than the client (the indexer
is not on a rider's critical path) but the same win is available.

**Process lessons from this branch, worth not repeating:** the test suites were green through a
resolver that never terminated (the fixture replaced the real reader), through four type-level
defects, and through two snapshot-erasure paths. `svelte-check` is slow here and was run late.
A patch script using `replace()` without asserting the pattern matched silently no-opped and
reported success. A commit message claimed a root cause was closed when it was two-thirds
closed — the same "reported done, never happened" shape as the bugs themselves. And the hint
instrument was regressed a SECOND time by the finding-5 rewrite, counting off `clean` so that a
cold read and an invalidated hint both reported as healthy — the alarm could not fire on the
very feeds it was installed to watch. An instrument that cannot see its own pathology fails
silently, and probe counts cannot reveal it, because the counter is the broken part.

## Security workstream — passkey / accounts (added 2026-08-04)

Runs alongside the table below; separate lane, separate worktree. **Do the top undone item.
Anything else found goes to a GitHub issue, not into the current branch.**

Rows are ONE LINE: issue number, owner, state. If a row needs a paragraph, it belongs in the
issue — `gh issue view <n>`. No detail here, or the two sources drift and neither is trusted.

| # | Item | Owner | State |
|---|---|---|---|
| **S1** | #139 + #140 — passkey ceremony safety + embed silent-mint | Claude | ✅ Merged `ae23a49` · frontend DEPLOYED by owner 2026-08-09 |
| **S2** | Recovery subsystem review + fixes | Fable reviews / Opus fixes | ✅ **DONE.** 8 PRs merged 2026-08-09: #208 #211 #215 #218 #224 #225 #232 #235. Server DEPLOYED, frontend DEPLOYED. Index: **#168** |
| **S2b** | ~~#165 "Remove all backups"~~ ✅ **DONE + MERGED** — a real revoke-all, proven by a block-pinned read-back. **#164 (own caller hook, per-guardian revoke) is DEFERRED BY DECISION** — see the ruling below | Fable | #165 done · #164 deferred |

---

## ⬅️ THE ORDERED LIST — start here (2026-08-09)

The security work spawned 29 open issues. This is the order, and the reason. **Do the top
undone item.** Everything below tier 1 is real but does not gate launch.

**TIER 1 — before launch, in this order**

| # | Why it is here |
|---|---|
| **#212** | A free organiser account can run JS on the app's ORIGIN and read every visitor's session key + POD identity. Unsanitised `{@html}` in RichTextSection/EmbedSection, same origin as the app. Costs nothing to exploit, hits everyone. **Worst on the board** |
| **#216** | `POST /api/domains` accepts any `siteId` with NO ownership check. An attacker binds their hostname to your site; your next deploy mirrors your content onto their phishing domain |
| **#209** | The ERC-6492 fallback bypasses the kernel-deployed gate, so a retired key still authenticates — it **defeats the #208 fix already deployed today** |
| **#219** | Three rate limiters still derive their own client identity with no normalisation. IPv6 /64 rotation mints unbounded buckets on the PAYMENT routes |

**TIER 2 — before launch if time, otherwise immediately after**

#234 (cross-device credential collision — specced + Fable-reviewed, ready to build) ·
#161 (guardian config drift would silently kill EVERY installed backup, discovered only at
recovery time) · #236 #237 #238 (recovery residuals from the #235 review) · #157 (guardian
index poisoning + Kernel↔backup-EOA privacy leak) · #163 #210 (unbounded server caches)

**TIER 3 — hardening and hygiene, not blocking**

#138 residue · #156 · #158 · #159 · #160 · #166 · #167 · #213 · #214 · #217 · #220 · #221 ·
#222 · #223 · #231 · #239

**DEFERRED BY DECISION — do not start without revisiting the ruling**

#164 (own caller hook) · #145 implementation · #57

| **S3** | #146 — strict CSP + supply-chain pinning | Opus | Not started |
| **S4** | #143 — embed `signClaimDigest` throws; then #144 — embed typecheck in CI | Opus | Not started |
| **S5** | #145 **research only** — (A) does root-validator swap preserve the address? (B) does `@zerodev/webauthn-key` drop the hosted-server dep? | Fable | Not started |
| **S6** | Passkey docs audit — collapse 8 overlapping docs to one authoritative | Sonnet | Not started |
| **S7** | Login-surface review — S2 covered RECOVERY only. web3, coinbase, local and the web3auth login path have NOT had this treatment | Fable | 🔨 In progress — filed #174 (the #149 guard was inert for web3auth: `_podAddress` is a passkey-only field, so it read null and never fired). Fixed on `fix/recovery-lockdown` rather than a separate branch, to avoid a conflict in `auth-store.svelte.ts` |

**Owner-held, not Claude's:** #119. **Do not reopen:** #145 implementation, #57.

**S2 review outcome (2026-08-04).** The design held: guardian pinning enforces (an unregistered
caller reverts `"not allowed"`, verified on-chain), the escrow crypto is sound, guardian
derivation is not forgeable, both singleton addresses are real. The failures were all at the
edges, in four repeating shapes: **no way to undo a grant** (#148); **"couldn't tell" treated as
"definitely not"** (#138, #154, #155); **never checking whether an operation succeeded** (#151,
#152); and **a guard written for passkey that didn't cover web3auth** (#149). Six findings would
actually harm a user (#148, #149, #150, #138, #151, #152); the rest are hardening and honesty.

**Not yet true, do not assume otherwise:** recovery has only ever been tested on the happy path —
no failed-recovery test exists; the guardian evidence is `eth_call` simulation against a real
account, not an executed install-then-attack; the other login kinds are unreviewed (S7).

**ARCHITECTURE RULING (Fable, 2026-08-04) — `auth-store.svelte.ts` is 2456 lines.**
Do NOT restructure it on a security branch: the lines a refactor would move are the same lines
the security fixes edit, and `apps/web`'s test harness **cannot execute `.svelte.ts` rune modules
at all** (`$state` needs the Svelte compiler; `tsx` won't transform it), so a refactor there is
eyeball-reviewed only. **Freeze rule while S2 is open:** all new logic goes in NEW files
(`backup-management.ts` etc.), auth-store gains only thin facade delegations.
Then a dedicated `refactor/auth-store-split` branch — **trigger: after the live recovery test
passes, and BEFORE the next auth feature branch opens** (the web3auth guardian-escrow work would
otherwise grow the file again). Target ~13 files of 100–350 lines; the public `auth` API and the
`auth-store.svelte.ts` filename never change, so none of the 64 importing files move. Sequence:
characterisation tests → pure-move commit (bindings, kaddr cache, sdk-prefetch) → the state
module alone in its own commit → one cluster per commit. Verify each with
`git show --color-moved=dimmed-zebra` (rule: zero bright lines outside imports/exports) plus
`npm run check -w @woco/web`. Note `git -M` will NOT show a partial extraction as a rename.

---

## Now — in flight

| # | Item | Owner | State |
|---|---|---|---|
| **0000** | **Claim-feed paging + lenient-read hardening.** Claimers paged (#112, merged). Pending-claims paged + one per-series write queue + strict reads on the write path (PR #117) — also fixes reject clearing a slot it no longer owns, and the blank-claims-page fallback in approve/reject. **Then, in order:** #113 (`claimTicket`'s slot scan treats an unreadable claims page as empty — wipes claims + double-assigns editions; hot money path, own review), #114 (same lenient-read hole in `claimers-feed.ts`, + extract the shared page applier), #115 (approve/reject rewrite claims pages outside `queueSeriesClaim`), #116 (agent rail bypasses that queue — latent, crypto rail off). **Deploy state:** #110/#111/#112 are LIVE — server synced 21:03 UTC + container restarted 21:10, frontend feed published 21:11:55 UTC at index 115 (`f84c7dc3…`), all 2026-08-01. **#117 is merged and NOT deployed** — server-only, so it needs STEP 1 but no frontend deploy; same for #113 once merged. | **Fable** (money path) | #117 merged `ce81f0e`; #113 built, awaiting Fable review |
| **000** | **Pre-launch review follow-ups — ✅ MERGED (PR #89) + server DEPLOYED 2026-07-29.** The full stack (#80 consent dead-end, #82 broadcast hardening, #83 Art. 17 erasure + store durability, #81 code half, #85 payout follow-ups, #84 currency restriction, #87 warning) landed as one squash on main; health shows the new `heldPastCeiling`/`pendingScheduleHeals`/`compliancePersistence` fields live. **REMAINING FOR THE OWNER — none of these can be done from the repo:** (a) `RESEND_FROM_MARKETING` on its own subdomain, added in the Resend **dashboard** (the production key is send-only, so the API path 401s), then env + STEP 2; (b) confirm the Resend webhook endpoint targets `events-api.woco-net.com/api/resend/webhook` with `email.bounced` + `email.complained` subscribed; (c) **create the `privacy@woco-net.com` mailbox** — it is now written into the published Privacy Policy, Cookie Notice and DPA, and Art. 12(3) starts a one-month clock the moment someone writes to it; (d) **configure log rotation** to match the 30-day period now STATED in PRIVACY_POLICY §10 (docker `json-file` rotates on nothing unless `max-size`/`max-file` are set; check Cloudflare's retention against your plan) — DATA_INVENTORY §8 item 3; (e) schedule `scripts/backup-data.sh` on the VM with `BACKUP_DEST` pointing OFF the VM; (f) **frontend deploy — still pending**, and it now also carries the #78 marketing UI + checkout-consent wiring (live bundles checked 2026-07-28 predate all of it). | **Claude** built+merged+server-deployed; owner owns (a)–(f) | ✅ Merged; frontend deploy outstanding |
| **00** | ✅ **BUILT 2026-07-27 — manual payouts + post-event release shipped.** `interval:"manual"` at account creation + self-healing on `account.updated` + per-sale hold ledger + hourly release sweep + `GET /api/stripe/payouts` + audit script + 25 tests (server 66/66). **Mechanism/ops/limits: `docs/PAYOUTS.md`. Decisions: `PRICING_AND_EMAIL.md` §17.** **ALL STRIPE ASKS RESOLVED 2026-07-29 (chat + specialist email — `PAYOUTS.md` §3.2 + §6 carry the verbatim record):** application fee survives Managed Risk (in writing, twice); Express Dashboard CANNOT self-initiate payouts and schedule editing is not enabled — the manual schedule IS the lock, no support grant needed; payout schedules unaffected by Managed Risk; disputes debit the connected account first, unrecoverable remainder is Stripe's under `losses.payments="stripe"`. **#90 BUILT:** account creation now uses controller properties (`stripe_dashboard.type=express · fees.payer=account · losses.payments=stripe · requirement_collection=stripe` — `account-params.ts`, pinned by tests); `payout-schedule-audit.ts` flags platform-liable legacy accounts, `retire-legacy-accounts.ts` deletes zero-balance ones. Remaining ops: verify Radar on connected transactions (dashboard), retire the 12 legacy test accounts, fresh-account end-to-end run (onboard → checkout → release). Never onboard a real organiser on `type:"express"`. The **90-day per-charge hold ceiling** stands (early-bird/festival money releases BEFORE the event — #87 warns at series creation; Managed Risk carries the tail). Hardening shipped: PR #86 (intent journal, fresh nets, settlement currency) + #85 follow-ups, both deployed. Legal drafts remain accurate (not escrow): `TERMS_OF_SERVICE.md` §4, `ORGANISER_TERMS.md` §6, `DATA_INVENTORY.md` §5.2, `PRIVACY_POLICY.md` §10. | **Fable** (money path) | ✅ Built + hardened; #90 built — ops verification (Radar, retire legacy, e2e run) is the last gate |
| **0a** | **Email track** — `docs/PRICING_AND_EMAIL.md` §14 is the standalone list, unblocked by the Stripe questions. ✅ E0 ESP seam closed (`2eda035`, `lib/email/send.ts` — SES is now one provider file + one switch branch). **Ready now:** E1 `Reply-To` source for ticket emails (plumbed but nothing populates it — attendee replies go nowhere), E2 fix `MARKETING_DAILY_CAP` (flat 2,000/day blocks an organiser with 2,001 contacts from announcing an event), E3 decide the Stripe-receipt/ticket-email double-send. **User:** E4 message Resend (§9), E6 open AWS + **file SES production access early** (sandbox = 200/day, gates E7–E10). **Gated on §7 tier sign-off:** E5 entitlements store (`.data/entitlements.json`) — the keystone, nothing tiered ships first. **Then SES:** E7 provider (½d), E8 domain verification (2–3d, the real cost), E9 SNS webhook, E10 transactional sending domain. **Hard ordering rule: do NOT onboard any organiser custom sending domain on Resend** — 2 domains each, Pro caps at 10, and migrating means every organiser re-does their DNS. | **Opus** builds, user unblocks | Seam shipped; E1–E3 ready |
| 0 | **Marketing audience** — ✅ **PR #58 merged `3b1661e`, server DEPLOYED 2026-07-18** (Fable-audited ×2; /u + webhook smoke-tested live: bad token 404s, unsigned webhook ack-and-dropped). Remaining, in order: (a) **user**: Resend dashboard — add webhook endpoint `https://events-api.woco-net.com/api/resend/webhook` (email.bounced + email.complained) and set `RESEND_WEBHOOK_SECRET` in `.env` (+ STEP 2 deploy) — **bounce/complaint suppression is INERT until then**; (b) **user**: split `RESEND_FROM_MARKETING` onto its own subdomain BEFORE first cold-list send; (c) **user**: frontend deploy + browser-test the Audience flow; (d) ~~#59 abuse gate~~ ✅ decided+built 2026-07-18 (charges_enabled on broadcast+domain-create, StripeVerifyGate in Audience UI); #60 follow-ups still open; list blobs → #45 cutover (commented) | **user / Fable** | Server live; env + #60 pending |
| 1 | **Frontend deploy** (`npm run deploy`) — main carries #40/#51 client changes PLUS #52's builder gates + avatar fallback + client-side Etherna stamp routing **PLUS #37's discovery UI** (geo+genre pickers, facet filter, profile events log) | **user** | Server side live (#52 74a3872 2026-07-16, #37 bb1f284 2026-07-17); frontend is the lagging half. Deploy server **before** frontend ✅ done. |
| 2 | **Browser-verify #52** — free-hosting gate + quota + batch routing, after the frontend deploy | **user** | Watch `docker compose logs -f server \| grep -E "batch-router\|storage-ledger"`; ledger = `docker compose exec server cat .data/storage-ledger.json`. |
| 3 | **Verify #33** — door-scanner roster re-push, against the deployed server | **user** | Reopened: #40 auto-closed it on a keyword, but the fix was only hypothesised. |
| ~~4~~ | ~~Event directory rebuild (#37)~~ | — | ✅ **PR #54 merged `bb1f284`, server DEPLOYED 2026-07-17** (Fable signed off schema + past-events fix + 3 Sonnet frontend commits; build:server clean, shared 82/82, server 30/30, build:web clean). Cutover live: `/api/events` returns `[]` — test events filtered out as designed; real events return via one organiser `/list` each. Docs: `docs/EVENTS_DIRECTORY.md`. Remaining: user frontend deploy (item 1) + browser verify of pickers/filter/profile log. Old detail follows for reference: |
| ᶜᶫᵒˢᵉᵈ | (was) **Event directory rebuild (#37)** — chain-log truth + immutable snapshot + pointer feed | **Opus/Sonnet build, Fable reviews** | **Server BUILD + Fable's 5 fixes DONE + Fable-approved, committed on `feat/directory-snapshot-37` (7e516bb):** build:server clean, shared 81/81, server 30/30. Flow: push → PR → CI → merge → **server-only deploy** (Claude owns; API shape unchanged, NO frontend deploy). Cutover: public directory shows empty immediately; each event returns via ONE `POST /api/events/:id/list` from its organiser; 30-min janitor + instant-publish rebuild heal the rest. No rebuild secret (removed per Fable — final). **Discovery model LOCKED 2026-07-17 (Opus + owner):** location = structured coordinate-anchored `EventGeo` (ISO country vocab bundled + city/venue/lat-lng from a client-side OPEN geocoder at create time — NOT Google Places; `venueRef` reserved for future WoCo venue profiles); genre = controlled `EventTag` multi-select (15 terms, music sub-genres deferred to ride the same mechanism when data warrants). Schema + server plumbing shipped in shared/server (geo.ts, normaliseGeo, geo on EventFeed/create/update/SnapshotCard). **Past-events fix (Opus, committed `a6d6576` on branch — UNPUSHED, needs server redeploy):** the snapshot no longer drops events 24h after they end (attendee **Past** tab was going empty — bad UX while small), and a new PUBLIC `GET /api/events/by-creator/:address` (unauthenticated, rate-limited, never-trimmed creator index) powers a per-organiser history log on the profile from today; scale path documented in code (move past events off the global blob once it grows). **Fresh chats next (all Sonnet, frontend-only, branch off `feat/directory-snapshot-37`):** (a) creator tag+geo picker in event create/edit — geocoder selection ALSO auto-populates the free-text `location` display field (editable); (b) discovery facet filter UI on the directory (country/genre/near-me, client-side over `SnapshotCard.tags`/`.geo`); (c) organiser profile events log — switch `ProfilePage.loadEvents()` public path to `by-creator`, split past/upcoming. Do NOT build a Swarm append-log. Subsumes "fresh directory feed" below (pointer cutover filters test events). |
| ~~—~~ | ~~Merge PR #51 + deploy~~ | — | ✅ merged, live 2026-07-14 |
| ~~—~~ | ~~Batch routing (#48) + free-hosting gate (#44 stages 1+2)~~ | — | ✅ **PR #52 merged `74a3872`, server DEPLOYED 2026-07-16.** Cutover (#45) still open. |
| ~~—~~ | ~~Merge PR #46~~ | — | ✅ merged `d36a88c` |
| ~~—~~ | ~~Close #42~~ | — | ✅ closed — profile already client-signed |
| ~~—~~ | ~~Merge PR #40 (exactly-once registration) + #49 (docs)~~ | — | ✅ merged `edb6993` / `0dfc729`; **server deployed**. Closed #36, #14. |

## Next — cut over to production

The current batch `9ef3373b…` holds **test data**. The plan is to let it die, not to save it.

| # | Item | Issue |
|---|---|---|
| 4 | Fresh **production postage batch** (real depth + TTL, not test values) — **Fable** (irreversible, data-loss surface) | #45 |
| 5 | ~~Fresh production events directory feed~~ → folded into the #37 rebuild (pointer cutover filters test events) | #37 |
| 6 | **TTL monitoring + auto-topup/dilute** so no batch ever silently expires again — **Opus** (bee-js 12.3.1 bump rides along), **Fable reviews** | #45 |
| 7 | Stripe purchase gate for user batches (retire `FREE_HOSTING`) — **verification gate + per-owner quota + storage ledger MERGED + DEPLOYED** (PR #52 `74a3872`, server live 2026-07-16): free hosting requires `charges_enabled` (same check as paid events); `.data/storage-ledger.json` logs every deploy's bytes per owner (= quota meter + future migration manifest). **2026-07-15:** quota → **100MB, latest-per-site** (republish supersedes — quota never punishes iteration; superseded refs stay in the ledger = the GC/migration walk set); site images metered through the same gate (`site-image` kind — deploy quota was walkable-around via /upload-image); builder now REACTS to server codes (purchase modal on 402, Stripe modal on 403) instead of pre-gating. Decisions locked: launch with free hosting ON, **no promo-code machinery** (env flag is the whole feature), frame as limited-time launch offer. Remaining: batch-purchase checkout with REAL TTLs (every test purchase used ttlDays=1.1 — all 7 user batches are dead), renewal/topup UI, then `FREE_HOSTING=false` | #44 |
| 7b | **Etherna platform batch `87cc2df1…` TTL ≈ 4 days** (measured 2026-07-15, `batchTTL:352996`, mutable) — top up before 2026-07-19 or every free-hosted site dies | #45 |

> Ordering matters: re-route (1) and cut over (4,5) **before** the old batch expires — you can only
> re-stamp what you can still read. In testing this is slack; at launch it is a hard deadline.

## Launch blockers — money + correctness

| # | Item | Issue |
|---|---|---|
| ~~8~~ | ~~Event directory does not scale~~ ✅ resolved — #37 snapshot deployed 2026-07-17 | #37 |
| ~~—~~ | ~~Publish is not resumable — a failed register forks a second event~~ | ✅ #36 |

**#41 is no longer a launch blocker.** Crypto is not surfaced for launch, and PR #51 makes that
true *in code* rather than as a side effect of the directory cutover. The rail is not deleted —
it is off behind `FEATURES.cryptoPaymentsAllowed`, one line from coming back.

Two things must be true before crypto (or the agent rail) is promoted again:
- Claims must mint on-chain, not Swarm-only, or a paying buyer gets a weaker ticket than a Stripe buyer.
- **#41 must cover the agent rail too** (`/api/agent/buy` settles USDC on-chain then mints via
  `claimTicket()` — same defect). Fixing only the consumer rail leaves the agent one broken.

## Bugs from testing round 1

| # | Item | Issue |
|---|---|---|
| 10 | Door scanner: re-pushed roster not picked up on refresh — **fix shipped, unverified** | #33 |
| 11 | Referral link UX — silent capture needs visible feedback — **Sonnet** (UI only) | #34 |
| 12 | Creator dashboard shows the same event twice — **not a bug**: two real events from a retried publish. Root cause (#30, #36) is fixed; close after a clean publish run confirms it | #32 |
| ~~—~~ | ~~Dashboard 404s on unlisted client-signed events~~ | ✅ #14 |

## Hygiene

| # | Item | Issue |
|---|---|---|
| 15 | Node 24 bump on the VM (**Node 20 is EOL**) — **Sonnet** (ops, runbook exists) | #9 |
| 16 | `svelte-check` green + in CI — **Sonnet** (mechanical) | #11 |
| 17 | dist-multisite purge on the VM (20MB → 8.4MB) — **Sonnet** (ops) | #47 |
| 18 | bee-js `11.1.0 → 12.3.1` — fold into #45 (it fixes `extendStorage` no-op, `calculateTopUpForBzz`, adds `minimumValidityBlocks`) — **Opus**, Fable reviews the feed-write surface | — |
| 19 | bee node `2.8.0 → 2.8.1` — crash-safe chunk store. Insurance, not urgent (0 restarts in 47d) | — |

## SEO + custom domains — plan locked 2026-07-26

Full decisions, verified current state and guidance copy: **`docs/SEO_PLAN.md`**. Read it
before touching any of these — several tempting "fixes" are wrong (e.g. sub-ENS must stay on
profiles and event pages; the custom-domain worker must proxy, never redirect).

| # | Item | Owner | State |
|---|---|---|---|
| 1 | **Edge proxy (Cloudflare Worker)** — `packages/edge-proxy/` was planned in `docs/CUSTOM_DOMAINS_PLAN.md` and **never built**. Blocks the whole DNS-first strategy. Server half (registry, public `/api/domains/resolve/:hostname`, poller, `DomainLinker`) already exists | Opus | #67 — not started |
| 2 | **One CNAME path** — drop the 7-day-trial / NS-migration funnel. Cloudflare for SaaS is 100 hostnames free then $0.10/mo; the funnel dodges a cost that doesn't exist | Sonnet | #68 |
| 3 | **Drop sub-ENS from the website builder** — keep it on profiles (identity/EAS) and event pages (USP) | Sonnet | #69 |
| 4 | **Deploy-time `<title>` + canonical** — sites currently ship `<title>Site</title>`; nothing emits canonical anywhere | Sonnet | #70 |
| 5 | **schema.org/Event JSON-LD** — highest value-per-effort, independent of the worker | Sonnet | #55 |
| 6 | **Real per-page URLs** (static pre-render) — hash routing makes an N-page site ONE indexable URL. Largest piece | Opus | #71 |
| 7 | **SEO guidance panel** in builder — live checks + wires up the orphaned `Page.metaDescription` | Sonnet | #72 |
| 8 | **sitemap.xml + robots.txt** at deploy | Sonnet | #73 |

Address ladder: organiser's own DNS (recommended) → organiser's own ENS → WoCo-issued ENS
equivalent (future). **No WoCo-issued free subdomain tier** — rejected, see SEO_PLAN D2.

## Deferred / v2

#43 shop config · #12 referral payout · #13 resale + Stripe recipient rail ·
#28 ECIES golden vectors · #31 ZeroDev gas workaround · #8 browser-verify #1–#4

**Event-page SEO from #37 discovery fields (Sonnet, frontend-only) — now issue #55, folded
into `docs/SEO_PLAN.md` item 5** — `EventTag`
(genre) and `EventGeo` (lat/lng/address/city/country) are already the right shape
for real SEO/rich-results: today nothing emits them. `schema.org`/`ld+json` only
exists server-side today as an *import* parser (reading other sites' Event markup
to prefill a new WoCo event) — WoCo's own event pages and site-builder
`FeaturedEventSection`/`EventsGridSection` emit no structured data. Scope: inject
a `application/ld+json` `Event` block (name/dates/`location: {Place, address,
geo}`/`keywords` from tags) + `<meta name="description">` on the event detail
page, mirroring how `siteDescription` is already injected at multisite deploy
time. Not started.
